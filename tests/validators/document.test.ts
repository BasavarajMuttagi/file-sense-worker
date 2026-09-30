import { describe, expect, it } from "vitest";

import {
  documentIdParamSchema,
  projectDocumentsParamSchema,
} from "../../src/validators/document.js";

describe("Document Validators", () => {
  describe("documentIdParamSchema", () => {
    it("accepts a valid document ID", () => {
      const result = documentIdParamSchema.safeParse({ id: "doc_abc_123" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("doc_abc_123");
      }
    });

    it("rejects an empty document ID", () => {
      const result = documentIdParamSchema.safeParse({ id: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("Document ID is required");
      }
    });

    it("rejects when id is omitted", () => {
      const result = documentIdParamSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("projectDocumentsParamSchema", () => {
    it("accepts a valid projectId", () => {
      const result = projectDocumentsParamSchema.safeParse({
        projectId: "proj_abc_123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.projectId).toBe("proj_abc_123");
      }
    });

    it("rejects an empty projectId", () => {
      const result = projectDocumentsParamSchema.safeParse({ projectId: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("Project ID is required");
      }
    });
  });
});
