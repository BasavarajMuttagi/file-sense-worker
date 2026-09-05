import { z } from "zod";

export const uploadSchema = z
  .object({
    projectId: z.string().min(1, "Project ID is required"),
    name: z.string().min(1, "File name is required"),
  })
  .passthrough();

export type UploadInput = z.infer<typeof uploadSchema>;
