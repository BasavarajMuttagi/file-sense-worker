import { describe, expect, it } from "vitest";

import {
  MAX_FILE_SIZE_BYTES,
  uploadSchema,
} from "../../src/validators/upload.js";

describe("Upload Validators", () => {
  it("accepts valid upload payload with projectId and name, defaulting action to singlepart-init", () => {
    const result = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "quarterly-report.pdf",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe("proj_123");
      expect(result.data.name).toBe("quarterly-report.pdf");
      expect(result.data.action).toBe("singlepart-init");
    }
  });

  it("validates optional contentType and valid fileSize within 25MB limit", () => {
    const result = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "data.pdf",
      contentType: "application/pdf",
      fileSize: 10 * 1024 * 1024, // 10MB
      unrecognizedField: "malicious_payload",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe("singlepart-init");
      expect(result.data.contentType).toBe("application/pdf");
      expect(result.data.fileSize).toBe(10 * 1024 * 1024);
      expect("unrecognizedField" in result.data).toBe(false);
    }
  });

  it("rejects multipart upload actions", () => {
    const multipartInit = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "data.csv",
      action: "multipart-init",
    });
    expect(multipartInit.success).toBe(false);

    const multipartComplete = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "data.csv",
      action: "multipart-complete",
    });
    expect(multipartComplete.success).toBe(false);
  });

  it("rejects files exceeding 25MB (MAX_FILE_SIZE_BYTES)", () => {
    const result = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "huge-archive.pdf",
      fileSize: MAX_FILE_SIZE_BYTES + 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("File size cannot exceed 25MB");
    }

    const sizeFieldResult = uploadSchema.safeParse({
      projectId: "proj_123",
      name: "huge-archive.pdf",
      size: 30 * 1024 * 1024,
    });
    expect(sizeFieldResult.success).toBe(false);
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
