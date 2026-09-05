import { Index } from "@upstash/vector";

let cachedIndex: Index | null = null;
let cachedUrl: string | null = null;

export function getVectorIndex(env: {
  UPSTASH_VECTOR_REST_URL: string;
  UPSTASH_VECTOR_REST_TOKEN: string;
}): Index {
  if (cachedIndex && cachedUrl === env.UPSTASH_VECTOR_REST_URL) {
    return cachedIndex;
  }
  cachedIndex = new Index({
    url: env.UPSTASH_VECTOR_REST_URL,
    token: env.UPSTASH_VECTOR_REST_TOKEN,
  });
  cachedUrl = env.UPSTASH_VECTOR_REST_URL;
  return cachedIndex;
}

export default getVectorIndex;
