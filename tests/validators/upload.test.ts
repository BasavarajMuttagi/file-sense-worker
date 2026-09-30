import { describe, expect, it } from "vitest";

import { uploadSchema } from "../../src/validators/upload.js";

describe("Upload Validators", () => {
  it("accepts valid upload payload with projectId and name", () => {
    const result = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "quarterly-report.pdf",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe("proj_123");
      expect(result.data.name).toBe("quarterly-report.pdf");
    }
  });

  it("passes through additional properties required by Tigris client upload", () => {
    const result = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "data.csv",
      contentType: "text/csv",
      customMeta: { author: "alice" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).contentType).toBe(
        "text/csv",
      );
      expect((result.data as Record<string, unknown>).customMeta).toEqual({
        author: "alice",
      });
    }
  });

  it("rejects when projectId is missing or empty", () => {
    const missing = uploadSchema.safeParse({ name: "data.csv" });
    expect(missing.success).toBe(false);

    const empty = uploadSchema.safeParse({ projectId: "", name: "data.csv" });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toBe("Project ID is required");
    }
  });

  it("rejects when name is missing or empty", () => {
    const missing = uploadSchema.safeParse({ projectId: "proj_123" });
    expect(missing.success).toBe(false);

    const empty = uploadSchema.safeParse({ projectId: "proj_123", name: "" });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toBe("File name is required");
    }
  });
});
