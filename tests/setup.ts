import { vi } from "vitest";
import type { MiddlewareHandler } from "hono";

import { MOCK_ENV } from "./fixtures/mock-env.js";
import { authState } from "./helpers/auth.js";

// Populate process.env with MOCK_ENV for Hono's Node.js runtime environment adapter
for (const [key, value] of Object.entries(MOCK_ENV)) {
  process.env[key] = value;
}

// Mock @clerk/hono globally with controllable authState
vi.mock("@clerk/hono", () => {
  return {
    clerkMiddleware: (): MiddlewareHandler => async (_c, next) => {
      await next();
    },
    getAuth: () => ({
      userId: authState.userId,
      sessionId: authState.sessionId,
      getToken: vi.fn().mockResolvedValue("mock-jwt-token"),
      claims: authState.userId ? { sub: authState.userId } : null,
    }),
  };
});
