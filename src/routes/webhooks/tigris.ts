import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import { documents, getDb, projects } from "../../db/index.js";
import { dispatchDocumentProcessing } from "../../services/box.js";
import { removeStorageObject } from "../../services/storage.js";
import { getVectorIndex } from "../../services/vector.js";
import { MAX_FILE_SIZE_BYTES } from "../../validators/upload.js";
import { tigrisWebhookSchema } from "../../validators/webhook.js";

const webhooks = new Hono<{ Bindings: Env }>();

interface ParsedStoragePath {
  userId: string;
  projectId: string;
  storagePath: string;
  fileName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseStoragePath(key?: string): ParsedStoragePath | null {
  if (!key || typeof key !== "string") {
    return null;
  }

  // Expected format: <userId>/projects/<projectId>/<timestamp>-<fileName>
  const parts = key.split("/");
  if (parts.length < 4 || parts[1] !== "projects") {
    return null;
  }

  const userId = parts[0];
  const projectId = parts[2];
  if (!userId || !projectId) {
    return null;
  }

  const rawFileName = parts.slice(3).join("/");
  const fileName = rawFileName.replace(/^\d+-/, "");

  return { userId, projectId, storagePath: key, fileName };
}

function isDeleteEvent(eventName?: string): boolean {
  if (!eventName) return false;
  const upper = eventName.toUpperCase();
  return (
    upper === "OBJECT_DELETED" ||
    upper.includes("DELETE") ||
    upper.includes("REMOVED")
  );
}

function isCreateEvent(eventName?: string): boolean {
  if (!eventName) return false;
  const upper = eventName.toUpperCase();
  return upper.startsWith("OBJECT_CREATED") || upper.includes("OBJECTCREATED");
}

function getMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

async function handleObjectDeleted(env: Env, storagePath: string): Promise<void> {
  const db = getDb(env);

  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.storageUrl, storagePath))
    .limit(1);

  if (!doc) {
    return;
  }

  try {
    const vectorIndex = getVectorIndex(env);
    await vectorIndex.delete({ filter: `docId = '${doc.id}'` });
  } catch (err) {
    console.error("Webhook vector delete error:", err);
  }

  await db.delete(documents).where(eq(documents.id, doc.id));
}

async function handleObjectCreated(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  path: ParsedStoragePath,
  size?: number | string,
): Promise<void> {
  const db = getDb(env);

  // Verify project existence and ownership
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, path.projectId), eq(projects.userId, path.userId)))
    .limit(1);

  if (!project) {
    return;
  }

  // Prevent duplicate document creation
  const [existing] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.storageUrl, path.storagePath))
    .limit(1);

  if (existing) {
    return;
  }

  const mimeType = getMimeType(path.fileName);
  const title = path.fileName.replace(/\.[^.]+$/, "") || path.fileName;
  const docId = crypto.randomUUID();
  const fileSize = Number(size) || 0;

  // Enforce 25MB limit: mark as error, remove from storage, and skip expensive OCR / vector processing
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    console.warn(
      `[Webhook] File ${path.fileName} (${fileSize} bytes) exceeds 25MB limit. Marking as error and removing from storage.`,
    );
    await db.insert(documents).values({
      id: docId,
      projectId: path.projectId,
      title,
      fileName: path.fileName,
      mimeType,
      fileSize,
      storageUrl: path.storagePath,
      status: "error",
      chunkCount: 0,
    });
    await removeStorageObject(path.storagePath, env);
    return;
  }

  const initialStatus = env.UPSTASH_BOX_API_KEY ? "processing" : "created";

  await db.insert(documents).values({
    id: docId,
    projectId: path.projectId,
    title,
    fileName: path.fileName,
    mimeType,
    fileSize,
    storageUrl: path.storagePath,
    status: initialStatus,
    chunkCount: 0,
  });

  if (env.UPSTASH_BOX_API_KEY) {
    ctx.waitUntil(
      dispatchDocumentProcessing(env, {
        documentId: docId,
        storagePath: path.storagePath,
        userId: path.userId,
        projectId: path.projectId,
        fileName: path.fileName,
        mimeType,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Webhook Route
// ---------------------------------------------------------------------------

webhooks.post("/", async (c) => {
  const rawBody = await c.req.json();
  const parsed = tigrisWebhookSchema.safeParse(rawBody);

  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const payload = parsed.data;

  for (const event of payload.events) {
    try {
      const parsedPath = parseStoragePath(event.object?.key);
      if (!parsedPath) {
        continue;
      }

      if (isDeleteEvent(event.eventName)) {
        await handleObjectDeleted(c.env, parsedPath.storagePath);
      } else if (isCreateEvent(event.eventName)) {
        await handleObjectCreated(
          c.env,
          c.executionCtx,
          parsedPath,
          event.object?.size,
        );
      }
    } catch (err) {
      console.error("Webhook event processing error:", err);
    }
  }

  return c.json({
    status: "processed",
    processedEvents: payload.events.length,
  });
});

export default webhooks;
