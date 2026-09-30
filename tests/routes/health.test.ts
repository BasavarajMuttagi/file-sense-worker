import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import app from "../../src/index.js";
import { MOCK_ENV } from "../fixtures/mock-env.js";

describe("Health & Root Routes", () => {
  it("GET /health returns 200 with status ok", async () => {
    const res = await app.request("/health", {}, MOCK_ENV);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { status: string; timestamp: string };
    expect(data.status).toBe("ok");
    expect(typeof data.timestamp).toBe("string");
  });

  it("GET / returns 200 with text File Sense!", async () => {
    const res = await app.request("/", {}, MOCK_ENV);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toBe("File Sense!");
  });

  it("GET /unknown-route returns 404 Not Found", async () => {
    const res = await app.request("/unknown-route", {}, MOCK_ENV);
    expect(res.status).toBe(404);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Not found");
  });

  it("formats HTTPException status and message correctly", async () => {
    const errorApp = new Hono();
    errorApp.onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: "Internal server error" }, 500);
    });

    errorApp.get("/fail-http", () => {
      throw new HTTPException(403, { message: "Forbidden Action" });
    });

    const res = await errorApp.request("/fail-http");
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Forbidden Action");
  });

  it("formats generic internal errors as 500", async () => {
    const errorApp = new Hono();
    errorApp.onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: "Internal server error" }, 500);
    });

    errorApp.get("/fail-generic", () => {
      throw new Error("Unexpected crash");
    });

    const res = await errorApp.request("/fail-generic");
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Internal server error");
  });
});
