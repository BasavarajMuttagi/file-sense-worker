import { getAuth } from "@clerk/hono";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { documents, getDb, projects } from "../db/index.js";
import { removeStorageObject } from "../services/storage.js";
import { getVectorIndex } from "../services/vector.js";
import {
  documentIdParamSchema,
  projectDocumentsParamSchema,
} from "../validators/document.js";

const documentsRoute = new Hono<{ Bindings: Env }>();

documentsRoute.get("/:id", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const paramParsed = documentIdParamSchema.safeParse({
    id: c.req.param("id"),
  });
  if (!paramParsed.success) {
    throw new HTTPException(400, {
      message: paramParsed.error.issues[0]?.message ?? "Invalid document ID",
    });
  }

  const db = getDb(c.env);
  const [docWithProject] = await db
    .select({
      id: documents.id,
      projectId: documents.projectId,
      title: documents.title,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      storageUrl: documents.storageUrl,
      chunkCount: documents.chunkCount,
      status: documents.status,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      projectUserId: projects.userId,
    })
    .from(documents)
    .innerJoin(projects, eq(documents.projectId, projects.id))
    .where(eq(documents.id, paramParsed.data.id))
    .limit(1);

  if (!docWithProject) {
    throw new HTTPException(404, { message: "Document not found" });
  }
  if (docWithProject.projectUserId !== userId) {
    throw new HTTPException(403, { message: "Access denied" });
  }

  const { projectUserId: _, ...doc } = docWithProject;
  return c.json(doc);
});

documentsRoute.get("/project/:projectId", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const paramParsed = projectDocumentsParamSchema.safeParse({
    projectId: c.req.param("projectId"),
  });
  if (!paramParsed.success) {
    throw new HTTPException(400, {
      message: paramParsed.error.issues[0]?.message ?? "Invalid project ID",
    });
  }

  const db = getDb(c.env);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, paramParsed.data.projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const docs = await db
    .select({
      id: documents.id,
      title: documents.title,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      status: documents.status,
      chunkCount: documents.chunkCount,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(eq(documents.projectId, project.id))
    .orderBy(desc(documents.createdAt));

  return c.json({ documents: docs });
});

documentsRoute.delete("/:id", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const paramParsed = documentIdParamSchema.safeParse({
    id: c.req.param("id"),
  });
  if (!paramParsed.success) {
    throw new HTTPException(400, {
      message: paramParsed.error.issues[0]?.message ?? "Invalid document ID",
    });
  }

  const db = getDb(c.env);
  const [docWithProject] = await db
    .select({
      id: documents.id,
      storageUrl: documents.storageUrl,
      projectUserId: projects.userId,
    })
    .from(documents)
    .innerJoin(projects, eq(documents.projectId, projects.id))
    .where(eq(documents.id, paramParsed.data.id))
    .limit(1);

  if (!docWithProject) {
    throw new HTTPException(404, { message: "Document not found" });
  }
  if (docWithProject.projectUserId !== userId) {
    throw new HTTPException(403, { message: "Access denied" });
  }

  if (docWithProject.storageUrl) {
    await removeStorageObject(docWithProject.storageUrl, c.env);
  }

  try {
    const vectorIndex = getVectorIndex(c.env);
    await vectorIndex.delete({ filter: `docId = '${docWithProject.id}'` });
  } catch (err: unknown) {
    console.error("Failed to delete document vector chunks:", err);
  }

  await db.delete(documents).where(eq(documents.id, docWithProject.id));
  return c.json({ message: "Document deleted" });
});

export default documentsRoute;
