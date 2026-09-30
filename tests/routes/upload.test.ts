import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_ENV } from "../fixtures/mock-env.js";
import { resetMockUser, setMockUser } from "../helpers/auth.js";
import { createMockDb } from "../helpers/db.js";

vi.mock("../../src/db/index.js", () => ({
  getDb: vi.fn(),
  projects: { id: "p_id", userId: "p_uid" },
}));

vi.mock("@tigrisdata/storage", () => ({
  handleClientUpload: vi.fn(),
}));

import { handleClientUpload } from "@tigrisdata/storage";
import { getDb } from "../../src/db/index.js";
import app from "../../src/index.js";

describe("Upload Route: /api/upload", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockUser();

    mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);
    vi.mocked(handleClientUpload).mockResolvedValue({
      url: "https://upload.url",
      fields: {},
    } as unknown as Awaited<ReturnType<typeof handleClientUpload>>);
  });

  it("returns 401 Unauthorized if unauthenticated", async () => {
    setMockUser(null);

    const res = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ projectId: "p1", name: "test.pdf" }),
      },
      MOCK_ENV,
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 Bad Request on invalid upload payload", async () => {
    const res = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      },
      MOCK_ENV,
    );

    expect(res.status).toBe(400);
  });

  it("returns 404 if project not found for current user", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    });

    const res = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ projectId: "proj_not_found", name: "report.pdf" }),
      },
      MOCK_ENV,
    );

    expect(res.status).toBe(404);
  });

  it("formats storage key and calls handleClientUpload on success", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "proj_123" }]),
    });

    const res = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          projectId: "proj_123",
          name: "my test document.pdf",
        }),
      },
      MOCK_ENV,
    );

    expect(res.status).toBe(200);
    expect(handleClientUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(
          /^user_test_123\/projects\/proj_123\/\d+-my_test_document\.pdf$/,
        ),
      }),
      expect.objectContaining({
        bucket: "mock-bucket",
      }),
    );
  });
});
