import { describe, expect, it } from "vitest";

import { getVectorIndex } from "../../src/services/vector.js";

describe("Vector Service", () => {
  it("creates and caches Index instance for the same URL", () => {
    const env1 = {
      UPSTASH_VECTOR_REST_URL: "https://first-vector.upstash.io",
      UPSTASH_VECTOR_REST_TOKEN: "token-1",
    };

    const index1 = getVectorIndex(env1);
    const index2 = getVectorIndex(env1);

    expect(index1).toBeDefined();
    expect(index1).toBe(index2);
  });

  it("recreates Index instance when URL changes", () => {
    const env1 = {
      UPSTASH_VECTOR_REST_URL: "https://url-a.upstash.io",
      UPSTASH_VECTOR_REST_TOKEN: "token-a",
    };

    const env2 = {
      UPSTASH_VECTOR_REST_URL: "https://url-b.upstash.io",
      UPSTASH_VECTOR_REST_TOKEN: "token-b",
    };

    const indexA = getVectorIndex(env1);
    const indexB = getVectorIndex(env2);

    expect(indexA).not.toBe(indexB);
  });
});
