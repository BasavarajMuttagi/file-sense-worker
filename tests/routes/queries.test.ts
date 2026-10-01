import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_ENV } from "../fixtures/mock-env.js";
import { resetMockUser, setMockUser } from "../helpers/auth.js";
import { createChainable, createMockDb } from "../helpers/db.js";

vi.mock("../../src/db/index.js", () => ({
  getDb: vi.fn(),
  projects: { id: "p_id", userId: "p_uid", description: "p_desc" },
  documents: { id: "d_id", projectId: "d_pid" },
  queries: {
    id: "q_id",
    userId: "q_uid",
    projectId: "q_pid",
    sessionId: "q_sid",
    question: "q_question",
    answer: "q_answer",
    sources: "q_sources",
    createdAt: "q_cat",
    updatedAt: "q_uat",
  },
}));

vi.mock("@mistralai/mistralai", () => ({
  Mistral: vi.fn(() => ({
    chat: {
      complete: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "Mocked AI answer." } }],
      }),
      stream: vi.fn(),
    },
  })),
}));

vi.mock("../../src/services/vector.js", () => ({
  getVectorIndex: vi.fn(() => ({
    query: vi.fn().mockResolvedValue([]),
  })),
}));

import { getDb } from "../../src/db/index.js";
import app from "../../src/index.js";

describe("Queries Route: /queries", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockUser();

    mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb);
  });

  describe("POST /queries", () => {
    it("returns 401 if unauthenticated", async () => {
      setMockUser(null);

      const res = await app.request(
        "/queries",
        {
          method: "POST",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ question: "Hello" }),
        },
        MOCK_ENV,
      );

      expect(res.status).toBe(401);
    });

    it("returns 400 Bad Request on missing question", async () => {
      const res = await app.request(
        "/queries",
        {
          method: "POST",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({}),
        },
        MOCK_ENV,
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBeDefined();
    });

    it("returns 404 if specified projectId does not exist", async () => {
      mockDb.select.mockReturnValue(createChainable([]));

      const res = await app.request(
        "/queries",
        {
          method: "POST",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            question: "What is this?",
            projectId: "proj_nonexistent",
          }),
        },
        MOCK_ENV,
      );

      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Project not found");
    });

    it("handles conversational greetings directly without vector search error", async () => {
      mockDb.insert.mockReturnValue(
        createChainable([
          {
            id: "query_greeting_1",
            question: "hello!",
            answer: "Hello! How can I assist you today?",
            sources: [],
          },
        ]),
      );

      const res = await app.request(
        "/queries",
        {
          method: "POST",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ question: "hello!" }),
        },
        MOCK_ENV,
      );

      expect(res.status).toBe(201);
      const data = (await res.json()) as { question: string; answer: string };
      expect(data.question).toBe("hello!");
      expect(data.answer).toContain("Hello!");
    });
  });

  describe("GET /queries/sessions", () => {
    it("returns 400 if projectId is missing", async () => {
      const res = await app.request("/queries/sessions", {}, MOCK_ENV);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("projectId is required");
    });

    it("aggregates queries into distinct sessions with message counts", async () => {
      const sampleQueries = [
        {
          id: "q1",
          sessionId: "sess_1",
          question: "First Question",
          createdAt: new Date("2026-09-01T10:00:00Z"),
          updatedAt: new Date("2026-09-01T10:05:00Z"),
        },
        {
          id: "q2",
          sessionId: "sess_1",
          question: "Second Question",
          createdAt: new Date("2026-09-01T10:05:00Z"),
          updatedAt: new Date("2026-09-01T10:05:00Z"),
        },
        {
          id: "q3",
          sessionId: "sess_2",
          question: "Other Session Question",
          createdAt: new Date("2026-09-01T09:00:00Z"),
          updatedAt: new Date("2026-09-01T09:00:00Z"),
        },
      ];

      mockDb.select.mockReturnValue(createChainable(sampleQueries));

      const res = await app.request(
        "/queries/sessions?projectId=proj_123",
        {},
        MOCK_ENV,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        sessions: Array<{ sessionId: string; messageCount: number }>;
      };
      expect(data.sessions).toHaveLength(2);
      expect(data.sessions[0]?.sessionId).toBe("sess_1");
      expect(data.sessions[0]?.messageCount).toBe(2);
    });
  });

  describe("GET /queries/:id", () => {
    it("returns 404 if query record not found", async () => {
      mockDb.select.mockReturnValue(createChainable([]));

      const res = await app.request("/queries/nonexistent_query", {}, MOCK_ENV);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Query not found");
    });

    it("returns 200 with query record when found", async () => {
      const record = {
        id: "query_123",
        question: "Summary?",
        answer: "This is a summary.",
      };

      mockDb.select.mockReturnValue(createChainable([record]));

      const res = await app.request("/queries/query_123", {}, MOCK_ENV);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(record);
    });
  });
});
