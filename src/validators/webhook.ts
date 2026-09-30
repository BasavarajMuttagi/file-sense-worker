import { z } from "zod";

export type { NotificationEvent, NotificationResponse } from "@tigrisdata/storage";

export const tigrisNotificationEventSchema = z.object({
  eventName: z.string().optional(),
  object: z
    .object({
      key: z.string().optional(),
      size: z.union([z.number(), z.string()]).optional(),
      eTag: z.string().optional(),
    })
    .optional(),
});

export const tigrisWebhookSchema = z.object({
  events: z.array(tigrisNotificationEventSchema),
});

export type TigrisNotificationEvent = z.infer<typeof tigrisNotificationEventSchema>;
export type TigrisWebhookPayload = z.infer<typeof tigrisWebhookSchema>;
