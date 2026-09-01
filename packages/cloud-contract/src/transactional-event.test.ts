import { describe, expect, it } from "vitest";

import {
  canonicalWebhookDelivery,
  transactionalEventCreateSchema,
  transactionalEventEnvelopeSchema,
} from "./transactional-event.js";

describe("transactional event contract", () => {
  it("keeps channel origin as a bounded pointer without asserted identity", () => {
    const value = transactionalEventCreateSchema.parse({
      protocolVersion: "1.0",
      connectorId: "00000000-0000-4000-8000-000000000011",
      idempotencyKey: "event-idempotency-0001",
      createdAt: 1_788_192_000,
      occurredAt: 1_788_192_000,
      eventType: "channel.message.available",
      channelOrigin: { spaceId: "space", chatId: "chat", messageId: "message" },
    });
    expect(value.channelOrigin).toEqual({
      spaceId: "space",
      chatId: "chat",
      messageId: "message",
    });
    expect(() =>
      transactionalEventCreateSchema.parse({
        ...value,
        channelOrigin: {
          ...value.channelOrigin,
          participantId: "cloud-asserted",
        },
      }),
    ).toThrow();
  });

  it("canonically binds a delivery signature to its fence and body", () => {
    const body = transactionalEventEnvelopeSchema.parse({
      protocolVersion: "1.0",
      deliveryId: "00000000-0000-4000-8000-000000000031",
      eventId: "00000000-0000-4000-8000-000000000021",
      eventType: "channel.message.available",
      occurredAt: 1_788_192_000,
      attempt: 2,
      channelOrigin: { spaceId: "space", chatId: "chat", messageId: "message" },
    });
    const canonical = canonicalWebhookDelivery({
      timestamp: 1_788_192_001,
      deliveryId: body.deliveryId,
      body,
    });
    expect(canonical).toContain(body.deliveryId);
    expect(canonical).toContain('"attempt":2');
  });
});
