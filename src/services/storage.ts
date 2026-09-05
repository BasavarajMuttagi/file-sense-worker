import { getPresignedUrl, remove } from "@tigrisdata/storage";

export interface TigrisEnv {
  TIGRIS_STORAGE_ACCESS_KEY_ID?: string;
  TIGRIS_STORAGE_SECRET_ACCESS_KEY?: string;
  TIGRIS_STORAGE_ENDPOINT?: string;
  TIGRIS_BUCKET_NAME?: string;
}

export function getTigrisConfig(env: TigrisEnv) {
  return {
    accessKeyId: env.TIGRIS_STORAGE_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.TIGRIS_STORAGE_SECRET_ACCESS_KEY ?? "",
    endpoint: env.TIGRIS_STORAGE_ENDPOINT ?? "https://t3.storage.dev",
    bucket: env.TIGRIS_BUCKET_NAME ?? "filesense",
  };
}

export async function getStoragePresignedDownloadUrl(
  key: string,
  env: TigrisEnv,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const config = getTigrisConfig(env);
  try {
    const res = await getPresignedUrl(key, {
      operation: "get",
      expiresIn: expiresInSeconds,
      config,
    });
    if (res.error) {
      console.warn("Failed to generate presigned download URL:", res.error);
      return null;
    }
    return res.data?.url ?? null;
  } catch (err) {
    console.error("Error generating presigned download URL:", err);
    return null;
  }
}

export async function removeStorageObject(key: string, env: TigrisEnv) {
  const config = getTigrisConfig(env);
  try {
    const res = await remove(key, { config });
    if (res.error) {
      console.warn("Tigris storage delete warning:", res.error);
    }
    return res;
  } catch (err) {
    console.error("Failed to delete object from Tigris storage:", err);
    return null;
  }
}
