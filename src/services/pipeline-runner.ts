/**
 * Self-contained Node.js script executed inside an Upstash Box.
 * Zero external npm dependencies — uses Node 18+ built-ins:
 * global fetch, FormData, Blob, Buffer, and node:zlib.
 */
export const PIPELINE_RUNNER_SCRIPT = `import zlib from "node:zlib";
import fs from "node:fs/promises";

async function main() {
  const jobArg = process.argv[2];
  let job;

  if (jobArg && jobArg.startsWith("{")) {
    job = JSON.parse(jobArg);
  } else if (jobArg) {
    const raw = await fs.readFile(jobArg, "utf-8");
    job = JSON.parse(raw);
  } else {
    const raw = await fs.readFile("job.json", "utf-8");
    job = JSON.parse(raw);
  }

  console.log(\`[Upstash Box] Starting pipeline for doc: \${job.documentId} (\${job.fileName})\`);

  try {
    // 1. Download file from Tigris presigned URL
    console.log("[Upstash Box] Downloading file from Tigris...");
    const downloadRes = await fetch(job.downloadUrl);
    if (!downloadRes.ok) {
      throw new Error(\`Failed to download file from Tigris (\${downloadRes.status}): \${await downloadRes.text()}\`);
    }
    const arrayBuffer = await downloadRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(\`[Upstash Box] Download complete (\${buffer.length} bytes)\`);

    // Validation: File size check < 50MB
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(\`Document exceeds maximum size limit of 50MB (\${(buffer.length / (1024 * 1024)).toFixed(1)}MB)\`);
    }

    // 2. Digitize document (Sarvam AI OCR with local fallback)
    const pages = await digitizeDocument(buffer, job.fileName, job.mimeType, job.sarvamApiKey);
    console.log(\`[Upstash Box] Extracted \${pages.length} page(s)\`);

    // Validation: Extracted text length & non-printable character ratio
    const totalExtractedLength = pages.reduce((acc, p) => acc + (p.text?.length || 0), 0);
    if (totalExtractedLength < 100) {
      console.warn(\`[Upstash Box] Warning: Extracted text length is very low (\${totalExtractedLength} chars). Document may be image-only, empty, or corrupt.\`);
    }
    const combinedText = pages.map((p) => p.text || "").join(" ");
    if (combinedText.length > 0) {
      const nonPrintable = (combinedText.match(/[^\x20-\x7E\t\n\r]/g) || []).length;
      const nonPrintableRatio = nonPrintable / combinedText.length;
      if (nonPrintableRatio > 0.3) {
        console.warn(\`[Upstash Box] Warning: High non-printable character ratio (\${(nonPrintableRatio * 100).toFixed(1)}%). Text may be garbled.\`);
      }
    }

    // 3. Chunk pages (Page-bounded semantic chunking with 25% backward overlap)
    const chunks = chunkPages(pages);
    console.log(\`[Upstash Box] Generated \${chunks.length} semantic chunk(s) across \${pages.length} page(s)\`);

    // 4. Batch upsert vectors to Upstash Vector with deterministic IDs
    if (chunks.length > 0) {
      console.log("[Upstash Box] Upserting chunks to Upstash Vector in batch...");
      const uploadedAt = new Date().toISOString();
      const vectorPayloads = chunks.map((chunk) => ({
        id: \`\${job.documentId}#page\${chunk.page}#chunk\${chunk.chunkIndex}\`,
        data: chunk.text,
        metadata: {
          userId: job.userId,
          projectId: job.projectId,
          docId: job.documentId,
          docName: job.fileName,
          page: chunk.page,
          pageStart: chunk.page,
          pageEnd: chunk.page,
          chunkIndex: chunk.chunkIndex,
          isFirstChunkOfPage: chunk.isFirstChunkOfPage,
          isLastChunkOfPage: chunk.isLastChunkOfPage,
          isOverlapped: chunk.isOverlapped,
          uploadedAt,
        },
      }));

      const batchSize = 50;
      for (let i = 0; i < vectorPayloads.length; i += batchSize) {
        const batch = vectorPayloads.slice(i, i + batchSize);
        await upsertVectorBatch(batch, job.vectorRestUrl, job.vectorRestToken, 3, job.documentId, job.userId);
      }
      console.log(\`[Upstash Box] Indexed \${vectorPayloads.length} vectors successfully with deterministic IDs\`);
    }

    // 5. Update Turso document status to "processed"
    await updateTursoStatus(
      job.databaseUrl,
      job.databaseToken,
      job.documentId,
      "processed",
      chunks.length
    );
    console.log(\`[Upstash Box] Document \${job.documentId} marked as processed\`);
  } catch (err) {
    console.error("[Upstash Box] Pipeline failed:", err);
    try {
      await updateTursoStatus(
        job.databaseUrl,
        job.databaseToken,
        job.documentId,
        "error",
        0
      );
    } catch (dbErr) {
      console.error("[Upstash Box] Failed to set error status in DB:", dbErr);
    }
    process.exit(1);
  }
}

async function digitizeDocument(buffer, fileName, mimeType, sarvamApiKey) {
  if (sarvamApiKey) {
    try {
      console.log("[Upstash Box] Attempting Sarvam AI Doc AI OCR...");
      const sarvamPages = await callSarvamDigitize(buffer, fileName, sarvamApiKey);
      if (sarvamPages.length > 0) {
        return sarvamPages;
      }
    } catch (err) {
      console.warn("[Upstash Box] Sarvam AI OCR failed, falling back to local extractor:", err.message);
    }
  }

  console.log("[Upstash Box] Running local text extraction...");
  return extractTextLocally(buffer, mimeType);
}

async function callSarvamDigitize(buffer, fileName, apiKey) {
  const formData = new FormData();
  const blob = new Blob([buffer]);
  formData.append("file", blob, fileName);
  formData.append("output_format", "json");

  const startRes = await fetch("https://api.sarvam.ai/doc-ai/v1/job/digitise", {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
    },
    body: formData,
  });

  if (!startRes.ok) {
    throw new Error(\`Sarvam job creation failed (\${startRes.status}): \${await startRes.text()}\`);
  }

  const startData = await startRes.json();
  const jobId = startData.job_id;
  if (!jobId) {
    throw new Error("No job_id returned by Sarvam API");
  }

  let attempts = 0;
  const maxAttempts = 45;
  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    attempts++;

    const statusRes = await fetch(\`https://api.sarvam.ai/doc-ai/v1/job/\${jobId}/status\`, {
      headers: { "api-subscription-key": apiKey },
    });

    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    if (statusData.status === "completed" || statusData.status === "partially_completed") {
      break;
    }
    if (statusData.status === "failed" || statusData.status === "rejected") {
      throw new Error(\`Sarvam digitize terminated with status: \${statusData.status}\`);
    }
  }

  const resultsRes = await fetch(\`https://api.sarvam.ai/doc-ai/v1/job/\${jobId}/results\`, {
    headers: { "api-subscription-key": apiKey },
  });

  if (!resultsRes.ok) {
    throw new Error(\`Failed to fetch Sarvam results (\${resultsRes.status})\`);
  }

  const resultsData = await resultsRes.json();
  const rawPages = resultsData.pages ?? resultsData.output?.pages ?? [];
  const parsedPages = [];

  for (let i = 0; i < rawPages.length; i++) {
    const p = rawPages[i];
    const pageNum = p.page_number ?? i + 1;
    let pageText = p.text ?? "";

    if (!pageText && p.blocks) {
      pageText = p.blocks.map((b) => b.text ?? "").join("\\n");
    }

    if (pageText.trim()) {
      parsedPages.push({ pageNumber: pageNum, text: pageText.trim() });
    }
  }

  return parsedPages;
}

function extractTextLocally(buffer, mimeType) {
  if (mimeType.includes("text") || mimeType.includes("json")) {
    const text = buffer.toString("utf-8");
    return [{ pageNumber: 1, text }];
  }

  const pages = [];
  const content = buffer.toString("binary");

  const streamRegex = /stream[\\r\\n]+([\\s\\S]*?)[\\r\\n]+endstream/g;
  let match = null;
  let streamCount = 0;

  while ((match = streamRegex.exec(content)) !== null) {
    const rawStream = match[1];
    if (!rawStream) continue;

    let decompressed = null;
    try {
      const streamBuf = Buffer.from(rawStream, "binary");
      decompressed = zlib.inflateSync(streamBuf).toString("utf-8");
    } catch {
      try {
        const streamBuf = Buffer.from(rawStream, "binary");
        decompressed = zlib.inflateRawSync(streamBuf).toString("utf-8");
      } catch {
        decompressed = null;
      }
    }

    const textToScan = decompressed ?? rawStream;
    const textPieces = extractPdfTextTokens(textToScan);
    if (textPieces.length > 0) {
      streamCount++;
      pages.push({ pageNumber: streamCount, text: textPieces.join(" ") });
    }
  }

  if (pages.length === 0) {
    const cleaned = buffer
      .toString("utf-8")
      .replace(/[^\\x20-\\x7E\\n\\r\\t]/g, " ")
      .trim();
    if (cleaned.length > 20) {
      pages.push({ pageNumber: 1, text: cleaned });
    }
  }

  return pages;
}

function extractPdfTextTokens(content) {
  const tokens = [];
  const tjRegex = /\\(([^)]*)\\)\\s*Tj/g;
  let match = null;

  while ((match = tjRegex.exec(content)) !== null) {
    if (match[1]) tokens.push(match[1]);
  }

  const tjArrayRegex = /\\[([^\\]]*)\\]\\s*TJ/g;
  while ((match = tjArrayRegex.exec(content)) !== null) {
    if (match[1]) {
      const innerMatches = match[1].match(/\\(([^)]*)\\)/g);
      if (innerMatches) {
        for (const item of innerMatches) {
          tokens.push(item.slice(1, -1));
        }
      }
    }
  }

  return tokens;
}

function chunkPages(pages) {
  // Target: 450-500 tokens (TOKEN_RATIO = 0.25 -> 1 token ~ 4 chars -> ~1800-2000 chars)
  const TARGET_CHARS = 1850;
  const MIN_CHARS = 200; // 50 tokens
  const MAX_CHARS = 8000; // 2000 tokens
  const OVERLAP_RATIO = 0.25; // 25% backward intra-page overlap

  const allChunks = [];
  if (!pages || pages.length === 0) return allChunks;

  for (const page of pages) {
    const pageNum = page.pageNumber ?? 1;
    const pageText = (page.text || "").trim();
    if (!pageText || pageText.length < 10) continue;

    // Small page (< TARGET_CHARS) kept intact as single chunk
    if (pageText.length <= TARGET_CHARS) {
      allChunks.push({
        page: pageNum,
        chunkIndex: 0,
        text: pageText,
        isFirstChunkOfPage: true,
        isLastChunkOfPage: true,
        isOverlapped: false,
      });
      continue;
    }

    // Split page text into semantic paragraphs (preserving headers with content)
    const rawParagraphs = pageText
      .split(/\\n\\s*\\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    const isHeader = (str) => {
      const t = str.trim();
      if (/^#{1,6}\\s+/.test(t)) return true;
      if (/^[A-Z0-9\\s_\\-]{3,60}:?$/.test(t) && t.length < 60) return true;
      if (/^(section|chapter|part|module)\\s+\\d+/i.test(t)) return true;
      return false;
    };

    const sections = [];
    let currentHeader = "";

    for (const para of rawParagraphs) {
      const lines = para.split("\\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 1 && isHeader(lines[0])) {
        currentHeader = lines[0];
        continue;
      }

      let content = para;
      if (currentHeader && !content.startsWith(currentHeader)) {
        content = currentHeader + "\\n" + content;
      }

      if (lines.length > 0 && isHeader(lines[0])) {
        currentHeader = lines[0];
      }

      sections.push(content);
    }

    const itemsToChunk = sections.length > 0 ? sections : [pageText];

    // Build base non-overlapping blocks bounded by target size
    const baseBlocks = [];
    let currentBlock = "";

    for (const sec of itemsToChunk) {
      if (sec.length > TARGET_CHARS) {
        if (currentBlock.length > 0) {
          baseBlocks.push(currentBlock.trim());
          currentBlock = "";
        }

        const sentences = sec.match(/[^.!?]+[.!?]+(\\s+|$)|[^.!?]+$/g) || [sec];
        let sentenceBlock = "";

        for (const sent of sentences) {
          if (sent.length > TARGET_CHARS) {
            if (sentenceBlock.length > 0) {
              baseBlocks.push(sentenceBlock.trim());
              sentenceBlock = "";
            }
            const words = sent.split(/\\s+/);
            let wordBlock = "";
            for (const w of words) {
              if ((wordBlock + " " + w).length > TARGET_CHARS) {
                if (wordBlock) baseBlocks.push(wordBlock.trim());
                wordBlock = w;
              } else {
                wordBlock = wordBlock ? wordBlock + " " + w : w;
              }
            }
            if (wordBlock) sentenceBlock = wordBlock;
          } else if ((sentenceBlock + " " + sent).length > TARGET_CHARS) {
            if (sentenceBlock) baseBlocks.push(sentenceBlock.trim());
            sentenceBlock = sent;
          } else {
            sentenceBlock = sentenceBlock ? sentenceBlock + " " + sent : sent;
          }
        }
        if (sentenceBlock.length > 0) {
          currentBlock = sentenceBlock;
        }
      } else if ((currentBlock + "\\n\\n" + sec).length > TARGET_CHARS) {
        if (currentBlock.length > 0) {
          baseBlocks.push(currentBlock.trim());
        }
        currentBlock = sec;
      } else {
        currentBlock = currentBlock ? currentBlock + "\\n\\n" + sec : sec;
      }
    }

    if (currentBlock.trim().length > 0) {
      baseBlocks.push(currentBlock.trim());
    }

    // Merge tiny trailing block if < MIN_CHARS (50 tokens)
    if (baseBlocks.length > 1) {
      const lastIdx = baseBlocks.length - 1;
      if (baseBlocks[lastIdx].length < MIN_CHARS) {
        baseBlocks[lastIdx - 1] += "\\n\\n" + baseBlocks[lastIdx];
        baseBlocks.pop();
      }
    }

    // Apply 25% backward intra-page overlap
    for (let i = 0; i < baseBlocks.length; i++) {
      let chunkText = baseBlocks[i];
      let isOverlapped = false;

      if (i > 0) {
        const prevBlock = baseBlocks[i - 1];
        const overlapTargetChars = Math.floor(baseBlocks[i].length * OVERLAP_RATIO);
        if (prevBlock.length > 100 && overlapTargetChars > 50) {
          const tail = prevBlock.slice(-Math.min(prevBlock.length, overlapTargetChars + 150));
          const boundaryMatch = tail.search(/(?<=[.!?\\n])\\s+/);
          const overlapSnippet = boundaryMatch !== -1 ? tail.slice(boundaryMatch).trim() : tail.slice(-overlapTargetChars).trim();
          if (overlapSnippet && !chunkText.includes(overlapSnippet)) {
            chunkText = overlapSnippet + "\\n...\\n" + chunkText;
            isOverlapped = true;
          }
        }
      }

      if (chunkText.length > MAX_CHARS) {
        chunkText = chunkText.slice(0, MAX_CHARS);
      }

      allChunks.push({
        page: pageNum,
        chunkIndex: i,
        text: chunkText,
        isFirstChunkOfPage: i === 0,
        isLastChunkOfPage: i === baseBlocks.length - 1,
        isOverlapped,
      });
    }
  }

  return allChunks;
}

async function upsertVectorBatch(batch, vectorRestUrl, vectorRestToken, maxRetries = 3, docId = "", userId = "") {
  let attempt = 0;
  const endpoint = \`\${vectorRestUrl.replace(/\\/$/, "")}/upsert-data\`;

  while (attempt < maxRetries) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: \`Bearer \${vectorRestToken}\`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        throw new Error(\`Upstash Vector upsert failed (\${res.status}): \${await res.text()}\`);
      }
      return;
    } catch (err) {
      attempt++;
      console.error(\`[Upstash Vector] Upsert attempt \${attempt} failed for docId: \${docId}, userId: \${userId}:\`, err.message);
      if (attempt >= maxRetries) throw err;
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

async function updateTursoStatus(databaseUrl, databaseToken, documentId, status, chunkCount) {
  const baseUrl = databaseUrl.replace(/^libsql:\\/\\//, "https://").replace(/\\/$/, "");
  const pipelineUrl = \`\${baseUrl}/v2/pipeline\`;

  const res = await fetch(pipelineUrl, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${databaseToken}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          type: "execute",
          stmt: {
            sql: "UPDATE documents SET status = ?, chunk_count = ?, updated_at = unixepoch() WHERE id = ?",
            args: [
              { type: "text", value: String(status) },
              { type: "integer", value: String(chunkCount) },
              { type: "text", value: String(documentId) },
            ],
          },
        },
        { type: "close" },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(\`Turso pipeline update failed (\${res.status}): \${await res.text()}\`);
  }
}

main();
`;
