import { describe, expect, it } from "vitest";

import {
  createProjectSchema,
  projectIdParamSchema,
} from "../../src/validators/project.js";

describe("Project Validators", () => {
  describe("createProjectSchema", () => {
    it("accepts a valid project payload with title and description", () => {
      const result = createProjectSchema.safeParse({
        title: "Test Project",
        description: "A valid description for testing.",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Test Project");
        expect(result.data.description).toBe("A valid description for testing.");
      }
    });

    it("trims whitespace from title and description", () => {
      const result = createProjectSchema.safeParse({
        title: "   Trimmed Title   ",
        description: "   Trimmed Description   ",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Trimmed Title");
        expect(result.data.description).toBe("Trimmed Description");
      }
    });

    it("accepts a project without description or with null description", () => {
      const resWithout = createProjectSchema.safeParse({
        title: "No Description",
      });
      expect(resWithout.success).toBe(true);

      const resNull = createProjectSchema.safeParse({
        title: "Null Description",
        description: null,
      });
      expect(resNull.success).toBe(true);
      if (resNull.success) {
        expect(resNull.data.description).toBeNull();
      }
    });

    it("rejects when title is missing", () => {
      const result = createProjectSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects when title is an empty string or only whitespace", () => {
      const resultEmpty = createProjectSchema.safeParse({ title: "" });
      expect(resultEmpty.success).toBe(false);

      const resultWhitespace = createProjectSchema.safeParse({ title: "   " });
      expect(resultWhitespace.success).toBe(false);
    });

    it("rejects when title exceeds 200 characters", () => {
      const longTitle = "a".repeat(201);
      const result = createProjectSchema.safeParse({ title: longTitle });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Title cannot exceed 200 characters",
        );
      }
    });

    it("rejects when description exceeds 1000 characters", () => {
      const longDesc = "a".repeat(1001);
      const result = createProjectSchema.safeParse({
        title: "Valid Title",
        description: longDesc,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Description cannot exceed 1000 characters",
        );
      }
    });
  });

  describe("projectIdParamSchema", () => {
    it("accepts a valid project ID", () => {
      const result = projectIdParamSchema.safeParse({ id: "proj_123" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("proj_123");
      }
    });

    it("rejects an empty project ID", () => {
      const result = projectIdParamSchema.safeParse({ id: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("Project ID is required");
      }
    });
  });
});
