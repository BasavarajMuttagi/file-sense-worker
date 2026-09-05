import { z } from "zod";

export const createQuerySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "Question is required")
    .max(2000, "Question cannot exceed 2000 characters"),
  projectId: z.string().trim().min(1).optional().nullable(),
});

export const listQueriesQuerySchema = z.object({
  projectId: z.string().trim().min(1).optional(),
});

export const queryIdParamSchema = z.object({
  id: z.string().min(1, "Query ID is required"),
});

export type CreateQueryInput = z.infer<typeof createQuerySchema>;
