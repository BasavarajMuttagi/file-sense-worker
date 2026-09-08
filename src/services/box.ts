import { EphemeralBox } from "@upstash/box";
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

/**
 * Dispatches a document to an isolated EphemeralBox for downloading, OCR, chunking, and vector indexing.
 * API keys and database credentials are injected securely via process.env into the container.
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

  let box: EphemeralBox | null = null;

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

    // 2. Create an isolated EphemeralBox with credentials injected into environment variables
    box = await EphemeralBox.create({
      runtime: "node",
      size: "small",
      ttl: 600, // 10 minutes auto-delete guarantee
      apiKey: env.UPSTASH_BOX_API_KEY,
      env: {
        SARVAM_API_KEY: env.SARVAM_API_KEY ?? "",
        MISTRAL_API_KEY: env.MISTRAL_API_KEY ?? "",
        UPSTASH_VECTOR_REST_URL: env.UPSTASH_VECTOR_REST_URL ?? "",
        UPSTASH_VECTOR_REST_TOKEN: env.UPSTASH_VECTOR_REST_TOKEN ?? "",
        DATABASE_URL: env.DATABASE_URL ?? "",
        TOKEN: env.TOKEN ?? "",
      },
    });

    console.log(`[EphemeralBox] Provisioned box ${box.id} for doc ${job.documentId}`);

    // 3. Write package.json and install SDK dependencies
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

    const installRes = await box.exec.command("npm install --no-audit --no-fund");
    if (installRes.exitCode !== 0) {
      throw new Error(`npm install failed with code ${installRes.exitCode}: ${installRes.stderr}`);
    }

    // 4. Write runner script
    await box.files.write({
      path: "pipeline-runner.mjs",
      content: PIPELINE_RUNNER_SCRIPT,
    });

    // 5. Write only non-sensitive job parameters (no secrets on disk!)
    const jobFileName = `job-${job.documentId}.json`;
    const payload = {
      documentId: job.documentId,
      downloadUrl,
      userId: job.userId,
      projectId: job.projectId,
      fileName: job.fileName,
      mimeType: job.mimeType,
    };

    await box.files.write({
      path: jobFileName,
      content: JSON.stringify(payload),
    });

    console.log(`[EphemeralBox] Running pipeline for job ${job.documentId}...`);

    // 6. Execute runner script inside the EphemeralBox
    const run = await box.exec.command(`node pipeline-runner.mjs ${jobFileName}`);

    console.log(
      `[EphemeralBox] Run finished with exitCode ${run.exitCode}. Output:\n${run.stdout}`,
    );

    if (run.exitCode !== 0) {
      console.error(`[EphemeralBox] Run failed with stderr:\n${run.stderr}`);
      await db
        .update(documents)
        .set({ status: "error" })
        .where(eq(documents.id, job.documentId));
    } else {
      console.log(`[EphemeralBox] Successfully processed document ${job.documentId}`);
    }
  } catch (err: unknown) {
    console.error(`[EphemeralBox] Processing failed for doc ${job.documentId}:`, err);
    try {
      await db
        .update(documents)
        .set({ status: "error" })
        .where(eq(documents.id, job.documentId));
    } catch (dbErr) {
      console.error("Failed to update document status to error:", dbErr);
    }
  } finally {
    // 7. Explicit cleanup: Delete the ephemeral box immediately upon finish
    if (box) {
      await box.delete().catch(() => {});
    }
  }
}
