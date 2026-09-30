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
import { SarvamAIClient } from "sarvamai";
import { Index } from "@upstash/vector";
import { createClient } from "@libsql/client/web";

async function main() {
  const documentId = process.env.DOCUMENT_ID;
  const downloadUrl = process.env.DOWNLOAD_URL;
  const userId = process.env.USER_ID || "";
  const projectId = process.env.PROJECT_ID || "";
  const fileName = process.env.FILE_NAME || "document";
  const mimeType = process.env.MIME_TYPE || "application/octet-stream";

  const sarvamApiKey = process.env.SARVAM_API_KEY;
  const vectorRestUrl = process.env.UPSTASH_VECTOR_REST_URL;
  const vectorRestToken = process.env.UPSTASH_VECTOR_REST_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;
  const databaseToken = process.env.DATABASE_TOKEN || process.env.TOKEN;

  if (!documentId || !downloadUrl) {
    throw new Error("Missing required DOCUMENT_ID or DOWNLOAD_URL in environment");
  }

  try {
    // 1. Download file from presigned storage URL
    console.log("[Upstash Box] Downloading file from Tigris...");
    const downloadRes = await fetch(downloadUrl);
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

    // 2. Digitize document with Sarvam AI Doc AI OCR
    const pages = await digitizeDocument(buffer, fileName, mimeType, sarvamApiKey);
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

    // 3. Chunk pages (Semantic document chunking with docId scoping)
    const chunks = chunkPages(pages, documentId);
    console.log(\`[Upstash Box] Generated \${chunks.length} chunk(s) across \${pages.length} page(s)\`);

    // 4. Batch upsert vectors using official @upstash/vector SDK with automatic Hybrid (Dense + BM25) embedding
    if (chunks.length > 0) {
      console.log("[Upstash Box] Upserting chunks to Upstash Vector in batch (Hybrid Dense + BM25)...");
      const uploadedAt = new Date().toISOString();
      const vectorPayloads = chunks.map((chunk) => ({
        id: chunk.id || \`\${documentId}#page\${chunk.page}#chunk\${chunk.chunkIndex}\`,
        data: chunk.text,
        metadata: {
          userId,
          projectId,
          docId: documentId,
          docName: fileName,
          page: chunk.page,
          pageStart: chunk.page,
          pageEnd: chunk.page,
          chunkIndex: chunk.chunkIndex,
          type: chunk.type || "content",
          text: chunk.text,
          isFirstChunkOfPage: chunk.isFirstChunkOfPage,
          isLastChunkOfPage: chunk.isLastChunkOfPage,
          isOverlapped: chunk.isOverlapped,
          uploadedAt,
        },
      }));

      const index = new Index({
        url: vectorRestUrl,
        token: vectorRestToken,
      });

      const batchSize = 50;
      for (let i = 0; i < vectorPayloads.length; i += batchSize) {
        const batch = vectorPayloads.slice(i, i + batchSize);
        await index.upsert(batch);
      }
      console.log(\`[Upstash Box] Indexed \${vectorPayloads.length} vectors successfully with deterministic IDs\`);
    }

    // 5. Update Turso document status using official LibSQL SDK
    await updateTursoStatus(
      databaseUrl,
      databaseToken,
      documentId,
      "processed",
      chunks.length
    );
    console.log(\`[Upstash Box] Document \${documentId} marked as processed\`);
  } catch (err) {
    console.error("[Upstash Box] Pipeline failed:", err);
    try {
      await updateTursoStatus(
        databaseUrl,
        databaseToken,
        documentId,
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
  if (!sarvamApiKey) {
    throw new Error("SARVAM_API_KEY is required for document digitization");
  }

  console.log("[Upstash Box] Digitizing document with Sarvam Doc AI OCR...");
  return await callSarvamDigitize(buffer, fileName, mimeType, sarvamApiKey);
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

  if (parsedPages.length === 0) {
    throw new Error("Sarvam Doc AI returned zero readable pages");
  }

  return parsedPages;
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

    // Small page (< TARGET_CHARS) kept intact as single chunk
    if (pageText.length <= TARGET_CHARS) {
      allChunks.push({
        id: (docId ? docId + "#" : "") + "page" + pageNum + "#chunk0",
        type: "content",
        page: pageNum,
        chunkIndex: 0,
        text: pageText,
        isFirstChunkOfPage: true,
        isLastChunkOfPage: true,
        isOverlapped: false,
      });
      continue;
    }

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
        id: (docId ? docId + "#" : "") + "page" + pageNum + "#chunk" + i,
        type: "content",
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
