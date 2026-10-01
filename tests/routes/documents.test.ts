import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_ENV } from "../fixtures/mock-env.js";
import { resetMockUser, setMockUser } from "../helpers/auth.js";
import { createChainable, createMockDb } from "../helpers/db.js";
import { createMockVectorIndex } from "../helpers/vector.js";

vi.mock("../../src/db/index.js", () => ({
  getDb: vi.fn(),
  projects: { id: "p_id", userId: "p_uid" },
  documents: {
    id: "d_id",
    projectId: "d_pid",
    title: "d_title",
    fileName: "d_fname",
    mimeType: "d_mtype",
    fileSize: "d_fsize",
    storageUrl: "d_surl",
    chunkCount: "d_ccount",
    status: "d_status",
    createdAt: "d_cat",
    updatedAt: "d_uat",
  },
}));

vi.mock("../../src/services/vector.js", () => ({
  getVectorIndex: vi.fn(),
}));

vi.mock("../../src/services/storage.js", () => ({
  removeStorageObject: vi.fn(),
}));

import { getDb } from "../../src/db/index.js";
import app from "../../src/index.js";
import { removeStorageObject } from "../../src/services/storage.js";
import { getVectorIndex } from "../../src/services/vector.js";

describe("Documents Route: /documents", () => {
  let mockDb: ReturnType<typeof createMockDb>;
  const mockVectorDelete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockUser();

    mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb);
    vi.mocked(getVectorIndex).mockReturnValue(
      createMockVectorIndex({ delete: mockVectorDelete }),
    );
    vi.mocked(removeStorageObject).mockResolvedValue({ data: undefined, error: undefined });
  });

  describe("GET /documents/:id", () => {
    it("returns 401 if unauthenticated", async () => {
      setMockUser(null);
      const res = await app.request("/documents/doc_1", {}, MOCK_ENV);
      expect(res.status).toBe(401);
    });

    it("returns 404 if document does not exist", async () => {
      mockDb.select.mockReturnValue(createChainable([]));

      const res = await app.request("/documents/nonexistent", {}, MOCK_ENV);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Document not found");
    });

    it("returns 403 Access denied if document belongs to another user", async () => {
      mockDb.select.mockReturnValue(
        createChainable([{ id: "doc_1", projectUserId: "other_user_456" }]),
      );

      const res = await app.request("/documents/doc_1", {}, MOCK_ENV);
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Access denied");
    });

    it("returns 200 with document data when user owns it", async () => {
      const docData = {
        id: "doc_1",
        projectId: "proj_1",
        title: "Contract.pdf",
        fileName: "Contract.pdf",
        projectUserId: "user_test_123",
      };

      mockDb.select.mockReturnValue(createChainable([docData]));

      const res = await app.request("/documents/doc_1", {}, MOCK_ENV);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.id).toBe("doc_1");
      expect(data.projectUserId).toBeUndefined(); // Should omit projectUserId
    });
  });

  describe("GET /documents/project/:projectId", () => {
    it("returns 404 if project not found for current user", async () => {
      mockDb.select.mockReturnValue(createChainable([]));

      const res = await app.request(
        "/documents/project/missing_proj",
        {},
        MOCK_ENV,
      );
      expect(res.status).toBe(404);
    });

    it("returns 200 with list of documents for valid project", async () => {
      const docs = [
        { id: "doc_1", title: "Doc 1", fileName: "1.pdf" },
        { id: "doc_2", title: "Doc 2", fileName: "2.pdf" },
      ];

      mockDb.select
        .mockReturnValueOnce(createChainable([{ id: "proj_1" }]))
        .mockReturnValueOnce(createChainable(docs));

      const res = await app.request(
        "/documents/project/proj_1",
        {},
        MOCK_ENV,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { documents: unknown[] };
      expect(data.documents).toEqual(docs);
    });
  });

  describe("DELETE /documents/:id", () => {
    it("returns 404 if document does not exist", async () => {
      mockDb.select.mockReturnValue(createChainable([]));

      const res = await app.request(
        "/documents/missing_doc",
        { method: "DELETE" },
        MOCK_ENV,
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 if document belongs to someone else", async () => {
      mockDb.select.mockReturnValue(
        createChainable([{ id: "doc_1", projectUserId: "someone_else" }]),
      );

      const res = await app.request(
        "/documents/doc_1",
        { method: "DELETE" },
        MOCK_ENV,
      );
      expect(res.status).toBe(403);
    });

    it("deletes storage object, vectors, and db record on success", async () => {
      mockDb.select.mockReturnValue(
        createChainable([
          {
            id: "doc_1",
            storageUrl: "user_test_123/projects/proj1/doc1.pdf",
            projectUserId: "user_test_123",
          },
        ]),
      );

      mockDb.delete.mockReturnValue(createChainable({}));

      const res = await app.request(
        "/documents/doc_1",
        { method: "DELETE" },
        MOCK_ENV,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { message: string };
      expect(data.message).toBe("Document deleted");
      expect(removeStorageObject).toHaveBeenCalledWith(
        "user_test_123/projects/proj1/doc1.pdf",
        MOCK_ENV,
      );
      expect(mockVectorDelete).toHaveBeenCalledWith({
        filter: "docId = 'doc_1'",
      });
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});
