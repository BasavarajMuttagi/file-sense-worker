import type { Index } from "@upstash/vector";
import { type Mock, vi } from "vitest";

export interface MockVectorIndex {
  delete: Mock<(...args: any[]) => Promise<any>>;
  query: Mock<(...args: any[]) => Promise<any>>;
  upsert: Mock<(...args: any[]) => Promise<any>>;
}

export function createMockVectorIndex(
  overrides?: Partial<MockVectorIndex>,
): Index & MockVectorIndex {
  const mock: MockVectorIndex = {
    delete: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return mock as Index & MockVectorIndex;
}
