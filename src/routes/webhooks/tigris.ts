import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import { documents, getDb, projects } from "../../db/index.js";
import { getVectorIndex } from "../../services/vector.js";

const webhooks = new Hono<{ Bindings: Env }>();

interface TigrisNotificationEvent {
  eventName?: string;
  object?: {
    key?: string;
    size?: number | string;
    eTag?: string;
  };
}

interface TigrisWebhookPayload {
  events?: TigrisNotificationEvent[];
}

webhooks.post("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const payload =
    typeof body === "object" && body !== null
      ? (body as TigrisWebhookPayload)
      : null;

  if (!payload || !Array.isArray(payload.events)) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const db = getDb(c.env);

  for (const event of payload.events) {
    try {
      const storagePath = event.object?.key;
      if (!storagePath || typeof storagePath !== "string") {
        continue;
      }

      const pathParts = storagePath.split("/");
      if (pathParts.length < 4 || pathParts[1] !== "projects") {
        continue;
      }

      const userId = pathParts[0];
      const projectId = pathParts[2];
      const rawFileName = pathParts.slice(3).join("/");
      const cleanFileName = rawFileName.replace(/^\d+-/, "");

      if (!userId || !projectId) {
        continue;
      }

      if (event.eventName === "OBJECT_DELETED") {
        const [doc] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.storageUrl, storagePath))
          .limit(1);

        if (doc) {
          try {
            const vectorIndex = getVectorIndex(c.env);
            await vectorIndex.delete({ filter: `docId = '${doc.id}'` });
          } catch (delErr: unknown) {
            console.error("Webhook vector delete error:", delErr);
          }
          await db.delete(documents).where(eq(documents.id, doc.id));
        }
        continue;
      }

      if (
        event.eventName !== "OBJECT_CREATED_PUT" &&
        event.eventName !== "OBJECT_CREATED_MULTIPART"
      ) {
        continue;
      }

      const fileSize = Number(event.object?.size) || 0;

      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
        .limit(1);

      if (!project) {
        continue;
      }

      const [existing] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.storageUrl, storagePath))
        .limit(1);

      if (existing) {
        continue;
      }

      const mimeType = getMimeType(cleanFileName);
      const title = cleanFileName.replace(/\.[^.]+$/, "") || cleanFileName;

      await db.insert(documents).values({
        id: crypto.randomUUID(),
        projectId,
        title,
        fileName: cleanFileName,
        mimeType,
        fileSize,
        storageUrl: storagePath,
        status: "created",
        chunkCount: 0,
      });

      // Note: Heavy document OCR/digitization and vector chunking is handled externally.
    } catch (err: unknown) {
      console.error("Webhook event processing error:", err);
    }
  }

  return c.json({
    status: "processed",
    processedEvents: payload.events.length,
  });
});

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

export default webhooks;
