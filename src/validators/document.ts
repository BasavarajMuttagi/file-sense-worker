import { z } from "zod";

export const documentIdParamSchema = z.object({
  id: z.string().min(1, "Document ID is required"),
});

export const projectDocumentsParamSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
});
