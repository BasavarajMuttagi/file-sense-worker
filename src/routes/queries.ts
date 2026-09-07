import { getAuth } from "@clerk/hono";
import { and, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";

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
  id: string;
  docId: string;
  docName: string;
  page: number;
  pageStart: number;
  pageEnd: number;
  chunkIndex: number;
  snippet: string;
  score?: number;
  isFirstChunkOfPage?: boolean;
  isLastChunkOfPage?: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const defaultPrompt = `You are a precision AI research assistant answering questions based on provided sources.

Core Guidelines:
- Laser-Focused: Answer ONLY what the user specifically asked. Strictly ignore unrelated documents, irrelevant history, or extraneous excerpts that do not directly pertain to the specific question.
- Inline Citations: Use inline bracket citations like [1], [2], [3] referring strictly to the numbered source order below.
- Strict Grounding: Synthesize ONLY from facts directly stated in the Sources. If the sources do not contain enough information to answer the question, clearly state that the information is not available in the provided documents. Never make up facts.
- Diagrams & Visuals: When describing architectures, workflows, pipelines, career graphs, or multi-step processes, optionally illustrate them with a clean, valid Mermaid diagram inside a \`\`\`mermaid ... \`\`\` code block.
  CRITICAL MERMAID INSTRUCTIONS:
  1. ALWAYS use 'flowchart TD' or 'flowchart LR' (or sequenceDiagram). NEVER use 'gantt' or 'gitGraph' (their syntax easily causes parsing crashes).
  2. ALWAYS wrap node text in double quotes inside square brackets: nodeId["Label (Details)"] --> nextId["Next Label"].
  3. Keep node labels short and concise. Do NOT use unquoted parentheses, unquoted colons, or HTML tags inside node text.`;

function buildMistralMessages(
  systemPrompt: string,
  history: ChatMessage[] | undefined,
  question: string,
  contextText: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  if (history && history.length > 0) {
    const recent = history.slice(-6);
    for (const msg of recent) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  messages.push({
    role: "user",
    content: `Query: ${question}\n\nSources:\n${contextText}\n\nAnswer the user's question directly with inline citations [1], [2] based strictly on the sources:`,
  });

  return messages;
}

async function* streamMistralChatCompletion(
  question: string,
  contextText: string,
  apiKey: string,
  customSystemInstruction?: string,
  history?: ChatMessage[],
): AsyncGenerator<string, void, unknown> {
  const client = new Mistral({ apiKey });
  const systemPrompt = customSystemInstruction?.trim()
    ? `${defaultPrompt}\n\nAdditional System Instructions:\n${customSystemInstruction.trim()}`
    : defaultPrompt;

  const messages = buildMistralMessages(systemPrompt, history, question, contextText);

  const modelsToTry = [
    "open-mistral-nemo",
    "mistral-small-latest",
    "ministral-8b-latest",
    "mistral-large-latest",
  ];

  let lastError: unknown = null;
  for (const model of modelsToTry) {
    try {
      const stream = await client.chat.stream({
        model,
        messages,
        temperature: 0.5,
        maxTokens: 10000,
        safePrompt: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.data?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          yield delta;
        }
      }
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[Mistral Stream] Model ${model} failed:`, err);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

async function callMistralChatCompletion(
  question: string,
  contextText: string,
  apiKey: string,
  customSystemInstruction?: string,
  history?: ChatMessage[],
): Promise<string> {
  const client = new Mistral({ apiKey });
  const systemPrompt = customSystemInstruction?.trim()
    ? `${defaultPrompt}\n\nAdditional System Instructions:\n${customSystemInstruction.trim()}`
    : defaultPrompt;

  const messages = buildMistralMessages(systemPrompt, history, question, contextText);

  const modelsToTry = [
    "open-mistral-nemo",
    "mistral-small-latest",
    "ministral-8b-latest",
    "mistral-large-latest",
  ];
  let lastError: unknown = null;

  for (const model of modelsToTry) {
    try {
      const response = await client.chat.complete({
        model,
        messages,
        temperature: 0.5,
        maxTokens: 10000,
        safePrompt: true,
      });

      const content = response.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Mistral] Model ${model} failed:`, err);
    }
  }

  if (lastError) {
    throw lastError;
  }

  return "";
}

async function generateQueryEmbedding(queryText: string, apiKey: string): Promise<number[]> {
  const client = new Mistral({ apiKey });
  const prefixedQuery = `search_query: ${queryText}`;
  const response = await client.embeddings.create({
    model: "mistral-embed",
    inputs: [prefixedQuery],
  });

  const embedding = response.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Mistral Embedding SDK did not return a valid embedding vector");
  }

  return embedding;
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

  const {
    question,
    projectId,
    systemInstruction,
    systemPrompt,
    stream: requestStream,
    history,
  } = parsed.data;

  const shouldStream =
    requestStream === true ||
    c.req.header("Accept")?.includes("text/event-stream") ||
    c.req.query("stream") === "true";

  const db = getDb(c.env);

  let projectDescription: string | null = null;

  if (projectId) {
    const [project] = await db
      .select({ id: projects.id, description: projects.description })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      throw new HTTPException(404, { message: "Project not found" });
    }
    projectDescription = project.description;
  }

  const filter = projectId
    ? `userId = '${userId}' AND projectId = '${projectId}'`
    : `userId = '${userId}'`;

  // Context-aware vector retrieval query: if follow-up question is short/conversational, supplement with previous user turn
  let vectorQueryText = question;
  if (history && history.length > 0 && question.trim().length < 35) {
    const lastUserTurn = [...history].reverse().find((h) => h.role === "user");
    if (lastUserTurn?.content) {
      vectorQueryText = `${lastUserTurn.content} ${question}`;
    }
  }

  const mistralApiKey = (c.env as unknown as Record<string, unknown>).MISTRAL_API_KEY as string | undefined;

  let retrievedChunks: SourceItem[] = [];

  try {
    let queryVector: number[] = [];
    if (mistralApiKey) {
      queryVector = await generateQueryEmbedding(vectorQueryText, mistralApiKey);
    }

    const vectorIndex = getVectorIndex(c.env);
    let vectorResults: Array<{
      id: string | number;
      score?: number;
      data?: string;
      metadata?: Record<string, unknown>;
    }> = [];

    if (queryVector.length > 0) {
      try {
        vectorResults = await vectorIndex.query<{
          userId?: string;
          projectId?: string;
          docId?: string;
          docName?: string;
          page?: number;
          pageStart?: number;
          pageEnd?: number;
          chunkIndex?: number;
          text?: string;
          type?: string;
          parentId?: string;
          isFirstChunkOfPage?: boolean;
          isLastChunkOfPage?: boolean;
          isOverlapped?: boolean;
          uploadedAt?: string;
        }>({
          vector: queryVector,
          topK: 10,
          includeMetadata: true,
          includeData: true,
          filter,
        });
      } catch (vecErr: unknown) {
        const msg = vecErr instanceof Error ? vecErr.message : String(vecErr);
        if (msg.toLowerCase().includes("dimension")) {
          console.warn("[Upstash Vector] Dimension mismatch with Mistral 1024d vector, falling back to Upstash built-in embedding:", msg);
          vectorResults = await vectorIndex.query({
            data: vectorQueryText,
            topK: 10,
            includeMetadata: true,
            includeData: true,
            filter,
          });
        } else {
          throw vecErr;
        }
      }
    } else {
      vectorResults = await vectorIndex.query({
        data: vectorQueryText,
        topK: 10,
        includeMetadata: true,
        includeData: true,
        filter,
      });
    }

    retrievedChunks = (vectorResults || []).map((match) => {
      const pageNum =
        typeof match.metadata?.page === "number"
          ? match.metadata.page
          : typeof match.metadata?.pageStart === "number"
            ? match.metadata.pageStart
            : 1;

      return {
        id: String(match.id ?? ""),
        docId: (match.metadata?.docId as string) ?? "",
        docName: (match.metadata?.docName as string) || "Document",
        page: pageNum,
        pageStart: pageNum,
        pageEnd: typeof match.metadata?.pageEnd === "number" ? match.metadata.pageEnd : pageNum,
        chunkIndex: (match.metadata?.chunkIndex as number) ?? 0,
        snippet: (typeof match.data === "string" && match.data) ? match.data : ((match.metadata?.text as string) ?? ""),
        score: typeof match.score === "number" ? match.score : 0,
        isFirstChunkOfPage: (match.metadata?.isFirstChunkOfPage as boolean) ?? (match.metadata?.chunkIndex === 0),
        isLastChunkOfPage: (match.metadata?.isLastChunkOfPage as boolean) ?? false,
      };
    });
  } catch (err: unknown) {
    console.error("Upstash vector search failed:", err);
  }

  // 1. Adaptive Confidence Filtering:
  // Try high confidence threshold (>= 0.70)
  const highConfidenceChunks = retrievedChunks.filter((c) => (c.score ?? 0) >= 0.70);

  let candidateChunks: SourceItem[] = [];
  if (highConfidenceChunks.length >= 2) {
    candidateChunks = highConfidenceChunks;
  } else {
    // Relax threshold to >= 0.55 if fewer than 2 high-confidence chunks
    candidateChunks = retrievedChunks.filter((c) => (c.score ?? 0) >= 0.55);
  }

  // If still empty but matches exist, include the top matching chunks
  if (candidateChunks.length === 0 && retrievedChunks.length > 0) {
    candidateChunks = retrievedChunks.slice(0, 3);
  }

  // 2. Context Continuity at Page Boundaries:
  // If a high-confidence chunk is the last chunk of a page, check if the first chunk of the next page is in top-10
  const candidateIds = new Set(candidateChunks.map((c) => c.id));
  for (const chunk of [...candidateChunks]) {
    if (chunk.isLastChunkOfPage && chunk.docId) {
      const nextPage = chunk.page + 1;
      const nextPageFirstChunk = retrievedChunks.find(
        (rc) =>
          rc.docId === chunk.docId &&
          rc.page === nextPage &&
          rc.isFirstChunkOfPage &&
          (rc.score ?? 0) >= 0.60,
      );
      if (nextPageFirstChunk && !candidateIds.has(nextPageFirstChunk.id)) {
        candidateChunks.push(nextPageFirstChunk);
        candidateIds.add(nextPageFirstChunk.id);
      }
    }
  }

  // 3. Deduplication & Capping (5–7 chunks max)
  const seenIds = new Set<string>();
  const deduplicatedChunks: SourceItem[] = [];
  for (const chunk of candidateChunks) {
    const key = chunk.id || `${chunk.docId}#page${chunk.page}#chunk${chunk.chunkIndex}`;
    if (!seenIds.has(key)) {
      seenIds.add(key);
      deduplicatedChunks.push(chunk);
    }
  }

  const selectedChunks = deduplicatedChunks.slice(0, 7);

  // 4. Reordering by Document Sequence: (docId, page, chunkIndex)
  // Preserves natural reading order, avoids "relevance salad"
  selectedChunks.sort((a, b) => {
    if (a.docId !== b.docId) return a.docId.localeCompare(b.docId);
    if (a.page !== b.page) return a.page - b.page;
    return a.chunkIndex - b.chunkIndex;
  });

  const notFoundMessage =
    "I couldn't find relevant information in the provided documents to answer your question. Try rephrasing or asking something covered in your documents.";

  // Zero-result Guardrail: If no chunks met the confidence threshold, return grounded message immediately without calling LLM
  if (selectedChunks.length === 0) {
    if (shouldStream) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "sources",
          data: JSON.stringify([]),
        });
        await stream.writeSSE({
          event: "token",
          data: JSON.stringify({ text: notFoundMessage }),
        });

        try {
          const [queryRecord] = await db
            .insert(queries)
            .values({
              userId,
              projectId: projectId ?? null,
              question: question.trim(),
              answer: notFoundMessage,
              sources: [],
            })
            .returning();

          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({
              id: queryRecord?.id ?? null,
              answer: notFoundMessage,
            }),
          });
        } catch (dbErr) {
          console.error("Failed to save zero-match query to DB:", dbErr);
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({
              id: null,
              answer: notFoundMessage,
            }),
          });
        }
      });
    }

    const [queryRecord] = await db
      .insert(queries)
      .values({
        userId,
        projectId: projectId ?? null,
        question: question.trim(),
        answer: notFoundMessage,
        sources: [],
      })
      .returning();

    return c.json(
      {
        id: queryRecord?.id ?? crypto.randomUUID(),
        question: question.trim(),
        answer: notFoundMessage,
        sources: [],
        createdAt: queryRecord?.createdAt ?? new Date(),
      },
      201,
    );
  }

  const mappedSources = selectedChunks.map((s) => ({
    docId: s.docId,
    title: s.docName,
    fileName: s.docName,
    page: s.page,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    chunkIndex: s.chunkIndex,
    excerpt: s.snippet.length > 150 ? s.snippet.slice(0, 150) + "..." : s.snippet,
    text: s.snippet,
    score: s.score ?? 0,
  }));

  const contextText = selectedChunks
    .map(
      (s, idx) =>
        `[${idx + 1}] From ${s.docName}, Page ${s.page}:\n${s.snippet}`,
    )
    .join("\n\n");

  const instructionToPass =
    systemInstruction ||
    systemPrompt ||
    projectDescription ||
    undefined;

  // Real-time SSE Streaming Mode
  if (shouldStream) {
    return streamSSE(c, async (stream) => {
      // 1. Immediately emit sources event so UI can display source cards
      await stream.writeSSE({
        event: "sources",
        data: JSON.stringify(mappedSources),
      });

      let fullAnswer = "";

      if (mistralApiKey) {
        try {
          const streamGen = streamMistralChatCompletion(
            question,
            contextText,
            mistralApiKey,
            instructionToPass,
            history,
          );

          for await (const token of streamGen) {
            fullAnswer += token;
            await stream.writeSSE({
              event: "token",
              data: JSON.stringify({ text: token }),
            });
          }
        } catch (llmErr) {
          console.error("[Mistral SSE Stream Error]:", llmErr);
          if (!fullAnswer) {
            fullAnswer = `Based on your indexed documents, here are the most relevant excerpts:\n\n${selectedChunks
              .map(
                (s, i) =>
                  `[${i + 1}] ${s.docName} (Page ${s.page}): ${s.snippet}`,
              )
              .join("\n\n")}`;
            await stream.writeSSE({
              event: "token",
              data: JSON.stringify({ text: fullAnswer }),
            });
          }
        }
      } else {
        fullAnswer = `Based on your indexed documents, here are the most relevant excerpts:\n\n${selectedChunks
          .map(
            (s, i) =>
              `[${i + 1}] ${s.docName} (Page ${s.page}): ${s.snippet}`,
          )
          .join("\n\n")}`;
        await stream.writeSSE({
          event: "token",
          data: JSON.stringify({ text: fullAnswer }),
        });
      }

      // 2. Persist record to database
      try {
        const [queryRecord] = await db
          .insert(queries)
          .values({
            userId,
            projectId: projectId ?? null,
            question: question.trim(),
            answer: fullAnswer,
            sources: mappedSources,
          })
          .returning();

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            id: queryRecord?.id ?? null,
            answer: fullAnswer,
          }),
        });
      } catch (dbErr) {
        console.error("Failed to save streamed query to DB:", dbErr);
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            id: null,
            answer: fullAnswer,
          }),
        });
      }
    });
  }

  // Standard Synchronous JSON Mode
  let answer = "";

  if (mistralApiKey) {
    try {
      answer = await callMistralChatCompletion(
        question,
        contextText,
        mistralApiKey,
        instructionToPass,
        history,
      );
    } catch (llmErr: unknown) {
      console.error("Mistral synthesis error:", llmErr);
    }
  }

  if (!answer) {
    answer = `Based on your indexed documents, here are the most relevant excerpts:\n\n${selectedChunks
      .map(
        (s, i) =>
          `[${i + 1}] ${s.docName} (Page ${s.page}): ${s.snippet}`,
      )
      .join("\n\n")}`;
  }

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

  const { projectId, limit = 20, before } = parsed.data;
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

  const conditions = [eq(queries.userId, userId)];
  if (projectId) {
    conditions.push(eq(queries.projectId, projectId));
  }

  if (before) {
    const beforeDate = new Date(isNaN(Number(before)) ? before : Number(before));
    if (!isNaN(beforeDate.getTime())) {
      conditions.push(lt(queries.createdAt, beforeDate));
    }
  }

  const fetchLimit = Math.min(limit, 100);
  const qs = await db
    .select({
      id: queries.id,
      question: queries.question,
      answer: queries.answer,
      sources: queries.sources,
      projectId: queries.projectId,
      createdAt: queries.createdAt,
    })
    .from(queries)
    .where(and(...conditions))
    .orderBy(desc(queries.createdAt))
    .limit(fetchLimit + 1);

  let hasMore = false;
  if (qs.length > fetchLimit) {
    hasMore = true;
    qs.pop();
  }

  // Reverse so the messages are in natural chronological order (oldest -> newest)
  const chronological = [...qs].reverse();

  return c.json({
    queries: chronological,
    hasMore,
    nextCursor: qs.length > 0 ? (qs[qs.length - 1]?.createdAt ?? null) : null,
  });
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
