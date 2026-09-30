import { UploadAction } from "@tigrisdata/storage";
import { z } from "zod";

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export const uploadSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  name: z.string().min(1, "File name is required"),
  // Only single uploads are supported; multipart uploads are explicitly rejected
  action: z
    .literal(UploadAction.SinglepartInit)
    .default(UploadAction.SinglepartInit),
  contentType: z.string().optional(),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(MAX_FILE_SIZE_BYTES, "File size cannot exceed 25MB")
    .optional(),
  size: z
    .number()
    .int()
    .positive()
    .max(MAX_FILE_SIZE_BYTES, "File size cannot exceed 25MB")
    .optional(),
});

export type UploadInput = z.infer<typeof uploadSchema>;
