import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().max(10000),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const createQuerySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "Question is required")
    .max(4000, "Question cannot exceed 4000 characters"),
  projectId: z.string().trim().min(1).optional().nullable(),
  sessionId: z.string().trim().min(1).optional().nullable(),
  systemInstruction: z.string().trim().max(8000).optional().nullable(),
  systemPrompt: z.string().trim().max(8000).optional().nullable(),
  stream: z.boolean().optional(),
  history: z.array(chatMessageSchema).optional(),
});

export const listQueriesQuerySchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).default(20).optional(),
  before: z.string().optional(),
  offset: z.coerce.number().min(0).optional(),
});

export const queryIdParamSchema = z.object({
  id: z.string().min(1, "Query ID is required"),
});

export type CreateQueryInput = z.infer<typeof createQuerySchema>;
