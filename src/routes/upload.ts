import { getAuth } from "@clerk/hono";
import { handleClientUpload } from "@tigrisdata/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { getDb, projects } from "../db/index.js";
import { getTigrisConfig } from "../services/storage.js";
import { uploadSchema } from "../validators/upload.js";

const uploadRoute = new Hono<{ Bindings: Env }>();

uploadRoute.post("/", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        parsed.error.issues[0]?.message ?? "Invalid upload request payload",
    });
  }

  const { projectId, name: fileName } = parsed.data;

  const db = getDb(c.env);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-z0-9.-]/gi, "_");
  const storagePath = `${userId}/projects/${projectId}/${timestamp}-${safeFileName}`;

  const payload =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const tigrisConfig = getTigrisConfig(c.env);

  const modifiedBody = {
    ...payload,
    name: storagePath,
    config: {
      ...(typeof payload.config === "object" && payload.config !== null
        ? payload.config
        : {}),
      ...tigrisConfig,
    },
  };

  const uploadResult = await handleClientUpload(
    modifiedBody as unknown as Parameters<typeof handleClientUpload>[0],
  );
  if (uploadResult.error) {
    throw new HTTPException(500, { message: uploadResult.error.message });
  }

  const uploadData = uploadResult.data as { url?: string } | undefined;
  return c.json({
    success: true,
    url: uploadData?.url,
    storagePath,
  });
});

export default uploadRoute;
