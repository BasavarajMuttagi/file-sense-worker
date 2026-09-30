import { describe, expect, it } from "vitest";

import {
  createQuerySchema,
  listQueriesQuerySchema,
  queryIdParamSchema,
} from "../../src/validators/query.js";

describe("Query Validators", () => {
  describe("createQuerySchema", () => {
    it("accepts a basic query with question only", () => {
      const result = createQuerySchema.safeParse({
        question: "What is the summary of this document?",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.question).toBe(
          "What is the summary of this document?",
        );
      }
    });

    it("trims question whitespace and accepts optional parameters", () => {
      const result = createQuerySchema.safeParse({
        question: "   Tell me about the financial metrics   ",
        projectId: "proj_123",
        sessionId: "sess_456",
        systemInstruction: "Be concise.",
        systemPrompt: "Answer directly.",
        stream: true,
        history: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello! How can I help?" },
        ],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.question).toBe(
          "Tell me about the financial metrics",
        );
        expect(result.data.stream).toBe(true);
        expect(result.data.history).toHaveLength(2);
      }
    });

    it("rejects empty or whitespace-only question", () => {
      const empty = createQuerySchema.safeParse({ question: "" });
      expect(empty.success).toBe(false);

      const whitespace = createQuerySchema.safeParse({ question: "   " });
      expect(whitespace.success).toBe(false);
    });

    it("rejects question exceeding 4000 characters", () => {
      const longQuestion = "q".repeat(4001);
      const result = createQuerySchema.safeParse({ question: longQuestion });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Question cannot exceed 4000 characters",
        );
      }
    });

    it("rejects invalid role in history", () => {
      const result = createQuerySchema.safeParse({
        question: "Valid question?",
        history: [
          {
            role: "bot",
            content: "Invalid role message",
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("listQueriesQuerySchema", () => {
    it("provides default limit of 20 when not specified", () => {
      const result = listQueriesQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
      }
    });

    it("coerces string limit and offset to numbers", () => {
      const result = listQueriesQuerySchema.safeParse({
        limit: "50",
        offset: "10",
        projectId: "proj_123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.offset).toBe(10);
      }
    });

    it("rejects limit greater than 100 or less than 1", () => {
      const tooHigh = listQueriesQuerySchema.safeParse({ limit: 101 });
      expect(tooHigh.success).toBe(false);

      const tooLow = listQueriesQuerySchema.safeParse({ limit: 0 });
      expect(tooLow.success).toBe(false);
    });
  });

  describe("queryIdParamSchema", () => {
    it("accepts a valid query ID", () => {
      const result = queryIdParamSchema.safeParse({ id: "query_123" });
      expect(result.success).toBe(true);
    });

    it("rejects an empty query ID", () => {
      const result = queryIdParamSchema.safeParse({ id: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("Query ID is required");
      }
    });
  });
});
