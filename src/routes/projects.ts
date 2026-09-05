import { getAuth } from "@clerk/hono";
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { documents, getDb, projects } from "../db/index.js";
import { removeStorageObject } from "../services/storage.js";
import { getVectorIndex } from "../services/vector.js";
import {
  createProjectSchema,
  projectIdParamSchema,
} from "../validators/project.js";

const projectsRoute = new Hono<{ Bindings: Env }>();

projectsRoute.post("/", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? "Invalid input",
    });
  }

  const db = getDb(c.env);
  const [project] = await db
    .insert(projects)
    .values({
      userId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
    })
    .returning();

  if (!project) {
    throw new HTTPException(500, { message: "Failed to create project" });
  }

  return c.json(project, 201);
});

projectsRoute.get("/", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const db = getDb(c.env);
  const projectList = await db
    .select({
      id: projects.id,
      title: projects.title,
      description: projects.description,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      documentCount: count(documents.id),
    })
    .from(projects)
    .leftJoin(documents, eq(projects.id, documents.projectId))
    .where(eq(projects.userId, userId))
    .groupBy(projects.id)
    .orderBy(desc(projects.createdAt));

  return c.json({ projects: projectList });
});

projectsRoute.get("/:id", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const paramParsed = projectIdParamSchema.safeParse({
    id: c.req.param("id"),
  });
  if (!paramParsed.success) {
    throw new HTTPException(400, {
      message: paramParsed.error.issues[0]?.message ?? "Invalid project ID",
    });
  }

  const db = getDb(c.env);
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, paramParsed.data.id), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const docs = await db
    .select({
      id: documents.id,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      status: documents.status,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.projectId, project.id))
    .orderBy(desc(documents.createdAt));

  return c.json({ ...project, documents: docs });
});

projectsRoute.get("/:id/documents", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const paramParsed = projectIdParamSchema.safeParse({
    id: c.req.param("id"),
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
    .where(and(eq(projects.id, paramParsed.data.id), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const docs = await db
    .select({
      id: documents.id,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      fileSize: documents.fileSize,
      status: documents.status,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.projectId, project.id))
    .orderBy(desc(documents.createdAt));

  return c.json({ documents: docs });
});

projectsRoute.delete("/:id", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const paramParsed = projectIdParamSchema.safeParse({
    id: c.req.param("id"),
  });
  if (!paramParsed.success) {
    throw new HTTPException(400, {
      message: paramParsed.error.issues[0]?.message ?? "Invalid project ID",
    });
  }

  const db = getDb(c.env);
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, paramParsed.data.id), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  try {
    const vectorIndex = getVectorIndex(c.env);
    await vectorIndex.delete({
      filter: `projectId = '${project.id}' AND userId = '${userId}'`,
    });
  } catch (err: unknown) {
    console.error("Failed to delete project vector chunks:", err);
  }

  const projectDocs = await db
    .select({ storageUrl: documents.storageUrl })
    .from(documents)
    .where(eq(documents.projectId, project.id));

  for (const doc of projectDocs) {
    if (doc.storageUrl) {
      await removeStorageObject(doc.storageUrl, c.env);
    }
  }

  await db.delete(projects).where(eq(projects.id, project.id));
  return c.json({ message: "Project deleted" });
});

export default projectsRoute;
