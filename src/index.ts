import { clerkMiddleware } from "@clerk/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";

import documentsRoute from "./routes/documents.js";
import projectsRoute from "./routes/projects.js";
import queriesRoute from "./routes/queries.js";
import uploadRoute from "./routes/upload.js";
import webhooksRoute from "./routes/webhooks/tigris.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());
app.use("*", logger());
app.use("*", clerkMiddleware());

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("Worker error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.route("/projects", projectsRoute);
app.route("/documents", documentsRoute);
app.route("/api/upload", uploadRoute);
app.route("/webhooks/tigris", webhooksRoute);
app.route("/queries", queriesRoute);

app.get("/", (c) =>
  c.json({
    name: "FileSense API (Cloudflare Worker)",
    version: "1.0.0",
    endpoints: {
      health: "GET /health",
      projects:
        "GET /projects, POST /projects, GET /projects/:id, GET /projects/:id/documents, DELETE /projects/:id",
      documents:
        "GET /documents/:id, GET /documents/project/:projectId, DELETE /documents/:id",
      upload: "POST /api/upload",
      queries: "POST /queries, GET /queries, GET /queries/:id",
      webhook: "POST /webhooks/tigris",
    },
  }),
);

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
