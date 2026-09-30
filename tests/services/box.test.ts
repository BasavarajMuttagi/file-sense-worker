import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchDocumentProcessing,
  type DocumentProcessingJob,
} from "../../src/services/box.js";
import { createMockEnv } from "../fixtures/mock-env.js";

const mockUpdateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue({}),
};

const mockDb = {
  update: vi.fn(() => mockUpdateChain),
};

vi.mock("../../src/db/index.js", () => ({
  getDb: vi.fn(() => mockDb),
  documents: { id: "documents_id" },
}));

vi.mock("../../src/services/storage.js", () => ({
  getStoragePresignedDownloadUrl: vi.fn(),
}));

const mockBoxInstance = {
  id: "box_test_123",
  files: {
    write: vi.fn().mockResolvedValue(undefined),
  },
  exec: {
    command: vi.fn(),
  },
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@upstash/box", () => ({
  EphemeralBox: {
    create: vi.fn(() => Promise.resolve(mockBoxInstance)),
  },
}));

import { EphemeralBox } from "@upstash/box";
import { getStoragePresignedDownloadUrl } from "../../src/services/storage.js";

describe("Box Service: dispatchDocumentProcessing", () => {
  const sampleJob: DocumentProcessingJob = {
    documentId: "doc_test_1",
    storagePath: "user1/projects/proj1/file.pdf",
    userId: "user_test_1",
    projectId: "proj_test_1",
    fileName: "file.pdf",
    mimeType: "application/pdf",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBoxInstance.exec.command.mockResolvedValue({
      exitCode: 0,
      stdout: "Done",
      stderr: "",
    });
    vi.mocked(getStoragePresignedDownloadUrl).mockResolvedValue(
      "https://storage.test/download.pdf",
    );
  });

  it("returns early without processing if UPSTASH_BOX_API_KEY is not set", async () => {
    const envWithoutKey = createMockEnv({ UPSTASH_BOX_API_KEY: "" });

    await dispatchDocumentProcessing(envWithoutKey, sampleJob);

    expect(getStoragePresignedDownloadUrl).not.toHaveBeenCalled();
    expect(EphemeralBox.create).not.toHaveBeenCalled();
  });

  it("updates document status to error if presigned URL cannot be generated", async () => {
    const env = createMockEnv();
    vi.mocked(getStoragePresignedDownloadUrl).mockResolvedValueOnce(null);

    await dispatchDocumentProcessing(env, sampleJob);

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockUpdateChain.set).toHaveBeenCalledWith({ status: "error" });
    expect(EphemeralBox.create).not.toHaveBeenCalled();
  });

  it("executes the pipeline runner and deletes box on success", async () => {
    const env = createMockEnv();

    await dispatchDocumentProcessing(env, sampleJob);

    expect(EphemeralBox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "node",
        size: "small",
        apiKey: env.UPSTASH_BOX_API_KEY,
      }),
    );
    expect(mockBoxInstance.files.write).toHaveBeenCalledTimes(2); // package.json, runner script
    expect(mockBoxInstance.exec.command).toHaveBeenCalledWith(
      "npm install --no-audit --no-fund",
    );
    expect(mockBoxInstance.exec.command).toHaveBeenCalledWith(
      "node pipeline-runner.mjs",
    );
    expect(mockBoxInstance.delete).toHaveBeenCalled();
  });

  it("marks document status as error if the runner script fails", async () => {
    const env = createMockEnv();
    mockBoxInstance.exec.command
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // npm install ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Script Error" }); // runner failed

    await dispatchDocumentProcessing(env, sampleJob);

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockUpdateChain.set).toHaveBeenCalledWith({ status: "error" });
    expect(mockBoxInstance.delete).toHaveBeenCalled();
  });

  it("marks document status as error and cleans up box if npm install throws", async () => {
    const env = createMockEnv();
    mockBoxInstance.exec.command.mockResolvedValueOnce({
      exitCode: 127,
      stdout: "",
      stderr: "npm not found",
    });

    await dispatchDocumentProcessing(env, sampleJob);

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockUpdateChain.set).toHaveBeenCalledWith({ status: "error" });
    expect(mockBoxInstance.delete).toHaveBeenCalled();
  });
});
