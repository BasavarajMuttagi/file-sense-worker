import { drizzle } from "drizzle-orm/libsql";
import { type Mock, vi } from "vitest";

import type { getDb } from "../../src/db/index.js";
import { relations } from "../../src/db/schema.js";

export type DbClient = ReturnType<typeof getDb>;

export type ChainableMethod =
  | "from"
  | "where"
  | "leftJoin"
  | "innerJoin"
  | "groupBy"
  | "orderBy"
  | "limit"
  | "offset"
  | "values"
  | "set"
  | "returning";

export interface MockChain<T> extends Promise<T> {
  from: Mock<(...args: any[]) => MockChain<T>>;
  where: Mock<(...args: any[]) => MockChain<T>>;
  leftJoin: Mock<(...args: any[]) => MockChain<T>>;
  innerJoin: Mock<(...args: any[]) => MockChain<T>>;
  groupBy: Mock<(...args: any[]) => MockChain<T>>;
  orderBy: Mock<(...args: any[]) => MockChain<T>>;
  limit: Mock<(...args: any[]) => MockChain<T>>;
  offset: Mock<(...args: any[]) => MockChain<T>>;
  values: Mock<(...args: any[]) => MockChain<T>>;
  set: Mock<(...args: any[]) => MockChain<T>>;
  returning: Mock<(...args: any[]) => MockChain<T>>;
}

const CHAINABLE_METHODS: readonly ChainableMethod[] = [
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
] as const;

export function createChainable<T>(defaultResolvedValue: T): MockChain<T> {
  const promise = Promise.resolve(defaultResolvedValue) as MockChain<T>;

  for (const method of CHAINABLE_METHODS) {
    (promise as any)[method] = vi.fn().mockReturnValue(promise);
  }

  return promise;
}

export function createMockDb(): DbClient & {
  select: Mock<(...args: any[]) => MockChain<any>>;
  insert: Mock<(...args: any[]) => MockChain<any>>;
  update: Mock<(...args: any[]) => MockChain<any>>;
  delete: Mock<(...args: any[]) => MockChain<any>>;
} {
  const db = drizzle.mock({ relations });

  const select = vi.spyOn(db, "select").mockImplementation((() => createChainable([])) as any);
  const insert = vi.spyOn(db, "insert").mockImplementation((() => createChainable([])) as any);
  const update = vi.spyOn(db, "update").mockImplementation((() => createChainable({})) as any);
  const del = vi.spyOn(db, "delete").mockImplementation((() => createChainable({})) as any);

  return Object.assign(db, {
    select,
    insert,
    update,
    delete: del,
  }) as unknown as DbClient & {
    select: Mock<(...args: any[]) => MockChain<any>>;
    insert: Mock<(...args: any[]) => MockChain<any>>;
    update: Mock<(...args: any[]) => MockChain<any>>;
    delete: Mock<(...args: any[]) => MockChain<any>>;
  };
}
