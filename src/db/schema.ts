import { sql } from "drizzle-orm";
import { defineRelations } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// ==========================================
// 1. Projects Table
// ==========================================
export const projects = sqliteTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("projects_user_id_idx").on(table.userId),
    index("projects_created_at_idx").on(table.createdAt),
  ],
);

// ==========================================
// 2. Documents Table
// ==========================================
export const documents = sqliteTable(
  "documents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    storageUrl: text("storage_url"),
    chunkCount: integer("chunk_count").default(0).notNull(),
    status: text("status", { enum: ["created", "processing", "processed", "error"] })
      .default("created")
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("documents_project_id_idx").on(table.projectId),
    index("documents_created_at_idx").on(table.createdAt),
    index("documents_status_idx").on(table.status),
  ],
);

// ==========================================
// 3. Queries Table
// ==========================================
export const queries = sqliteTable(
  "queries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    sessionId: text("session_id"),
    question: text("question").notNull(),
    answer: text("answer"),
    sources: text("sources", { mode: "json" }).$type<
      Array<{
        title: string;
        fileName: string;
        chunkIndex: number;
        text: string;
        score: number;
        pageStart?: number | null;
        pageEnd?: number | null;
      }>
    >(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("queries_user_id_idx").on(table.userId),
    index("queries_project_id_idx").on(table.projectId),
    index("queries_session_id_idx").on(table.sessionId),
    index("queries_created_at_idx").on(table.createdAt),
  ],
);

// ==========================================
// 4. Relations (Drizzle v1 syntax)
// ==========================================
export const relations = defineRelations(
  { projects, documents, queries },
  (r) => ({
    projects: {
      documents: r.many.documents(),
      queries: r.many.queries(),
    },
    documents: {
      project: r.one.projects({
        from: r.documents.projectId,
        to: r.projects.id,
      }),
    },
    queries: {
      project: r.one.projects({
        from: r.queries.projectId,
        to: r.projects.id,
      }),
    },
  }),
);

// ==========================================
// 5. TypeScript Inferred Types
// ==========================================
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

export type Query = typeof queries.$inferSelect;
export type NewQuery = typeof queries.$inferInsert;
