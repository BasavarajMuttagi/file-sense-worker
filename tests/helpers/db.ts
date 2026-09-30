import { vi } from "vitest";

export interface MockDbQuery {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => Promise<unknown>;
}

export function createChainable(defaultResolvedValue: unknown = []) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "from",
    "where",
    "leftJoin",
    "innerJoin",
    "groupBy",
    "orderBy",
    "limit",
    "offset",
    "values",
    "set",
    "returning",
  ];

  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain.then = (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) =>
    Promise.resolve(defaultResolvedValue).then(resolve, reject);

  return chain;
}

export function createMockDb() {
  return {
    select: vi.fn(() => createChainable([])),
    insert: vi.fn(() => createChainable([])),
    update: vi.fn(() => createChainable({})),
    delete: vi.fn(() => createChainable({})),
  };
}
