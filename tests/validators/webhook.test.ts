import { describe, expect, it } from "vitest";

import {
  tigrisNotificationEventSchema,
  tigrisWebhookSchema,
} from "../../src/validators/webhook.js";

describe("Webhook Validators", () => {
  it("validates valid Tigris webhook event array payload", () => {
    const valid = {
      events: [
        {
          eventName: "OBJECT_CREATED",
          object: {
            key: "user_1/projects/p_1/123-doc.pdf",
            size: 1024,
            eTag: "etag_xyz",
          },
        },
      ],
    };

    const result = tigrisWebhookSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toHaveLength(1);
      expect(result.data.events[0]?.eventName).toBe("OBJECT_CREATED");
      expect(result.data.events[0]?.object?.key).toBe("user_1/projects/p_1/123-doc.pdf");
      expect(result.data.events[0]?.object?.size).toBe(1024);
    }
  });

  it("accepts string sizes in object payload", () => {
    const result = tigrisNotificationEventSchema.safeParse({
      eventName: "OBJECT_CREATED",
      object: {
        key: "user_1/projects/p_1/123-doc.pdf",
        size: "2048",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.object?.size).toBe("2048");
    }
  });

  it("rejects payload missing events array", () => {
    const empty = tigrisWebhookSchema.safeParse({});
    expect(empty.success).toBe(false);

    const nonArray = tigrisWebhookSchema.safeParse({ events: "not-an-array" });
    expect(nonArray.success).toBe(false);
  });

  it("accepts empty events array", () => {
    const result = tigrisWebhookSchema.safeParse({ events: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toEqual([]);
    }
  });
});
