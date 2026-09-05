import { getAuth } from "@clerk/hono";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { getDb, projects, queries } from "../db/index.js";
import { getVectorIndex } from "../services/vector.js";
import {
  createQuerySchema,
  listQueriesQuerySchema,
  queryIdParamSchema,
} from "../validators/query.js";

import { Mistral } from "@mistralai/mistralai";

const queriesRoute = new Hono<{ Bindings: Env }>();

interface SourceItem {
  docId: string;
  docName: string;
  pageStart: number | null;
  pageEnd: number | null;
  snippet: string;
  score?: number;
}

async function callMistralChatCompletion(
  question: string,
  contextText: string,
  apiKey: string,
): Promise<string> {
  const client = new Mistral({ apiKey });

  const response = await client.chat.complete({
    model: "mistral-medium-3-5",
    messages: [
      {
        role: "system",
        content:
          "You are an AI assistant answering questions based on document excerpts. Answer the question accurately and concisely using only the provided context. If the context does not contain the answer, state that clearly.",
      },
      {
        role: "user",
        content: `Context:\n${contextText}\n\nQuestion: ${question}\nAnswer:`,
      },
    ],
    temperature: 0.2,
  });

  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

queriesRoute.post("/", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = createQuerySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? "Invalid query payload",
    });
  }

  const { question, projectId } = parsed.data;
  const db = getDb(c.env);

  if (projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      throw new HTTPException(404, { message: "Project not found" });
    }
  }

  const filter = projectId
    ? `userId = '${userId}' AND projectId = '${projectId}'`
    : `userId = '${userId}'`;

  let sources: SourceItem[] = [];

  try {
    const vectorIndex = getVectorIndex(c.env);
    const vectorResults = await vectorIndex.query<{
      userId?: string;
      projectId?: string;
      docId?: string;
      docName?: string;
      pageStart?: number;
      pageEnd?: number;
      chunkIndex?: number;
    }>({
      data: question,
      topK: 6,
      includeMetadata: true,
      includeData: true,
      filter,
    });

    sources = vectorResults.map((match) => ({
      docId: match.metadata?.docId ?? "",
      docName: match.metadata?.docName ?? "",
      pageStart:
        typeof match.metadata?.pageStart === "number"
          ? match.metadata.pageStart
          : null,
      pageEnd:
        typeof match.metadata?.pageEnd === "number"
          ? match.metadata.pageEnd
          : null,
      snippet: typeof match.data === "string" ? match.data : "",
      score: match.score,
    }));
  } catch (err: unknown) {
    console.error("Upstash vector search failed:", err);
  }

  let answer = "";
  const mistralApiKey = (c.env as unknown as Record<string, unknown>)
    .MISTRAL_API_KEY as string | undefined;

  if (sources.length === 0) {
    answer =
      "No relevant information found in the indexed documents for your query.";
  } else if (mistralApiKey) {
    try {
      const contextText = sources
        .map(
          (s, idx) =>
            `[Source ${idx + 1} - ${s.docName} (Pages ${s.pageStart ?? 1}-${s.pageEnd ?? 1})]:\n${s.snippet}`,
        )
        .join("\n\n");

      answer = await callMistralChatCompletion(
        question,
        contextText,
        mistralApiKey,
      );
    } catch (llmErr: unknown) {
      console.error("Mistral synthesis error:", llmErr);
    }
  }

  if (!answer) {
    if (sources.length > 0) {
      answer = `Based on your indexed documents, here are the most relevant excerpts:\n\n${sources
        .map(
          (s, i) =>
            `[${i + 1}] ${s.docName} (Page ${s.pageStart ?? 1}): ${s.snippet}`,
        )
        .join("\n\n")}`;
    } else {
      answer =
        "No relevant information found in the indexed documents for your query.";
    }
  }

  const mappedSources = sources.map((s) => ({
    title: s.docName,
    fileName: s.docName,
    chunkIndex: 0,
    text: s.snippet,
    score: s.score ?? 0,
  }));

  const [queryRecord] = await db
    .insert(queries)
    .values({
      userId,
      projectId: projectId ?? null,
      question: question.trim(),
      answer,
      sources: mappedSources,
    })
    .returning();

  if (!queryRecord) {
    throw new HTTPException(500, { message: "Failed to save query record" });
  }

  return c.json(
    {
      id: queryRecord.id,
      question: queryRecord.question,
      answer: queryRecord.answer,
      sources: queryRecord.sources,
      createdAt: queryRecord.createdAt,
    },
    201,
  );
});

queriesRoute.get("/", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const queryParams = c.req.query();
  const parsed = listQueriesQuerySchema.safeParse(queryParams);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues[0]?.message ?? "Invalid query parameters",
    });
  }

  const { projectId } = parsed.data;
  const db = getDb(c.env);

  if (projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      throw new HTTPException(404, { message: "Project not found" });
    }
  }

  const condition = projectId
    ? and(eq(queries.userId, userId), eq(queries.projectId, projectId))
    : eq(queries.userId, userId);

  const qs = await db
    .select({
      id: queries.id,
      question: queries.question,
      answer: queries.answer,
      projectId: queries.projectId,
      createdAt: queries.createdAt,
    })
    .from(queries)
    .where(condition)
    .orderBy(desc(queries.createdAt))
    .limit(50);

  return c.json({ queries: qs });
});

queriesRoute.get("/:id", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const paramParsed = queryIdParamSchema.safeParse({ id: c.req.param("id") });
  if (!paramParsed.success) {
    throw new HTTPException(400, {
      message: paramParsed.error.issues[0]?.message ?? "Invalid query ID",
    });
  }

  const db = getDb(c.env);
  const [queryRecord] = await db
    .select()
    .from(queries)
    .where(and(eq(queries.id, paramParsed.data.id), eq(queries.userId, userId)))
    .limit(1);

  if (!queryRecord) {
    throw new HTTPException(404, { message: "Query not found" });
  }

  return c.json(queryRecord);
});

export default queriesRoute;
