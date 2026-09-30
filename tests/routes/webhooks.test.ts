import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_ENV } from "../fixtures/mock-env.js";
import { createMockDb } from "../helpers/db.js";

vi.mock("../../src/db/index.js", () => ({
  getDb: vi.fn(),
  projects: { id: "p_id", userId: "p_uid" },
  documents: { id: "d_id", storageUrl: "d_surl", projectId: "d_pid" },
}));

vi.mock("../../src/services/box.js", () => ({
  dispatchDocumentProcessing: vi.fn(),
}));

vi.mock("../../src/services/vector.js", () => ({
  getVectorIndex: vi.fn(),
}));

vi.mock("../../src/services/storage.js", () => ({
  removeStorageObject: vi.fn().mockResolvedValue({}),
}));

import { getDb } from "../../src/db/index.js";
import app from "../../src/index.js";
import { dispatchDocumentProcessing } from "../../src/services/box.js";
import { removeStorageObject } from "../../src/services/storage.js";
import { getVectorIndex } from "../../src/services/vector.js";

describe("Webhooks Route: /webhooks/tigris", () => {
  let mockDb: ReturnType<typeof createMockDb>;
  const mockVectorDelete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);
    vi.mocked(getVectorIndex).mockReturnValue({
      delete: mockVectorDelete,
    } as unknown as ReturnType<typeof getVectorIndex>);
    vi.mocked(dispatchDocumentProcessing).mockResolvedValue(undefined);
  });

  it("returns 400 if payload is missing or not containing events array", async () => {
    const res = await app.request(
      "/webhooks/tigris",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      },
      MOCK_ENV,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Invalid payload");
  });

  it("ignores events that do not match the expected project path pattern", async () => {
    const res = await app.request(
      "/webhooks/tigris",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          events: [
            {
              eventName: "OBJECT_CREATED",
              object: { key: "random-non-project-path/file.txt" },
            },
          ],
        }),
      },
      MOCK_ENV,
    );

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(dispatchDocumentProcessing).not.toHaveBeenCalled();
  });

  it("handles OBJECT_DELETED by removing document and vector embeddings", async () => {
    const key = "user_1/projects/proj_1/123-test.pdf";
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "doc_to_delete" }]),
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request(
      "/webhooks/tigris",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          events: [
            {
              eventName: "OBJECT_DELETED",
              object: { key },
            },
          ],
        }),
      },
      MOCK_ENV,
    );

    expect(res.status).toBe(200);
    expect(mockVectorDelete).toHaveBeenCalledWith({
      filter: "docId = 'doc_to_delete'",
    });
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("handles OBJECT_CREATED by inserting document and dispatching processing", async () => {
    const key = "user_1/projects/proj_1/123-annual-report.pdf";

    mockDb.select
      .mockReturnValueOnce({
        // Project lookup
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: "proj_1" }]),
      })
      .mockReturnValueOnce({
        // Existing document check (returns empty = new doc)
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "new_doc_id" }]),
    });

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    };

    const res = await app.request(
      "/webhooks/tigris",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          events: [
            {
              eventName: "OBJECT_CREATED",
              object: { key, size: 5000 },
            },
          ],
        }),
      },
      MOCK_ENV,
      executionCtx as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(mockDb.insert).toHaveBeenCalled();
    expect(dispatchDocumentProcessing).toHaveBeenCalledWith(
      MOCK_ENV,
      expect.objectContaining({
        documentId: expect.any(String),
        storagePath: key,
        fileName: "annual-report.pdf",
      }),
    );
  });

  it("handles OBJECT_CREATED for files exceeding 25MB by marking error, deleting from storage, and skipping processing", async () => {
    const key = "user_1/projects/proj_1/123-oversized-document.pdf";
    const oversizedBytes = 26 * 1024 * 1024; // 26MB

    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: "proj_1" }]),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "oversized_doc_id" }]),
    });

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    };

    const res = await app.request(
      "/webhooks/tigris",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          events: [
            {
              eventName: "OBJECT_CREATED",
              object: { key, size: oversizedBytes },
            },
          ],
        }),
      },
      MOCK_ENV,
      executionCtx as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(mockDb.insert).toHaveBeenCalledWith(expect.anything());
    // Verify document was marked as error status
    expect(mockDb.insert().values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        fileSize: oversizedBytes,
      }),
    );
    // Verify oversized file was removed from storage
    expect(removeStorageObject).toHaveBeenCalledWith(key, MOCK_ENV);
    // Verify processing was NOT dispatched
    expect(dispatchDocumentProcessing).not.toHaveBeenCalled();
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });
});
