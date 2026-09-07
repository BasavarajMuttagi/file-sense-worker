import { Box } from "@upstash/box";
import { eq } from "drizzle-orm";

import { documents, getDb } from "../db/index.js";
import { PIPELINE_RUNNER_SCRIPT } from "./pipeline-runner.js";
import { getStoragePresignedDownloadUrl } from "./storage.js";

export interface DocumentProcessingJob {
  documentId: string;
  storagePath: string;
  userId: string;
  projectId: string;
  fileName: string;
  mimeType: string;
}

const DEFAULT_BOX_NAME = "filesense-pipeline";

/**
 * Gets an existing Upstash Box or provisions a new one.
 */
export async function getOrCreateProcessingBox(env: Env): Promise<Box | null> {
  const apiKey = env.UPSTASH_BOX_API_KEY;
  if (!apiKey) {
    return null;
  }

  const boxName = DEFAULT_BOX_NAME;

  let box: Box | null = null;
  try {
    box = await Box.getByName(boxName, { apiKey });
  } catch {
    // Box doesn't exist yet
  }

  if (!box) {
    try {
      box = await Box.create({
        name: boxName,
        runtime: "node",
        size: "small",
        apiKey,
      });
    } catch (createErr) {
      console.error("[Upstash Box] Failed to create box:", createErr);
      return null;
    }
  }

  // Ensure SDK dependencies are installed in this box
  try {
    const check = await box.exec.command("node -e 'import(\"sarvamai\")'");
    if (check.exitCode !== 0) {
      console.log("[Upstash Box] Dependencies not found in box. Writing package.json and running npm install...");
      await box.files.write({
        path: "package.json",
        content: JSON.stringify(
          {
            name: "filesense-box-runner",
            type: "module",
            dependencies: {
              sarvamai: "^1.1.9",
              "@mistralai/mistralai": "^2.6.4",
              "@upstash/vector": "^1.2.3",
              "@libsql/client": "^0.18.0",
              "pdf-parse": "^1.1.4",
            },
          },
          null,
          2,
        ),
      });
      const installRes = await box.exec.command("npm install");
      console.log(`[Upstash Box] npm install finished with code ${installRes.exitCode}`);
    }
  } catch (checkErr) {
    console.warn("[Upstash Box] Dependency check warning:", checkErr);
  }

  return box;
}

/**
 * Dispatches a document to Upstash Box for downloading, OCR, chunking, and vector indexing.
 */
export async function dispatchDocumentProcessing(
  env: Env,
  job: DocumentProcessingJob,
): Promise<void> {
  const db = getDb(env);

  if (!env.UPSTASH_BOX_API_KEY) {
    console.warn(
      "[Upstash Box] UPSTASH_BOX_API_KEY is not configured. Document will remain in 'created' state.",
    );
    return;
  }

  try {
    // 1. Generate presigned download URL for the uploaded document
    const downloadUrl = await getStoragePresignedDownloadUrl(
      job.storagePath,
      env,
      3600,
    );

    if (!downloadUrl) {
      throw new Error(
        `Failed to generate presigned download URL for storage key: ${job.storagePath}`,
      );
    }

    // 2. Connect to / create the Upstash Box instance
    const box = await getOrCreateProcessingBox(env);
    if (!box) {
      throw new Error("Unable to obtain Upstash Box instance");
    }

    // 3. Ensure pipeline-runner.mjs is present in the box
    await box.files.write({
      path: "pipeline-runner.mjs",
      content: PIPELINE_RUNNER_SCRIPT,
    });

    // 4. Prepare and write job specification to box
    const jobFileName = `job-${job.documentId}.json`;
    const payload = {
      documentId: job.documentId,
      downloadUrl,
      userId: job.userId,
      projectId: job.projectId,
      fileName: job.fileName,
      mimeType: job.mimeType,
      sarvamApiKey: env.SARVAM_API_KEY,
      mistralApiKey: env.MISTRAL_API_KEY,
      vectorRestUrl: env.UPSTASH_VECTOR_REST_URL,
      vectorRestToken: env.UPSTASH_VECTOR_REST_TOKEN,
      databaseUrl: env.DATABASE_URL,
      databaseToken: env.TOKEN,
    };

    await box.files.write({
      path: jobFileName,
      content: JSON.stringify(payload),
    });

    console.log(`[Upstash Box] Dispatched job ${job.documentId} to box ${box.id}`);

    // 5. Execute runner script inside Box
    const run = await box.exec.command(`node pipeline-runner.mjs ${jobFileName}`);

    console.log(
      `[Upstash Box] Run finished with exitCode ${run.exitCode}. Output:\n${run.stdout}`,
    );

    if (run.exitCode !== 0) {
      console.error(`[Upstash Box] Run failed with stderr:\n${run.stderr}`);
      await db
        .update(documents)
        .set({ status: "error" })
        .where(eq(documents.id, job.documentId));
    }

    // 6. Clean up temporary job file
    await box.files.remove(jobFileName).catch(() => { });
  } catch (err: unknown) {
    console.error(`[Upstash Box] Processing failed for doc ${job.documentId}:`, err);
    try {
      await db
        .update(documents)
        .set({ status: "error" })
        .where(eq(documents.id, job.documentId));
    } catch (dbErr) {
      console.error("Failed to update document status to error:", dbErr);
    }
  }
}
