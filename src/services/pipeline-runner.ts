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

    // 2. Digitize document (Sarvam AI OCR with local fallback)
    const pages = await digitizeDocument(buffer, job.fileName, job.mimeType, job.sarvamApiKey);
    console.log(\`[Upstash Box] Extracted \${pages.length} page(s)\`);

    // 3. Chunk pages
    const chunks = chunkPages(pages, 400, 50);
    console.log(\`[Upstash Box] Generated \${chunks.length} chunk(s)\`);

    // 4. Upsert vectors to Upstash Vector
    if (chunks.length > 0) {
      console.log("[Upstash Box] Upserting chunks to Upstash Vector...");
      const vectorPayloads = chunks.map((chunk) => ({
        id: \`\${job.documentId}:\${chunk.chunkIndex}\`,
        data: chunk.text,
        metadata: {
          userId: job.userId,
          projectId: job.projectId,
          docId: job.documentId,
          docName: job.fileName,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          chunkIndex: chunk.chunkIndex,
        },
      }));

      const batchSize = 50;
      for (let i = 0; i < vectorPayloads.length; i += batchSize) {
        const batch = vectorPayloads.slice(i, i + batchSize);
        await upsertVectorBatch(batch, job.vectorRestUrl, job.vectorRestToken);
      }
      console.log(\`[Upstash Box] Indexed \${vectorPayloads.length} vectors successfully\`);
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
  const pageIndex = 1;
  const extractedPieces = [];

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
      extractedPieces.push(textPieces.join(" "));
    }
  }

  if (extractedPieces.length > 0) {
    const fullText = extractedPieces.join("\\n\\n");
    pages.push({ pageNumber: pageIndex, text: fullText });
  } else {
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

function chunkPages(pages, targetTokens = 400, overlapTokens = 50) {
  const chunks = [];
  if (pages.length === 0) return chunks;

  const wordsWithPage = [];
  for (const page of pages) {
    const words = page.text.trim().split(/\\s+/).filter(Boolean);
    for (const word of words) {
      wordsWithPage.push({ word, page: page.pageNumber });
    }
  }

  if (wordsWithPage.length === 0) return chunks;

  const targetWords = Math.max(50, Math.floor(targetTokens * 0.75));
  const overlapWords = Math.max(0, Math.floor(overlapTokens * 0.75));
  const step = Math.max(1, targetWords - overlapWords);

  let chunkIndex = 0;
  for (let i = 0; i < wordsWithPage.length; i += step) {
    const slice = wordsWithPage.slice(i, i + targetWords);
    if (slice.length === 0) break;

    const chunkText = slice.map((item) => item.word).join(" ");
    const pageStart = slice[0]?.page ?? 1;
    const pageEnd = slice[slice.length - 1]?.page ?? pageStart;

    chunks.push({
      chunkIndex,
      text: chunkText,
      pageStart,
      pageEnd,
    });
    chunkIndex++;

    if (i + targetWords >= wordsWithPage.length) break;
  }

  return chunks;
}

async function upsertVectorBatch(batch, vectorRestUrl, vectorRestToken, maxRetries = 3) {
  let attempt = 0;
  const endpoint = \`\${vectorRestUrl.replace(/\\/$/, "")}/upsert\`;

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
      if (attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
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
              { type: "text", value: status },
              { type: "integer", value: chunkCount },
              { type: "text", value: documentId },
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
