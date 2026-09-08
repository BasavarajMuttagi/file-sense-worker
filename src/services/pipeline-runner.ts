/**
 * Self-contained Node.js script executed inside an Upstash Box.
 * Uses official SDKs installed in the persistent Upstash Box container:
 * - sarvamai (SarvamAIClient for Document AI OCR)
 * - @mistralai/mistralai (Mistral client for embeddings)
 * - @upstash/vector (Index client for vector upsert)
 * - @libsql/client (createClient for Turso DB status updates)
 */
export const PIPELINE_RUNNER_SCRIPT = `import fs from "node:fs/promises";
import nodeFs from "node:fs";
import zlib from "node:zlib";
import pdfParse from "pdf-parse";
import { SarvamAIClient } from "sarvamai";
import { Mistral } from "@mistralai/mistralai";
import { Index } from "@upstash/vector";
import { createClient } from "@libsql/client/web";

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

  const sarvamApiKey = job.sarvamApiKey || process.env.SARVAM_API_KEY;
  const mistralApiKey = job.mistralApiKey || process.env.MISTRAL_API_KEY;
  const vectorRestUrl = job.vectorRestUrl || process.env.UPSTASH_VECTOR_REST_URL;
  const vectorRestToken = job.vectorRestToken || process.env.UPSTASH_VECTOR_REST_TOKEN;
  const databaseUrl = job.databaseUrl || process.env.DATABASE_URL;
  const databaseToken = job.databaseToken || process.env.TOKEN;

  try {
    // 1. Download file from presigned storage URL
    console.log("[Upstash Box] Downloading file from Tigris...");
    const downloadRes = await fetch(job.downloadUrl);
    if (!downloadRes.ok) {
      throw new Error(\`Failed to download file from storage (\${downloadRes.status}): \${await downloadRes.text()}\`);
    }
    const arrayBuffer = await downloadRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(\`[Upstash Box] Download complete (\${buffer.length} bytes)\`);

    // Validation: File size check < 50MB
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(\`Document exceeds maximum size limit of 50MB (\${(buffer.length / (1024 * 1024)).toFixed(1)}MB)\`);
    }

    // 2. Digitize document (Sarvam AI SDK OCR with local extractor fallback)
    const pages = await digitizeDocument(buffer, job.fileName, job.mimeType, sarvamApiKey);
    console.log(\`[Upstash Box] Extracted \${pages.length} page(s)\`);

    // Validation: Extracted text length & non-printable character ratio
    const totalExtractedLength = pages.reduce((acc, p) => acc + (p.text?.length || 0), 0);
    if (totalExtractedLength < 100) {
      console.warn(\`[Upstash Box] Warning: Extracted text length is very low (\${totalExtractedLength} chars). Document may be image-only, empty, or corrupt.\`);
    }
    const combinedText = pages.map((p) => p.text || "").join(" ");
    if (combinedText.length > 0) {
      const nonPrintable = (combinedText.match(/[^\\x20-\\x7E\\t\\n\\r]/g) || []).length;
      const nonPrintableRatio = nonPrintable / combinedText.length;
      if (nonPrintableRatio > 0.3) {
        console.warn(\`[Upstash Box] Warning: High non-printable character ratio (\${(nonPrintableRatio * 100).toFixed(1)}%). Text may be garbled.\`);
      }
    }

    // 3. Chunk pages (Parent-Child Multi-Vector Chunking with docId scoping)
    const chunks = chunkPages(pages, job.documentId);
    console.log(\`[Upstash Box] Generated \${chunks.length} multi-vector chunk(s) across \${pages.length} page(s)\`);

    // 4. Generate Embeddings using official Mistral SDK with retrieval prefixes
    console.log("[Upstash Box] Generating embeddings via Mistral SDK...");
    const embeddedChunks = await generateMistralEmbeddings(chunks, mistralApiKey);
    console.log(\`[Upstash Box] Generated embeddings for \${embeddedChunks.length} chunks\`);

    // 5. Batch upsert vectors using official @upstash/vector SDK
    if (chunks.length > 0) {
      console.log("[Upstash Box] Upserting chunks to Upstash Vector in batch...");
      const uploadedAt = new Date().toISOString();
      const vectorPayloads = chunks.map((chunk) => ({
        id: chunk.id || \`\${job.documentId}#page\${chunk.page}#chunk\${chunk.chunkIndex}\`,
        vector: chunk.vector,
        metadata: {
          userId: job.userId,
          projectId: job.projectId,
          docId: job.documentId,
          docName: job.fileName,
          page: chunk.page,
          pageStart: chunk.page,
          pageEnd: chunk.page,
          chunkIndex: chunk.chunkIndex,
          type: chunk.type,
          parentId: chunk.parentId,
          text: chunk.text,
          isFirstChunkOfPage: chunk.isFirstChunkOfPage,
          isLastChunkOfPage: chunk.isLastChunkOfPage,
          isOverlapped: chunk.isOverlapped,
          uploadedAt,
        },
      }));

      const batchSize = 50;
      for (let i = 0; i < vectorPayloads.length; i += batchSize) {
        const batch = vectorPayloads.slice(i, i + batchSize);
        await upsertVectorBatch(batch, vectorRestUrl, vectorRestToken, 3, job.documentId, job.userId);
      }
      console.log(\`[Upstash Box] Indexed \${vectorPayloads.length} vectors successfully with deterministic IDs\`);
    }

    // 6. Update Turso document status using official LibSQL SDK
    await updateTursoStatus(
      databaseUrl,
      databaseToken,
      job.documentId,
      "processed",
      chunks.length
    );
    console.log(\`[Upstash Box] Document \${job.documentId} marked as processed\`);
  } catch (err) {
    console.error("[Upstash Box] Pipeline failed:", err);
    try {
      await updateTursoStatus(
        databaseUrl,
        databaseToken,
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
      console.log("[Upstash Box] Attempting Sarvam AI Doc AI OCR via SDK...");
      const sarvamPages = await callSarvamDigitize(buffer, fileName, mimeType, sarvamApiKey);
      if (sarvamPages.length > 0) {
        return sarvamPages;
      }
    } catch (err) {
      console.warn("[Upstash Box] Sarvam AI OCR failed, falling back to local extractor:", err.message || err);
    }
  }

  console.log("[Upstash Box] Running local text extraction...");
  return await extractTextLocally(buffer, mimeType);
}

async function callSarvamDigitize(buffer, fileName, mimeType, apiKey) {
  const sarvam = new SarvamAIClient({ apiSubscriptionKey: apiKey });

  const tempPath = "input-" + Date.now() + "-" + fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  await fs.writeFile(tempPath, buffer);
  let jobId;

  try {
    const digitiseRes = await sarvam.docAi.digitise({
      file: [nodeFs.createReadStream(tempPath)],
      output_format: "json",
    });
    jobId = digitiseRes.job_id;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }

  if (!jobId) {
    throw new Error("No job_id returned by Sarvam Doc AI");
  }

  console.log(\`[Upstash Box] Sarvam Doc AI job created: \${jobId}. Polling status...\`);

  let attempts = 0;
  const maxAttempts = 60;
  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    attempts++;

    const statusRes = await sarvam.docAi.getStatus(jobId);
    if (statusRes.status === "completed" || statusRes.status === "partially_completed") {
      break;
    }
    if (statusRes.status === "failed" || statusRes.status === "rejected") {
      throw new Error(\`Sarvam digitize terminated with status: \${statusRes.status}\`);
    }
  }

  const resultsData = await sarvam.docAi.getResults(jobId, { format: "json" });
  console.log(\`[Upstash Box] Sarvam OCR completed for job: \${jobId}\`);

  const rawPages = [];
  if (Array.isArray(resultsData.documents)) {
    for (const doc of resultsData.documents) {
      if (Array.isArray(doc.pages)) {
        rawPages.push(...doc.pages);
      }
    }
  }
  if (rawPages.length === 0 && Array.isArray(resultsData.pages)) {
    rawPages.push(...resultsData.pages);
  }

  const parsedPages = [];
  for (let i = 0; i < rawPages.length; i++) {
    const p = rawPages[i];
    if (!p) continue;
    const pageNum = p.page_num ?? p.page_number ?? i + 1;
    let pageText = (typeof p.text === "string" && p.text.trim()) ? p.text.trim() : "";

    if (!pageText && Array.isArray(p.blocks)) {
      const parts = [];
      for (const b of p.blocks) {
        if (typeof b?.text === "string" && b.text.trim()) {
          parts.push(b.text.trim());
        } else if (typeof b?.content === "string" && b.content.trim()) {
          parts.push(b.content.trim());
        } else if (Array.isArray(b?.lines)) {
          parts.push(b.lines.map((l) => (typeof l === "string" ? l : l?.text || "")).join(" "));
        }
      }
      pageText = parts.filter(Boolean).join("\\n\\n");
    }

    if (pageText.trim()) {
      parsedPages.push({ pageNumber: pageNum, text: pageText.trim() });
    }
  }

  return parsedPages;
}

async function extractTextLocally(buffer, mimeType) {
  if (mimeType.includes("text") || mimeType.includes("json")) {
    const text = buffer.toString("utf-8");
    return [{ pageNumber: 1, text }];
  }

  if (mimeType.includes("pdf") || buffer.slice(0, 5).toString() === "%PDF-") {
    try {
      const parseFunc = typeof pdfParse === "function" ? pdfParse : (pdfParse?.default || pdfParse);
      if (typeof parseFunc === "function") {
        const pages = [];
        await parseFunc(buffer, {
          pagerender: async (pageData) => {
            const textContent = await pageData.getTextContent();
            let lastY, text = "";
            for (const item of textContent.items) {
              if (lastY === item.transform[5] || !lastY) {
                text += item.str;
              } else {
                text += "\\n" + item.str;
              }
              lastY = item.transform[5];
            }
            const trimmed = text.trim();
            if (trimmed) {
              pages.push({
                pageNumber: pageData.pageIndex + 1,
                text: trimmed,
              });
            }
            return text;
          }
        });
        if (pages.length > 0) {
          console.log(\`[Upstash Box] Local PDF extractor parsed \${pages.length} page(s)\`);
          return pages;
        }
      }
    } catch (pdfErr) {
      console.warn("[Upstash Box] pdf-parse failed, falling back to stream extractor:", pdfErr?.message || pdfErr);
    }
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
      const pageText = textPieces.join(" ").trim();
      if (pageText.length > 5) {
        streamCount++;
        pages.push({ pageNumber: streamCount, text: pageText });
      }
    }
  }

  const validPages = pages.filter((p) => (p.text || "").trim().length >= 10);
  if (validPages.length > 0) {
    return validPages;
  }

  const cleaned = buffer
    .toString("utf-8")
    .replace(/[^\\x20-\\x7E\\n\\r\\t]/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
  if (cleaned.length >= 10) {
    return [{ pageNumber: 1, text: cleaned }];
  }

  return [];
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

function normalizePages(pages) {
  const normalized = [];
  const TARGET_PAGE_CHARS = 3000;

  for (const page of pages) {
    const pageText = (page.text || "").trim();
    if (!pageText || pageText.length < 10) continue;

    if (pageText.length > TARGET_PAGE_CHARS * 1.5) {
      // Split large page or full document into virtual pages of ~3000 chars
      for (let offset = 0; offset < pageText.length; offset += TARGET_PAGE_CHARS) {
        const slice = pageText.slice(offset, offset + TARGET_PAGE_CHARS).trim();
        if (slice.length >= 10) {
          normalized.push({
            pageNumber: normalized.length + 1,
            text: slice,
          });
        }
      }
    } else {
      normalized.push({
        pageNumber: page.pageNumber ?? normalized.length + 1,
        text: pageText,
      });
    }
  }

  return normalized;
}

function chunkPages(rawPages, docId = "") {
  const TARGET_CHARS = 1850;
  const MIN_CHARS = 200;
  const MAX_CHARS = 6000; // Enforce strict bound well under Mistral 8192 token limit
  const OVERLAP_RATIO = 0.25;

  const pages = normalizePages(rawPages);
  const allChunks = [];
  if (!pages || pages.length === 0) return allChunks;

  for (const page of pages) {
    const pageNum = page.pageNumber ?? 1;
    const pageText = (page.text || "").trim();
    if (!pageText || pageText.length < 10) continue;

    // Small page (< TARGET_CHARS) kept intact as single parent chunk
    if (pageText.length <= TARGET_CHARS) {
      allChunks.push({
        id: (docId ? docId + "#" : "") + "page" + pageNum + "#chunk0",
        type: "parent",
        parentId: null,
        page: pageNum,
        chunkIndex: 0,
        text: pageText,
        isFirstChunkOfPage: true,
        isLastChunkOfPage: true,
        isOverlapped: false,
      });
      continue;
    }

    // Embed the full page (capped to safe limit) as a Parent chunk
    const parentId = (docId ? docId + "#" : "") + "parent-page-" + pageNum;
    allChunks.push({
      id: parentId,
      type: "parent",
      parentId: null,
      page: pageNum,
      chunkIndex: -1,
      text: pageText.slice(0, 4000),
      isFirstChunkOfPage: true,
      isLastChunkOfPage: true,
      isOverlapped: false,
    });

    // Split page text into semantic paragraphs
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
      const firstLine = lines[0];
      if (lines.length === 1 && firstLine && isHeader(firstLine)) {
        currentHeader = firstLine;
        continue;
      }

      let content = para;
      if (currentHeader && !content.startsWith(currentHeader)) {
        content = currentHeader + "\\n" + content;
      }

      if (lines.length > 0 && firstLine && isHeader(firstLine)) {
        currentHeader = firstLine;
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

    // Merge tiny trailing block if < MIN_CHARS
    if (baseBlocks.length > 1) {
      const lastIdx = baseBlocks.length - 1;
      const lastBlock = baseBlocks[lastIdx];
      const prevBlock = baseBlocks[lastIdx - 1];
      if (lastBlock && prevBlock && lastBlock.length < MIN_CHARS) {
        baseBlocks[lastIdx - 1] = prevBlock + "\\n\\n" + lastBlock;
        baseBlocks.pop();
      }
    }

    // Apply 25% backward intra-page overlap
    for (let i = 0; i < baseBlocks.length; i++) {
      let chunkText = baseBlocks[i] || "";
      let isOverlapped = false;

      if (i > 0) {
        const prevBlock = baseBlocks[i - 1];
        if (prevBlock) {
          const overlapTargetChars = Math.floor(chunkText.length * OVERLAP_RATIO);
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
      }

      if (chunkText.length > MAX_CHARS) {
        chunkText = chunkText.slice(0, MAX_CHARS);
      }

      allChunks.push({
        type: "child",
        parentId,
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

async function generateMistralEmbeddings(chunks, apiKey) {
  if (!apiKey) throw new Error("Missing MISTRAL_API_KEY for embedding generation");

  const mistral = new Mistral({ apiKey });
  const BATCH_SIZE = 50;
  const embeddedChunks = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((c) => \`search_document: \${c.text.slice(0, 6000)}\`);

    const res = await mistral.embeddings.create({
      model: "mistral-embed",
      inputs,
    });

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      if (!chunk) continue;
      const vec = res.data?.[j]?.embedding;
      if (!vec || !Array.isArray(vec)) {
        throw new Error(\`Mistral SDK did not return valid embedding for chunk \${j}\`);
      }
      chunk.vector = vec;
      embeddedChunks.push(chunk);
    }
  }

  return embeddedChunks;
}

async function upsertVectorBatch(batch, vectorRestUrl, vectorRestToken, maxRetries = 3, docId = "", userId = "") {
  const index = new Index({
    url: vectorRestUrl,
    token: vectorRestToken,
  });

  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await index.upsert(batch);
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.toLowerCase().includes("dimension")) {
        console.warn("[Upstash Vector] Dimension mismatch during upsert, falling back to built-in data upsert:", msg);
        const dataBatch = batch.map((item) => ({
          id: item.id,
          data: item.metadata?.text || "",
          metadata: item.metadata,
        }));
        await index.upsert(dataBatch);
        return;
      }
      attempt++;
      console.error(\`[Upstash Vector] Upsert attempt \${attempt} failed for docId: \${docId}, userId: \${userId}:\`, msg);
      if (attempt >= maxRetries) throw err;
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

async function updateTursoStatus(databaseUrl, databaseToken, documentId, status, chunkCount) {
  const client = createClient({
    url: databaseUrl,
    authToken: databaseToken,
  });

  await client.execute({
    sql: "UPDATE documents SET status = ?, chunk_count = ?, updated_at = unixepoch() WHERE id = ?",
    args: [status, chunkCount, documentId],
  });
}

main().catch((err) => {
  console.error("[Upstash Box] Uncaught error in main:", err);
  process.exit(1);
});
`;
