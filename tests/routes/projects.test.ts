import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_ENV } from "../fixtures/mock-env.js";
import { resetMockUser, setMockUser } from "../helpers/auth.js";
import { createChainable, createMockDb } from "../helpers/db.js";
import { createMockVectorIndex } from "../helpers/vector.js";

vi.mock("../../src/db/index.js", () => ({
  getDb: vi.fn(),
  projects: { id: "p_id", userId: "p_uid", title: "p_title", description: "p_desc", createdAt: "p_cat", updatedAt: "p_uat" },
  documents: { id: "d_id", projectId: "d_pid", storageUrl: "d_surl", createdAt: "d_cat" },
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

describe("Projects Route: /projects", () => {
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

  describe("POST /projects", () => {
    it("returns 401 Unauthorized if user is not authenticated", async () => {
      setMockUser(null);

      const res = await app.request(
        "/projects",
        {
          method: "POST",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ title: "New Project" }),
        },
        MOCK_ENV,
      );

      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Unauthorized");
    });

    it("returns 400 Bad Request on invalid input (missing title)", async () => {
      const res = await app.request(
        "/projects",
        {
          method: "POST",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ description: "No title provided" }),
        },
        MOCK_ENV,
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBeDefined();
    });

    it("returns 201 Created on valid project creation", async () => {
      const createdProject = {
        id: "proj_new_123",
        userId: "user_test_123",
        title: "Alpha Project",
        description: "Desc",
      };

      mockDb.insert.mockReturnValue(createChainable([createdProject]));

      const res = await app.request(
        "/projects",
        {
          method: "POST",
          headers: new Headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ title: "Alpha Project", description: "Desc" }),
        },
        MOCK_ENV,
      );

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toEqual(createdProject);
    });
  });

  describe("GET /projects", () => {
    it("returns 401 Unauthorized if user is not authenticated", async () => {
      setMockUser(null);

      const res = await app.request("/projects", {}, MOCK_ENV);
      expect(res.status).toBe(401);
    });

    it("returns 200 with list of projects", async () => {
      const projectList = [
        {
          id: "proj_1",
          title: "Project 1",
          description: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          documentCount: 2,
        },
      ];

      mockDb.select.mockReturnValue(createChainable(projectList));

      const res = await app.request("/projects", {}, MOCK_ENV);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { projects: unknown[] };
      expect(data.projects).toEqual(projectList);
    });
  });

  describe("GET /projects/:id", () => {
    it("returns 404 Not Found if project does not exist", async () => {
      mockDb.select.mockReturnValue(createChainable([]));

      const res = await app.request("/projects/nonexistent", {}, MOCK_ENV);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Project not found");
    });

    it("returns 200 with project and document list when found", async () => {
      const project = { id: "proj_123", title: "Project 123", userId: "user_test_123" };
      const docs = [{ id: "doc_1", fileName: "test.pdf" }];

      mockDb.select
        .mockReturnValueOnce(createChainable([project]))
        .mockReturnValueOnce(createChainable(docs));

      const res = await app.request("/projects/proj_123", {}, MOCK_ENV);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ...project, documents: docs });
    });
  });

  describe("DELETE /projects/:id", () => {
    it("returns 404 if project to delete does not exist", async () => {
      mockDb.select.mockReturnValue(createChainable([]));

      const res = await app.request(
        "/projects/proj_missing",
        { method: "DELETE" },
        MOCK_ENV,
      );
      expect(res.status).toBe(404);
    });

    it("cleans up vectors, storage files, and deletes project record", async () => {
      const project = { id: "proj_123", userId: "user_test_123" };
      const docs = [{ storageUrl: "user_test_123/projects/proj_123/doc1.pdf" }];

      mockDb.select
        .mockReturnValueOnce(createChainable([project]))
        .mockReturnValueOnce(createChainable(docs));

      mockDb.delete.mockReturnValue(createChainable({}));

      const res = await app.request(
        "/projects/proj_123",
        { method: "DELETE" },
        MOCK_ENV,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { message: string };
      expect(data.message).toBe("Project deleted");
      expect(mockVectorDelete).toHaveBeenCalledWith({
        filter: "projectId = 'proj_123' AND userId = 'user_test_123'",
      });
      expect(removeStorageObject).toHaveBeenCalledWith(
        "user_test_123/projects/proj_123/doc1.pdf",
        MOCK_ENV,
      );
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});
