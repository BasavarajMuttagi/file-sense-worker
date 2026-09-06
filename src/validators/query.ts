import { z } from "zod";

export const createQuerySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "Question is required")
    .max(4000, "Question cannot exceed 4000 characters"),
  projectId: z.string().trim().min(1).optional().nullable(),
  systemInstruction: z.string().trim().max(8000).optional().nullable(),
  systemPrompt: z.string().trim().max(8000).optional().nullable(),
  stream: z.boolean().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().max(10000),
      }),
    )
    .optional(),
});

export const listQueriesQuerySchema = z.object({
  projectId: z.string().trim().min(1).optional(),
});

export const queryIdParamSchema = z.object({
  id: z.string().min(1, "Query ID is required"),
});

export type CreateQueryInput = z.infer<typeof createQuerySchema>;
