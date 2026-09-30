import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStoragePresignedDownloadUrl,
  getTigrisConfig,
  removeStorageObject,
} from "../../src/services/storage.js";

vi.mock("@tigrisdata/storage", () => ({
  getPresignedUrl: vi.fn(),
  remove: vi.fn(),
}));

import { getPresignedUrl, remove } from "@tigrisdata/storage";

describe("Storage Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getTigrisConfig", () => {
    it("uses default bucket and endpoint when environment variables are omitted", () => {
      const config = getTigrisConfig({});
      expect(config.bucket).toBe("filesense-bucket");
      expect(config.endpoint).toBe("https://t3.storage.dev");
      expect(config.accessKeyId).toBe("");
      expect(config.secretAccessKey).toBe("");
    });

    it("prefers TIGRIS_STORAGE_BUCKET over TIGRIS_BUCKET_NAME", () => {
      const config = getTigrisConfig({
        TIGRIS_STORAGE_BUCKET: "primary-bucket",
        TIGRIS_BUCKET_NAME: "fallback-bucket",
        TIGRIS_STORAGE_ENDPOINT: "https://custom.endpoint.com",
        TIGRIS_STORAGE_ACCESS_KEY_ID: "key_123",
        TIGRIS_STORAGE_SECRET_ACCESS_KEY: "secret_456",
      });

      expect(config.bucket).toBe("primary-bucket");
      expect(config.endpoint).toBe("https://custom.endpoint.com");
      expect(config.accessKeyId).toBe("key_123");
      expect(config.secretAccessKey).toBe("secret_456");
    });

    it("falls back to TIGRIS_BUCKET_NAME if TIGRIS_STORAGE_BUCKET is absent", () => {
      const config = getTigrisConfig({
        TIGRIS_BUCKET_NAME: "fallback-bucket",
      });
      expect(config.bucket).toBe("fallback-bucket");
    });
  });

  describe("getStoragePresignedDownloadUrl", () => {
    it("returns presigned URL when Tigris returns data successfully", async () => {
      vi.mocked(getPresignedUrl).mockResolvedValueOnce({
        data: { url: "https://t3.storage.dev/download/file.pdf?token=xyz" },
        error: null,
      } as unknown as Awaited<ReturnType<typeof getPresignedUrl>>);

      const url = await getStoragePresignedDownloadUrl("file.pdf", {
        TIGRIS_STORAGE_BUCKET: "my-bucket",
      });

      expect(url).toBe(
        "https://t3.storage.dev/download/file.pdf?token=xyz",
      );
      expect(getPresignedUrl).toHaveBeenCalledWith(
        "file.pdf",
        expect.objectContaining({
          operation: "get",
          expiresIn: 3600,
        }),
      );
    });

    it("returns null when Tigris returns an error", async () => {
      vi.mocked(getPresignedUrl).mockResolvedValueOnce({
        data: null,
        error: "Bucket not found",
      } as unknown as Awaited<ReturnType<typeof getPresignedUrl>>);

      const url = await getStoragePresignedDownloadUrl("file.pdf", {});
      expect(url).toBeNull();
    });

    it("catches exception and returns null", async () => {
      vi.mocked(getPresignedUrl).mockRejectedValueOnce(
        new Error("Network timeout"),
      );

      const url = await getStoragePresignedDownloadUrl("file.pdf", {});
      expect(url).toBeNull();
    });
  });

  describe("removeStorageObject", () => {
    it("calls remove on Tigris storage client and returns response", async () => {
      vi.mocked(remove).mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as unknown as Awaited<ReturnType<typeof remove>>);

      const res = await removeStorageObject("folder/file.pdf", {
        TIGRIS_STORAGE_BUCKET: "my-bucket",
      });

      expect(remove).toHaveBeenCalledWith(
        "folder/file.pdf",
        expect.objectContaining({
          config: expect.objectContaining({ bucket: "my-bucket" }),
        }),
      );
      expect(res).toEqual({ data: { success: true }, error: null });
    });

    it("catches exception and returns null", async () => {
      vi.mocked(remove).mockRejectedValueOnce(new Error("Permission denied"));

      const res = await removeStorageObject("folder/file.pdf", {});
      expect(res).toBeNull();
    });
  });
});
