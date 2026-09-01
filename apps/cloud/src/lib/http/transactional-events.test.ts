import type { ResolvedConsumerApiKey } from "@/lib/consumer-data";
import type { TransactionalEventRepository } from "@/lib/transactional-events";
import { describe, expect, it, vi } from "vitest";

import { createTransactionalEventHandler } from "./transactional-events";

const credential: ResolvedConsumerApiKey = {
  id: "00000000-0000-4000-8000-000000000021",
  tenantId: "00000000-0000-4000-8000-000000000001",
  keyId: "abcdefghijklmnop",
  keyDigest: "a".repeat(64),
  digestVersion: 1,
  scopes: ["anytype.chats.read"],
  connectorIds: ["00000000-0000-4000-8000-000000000011"],
  expiresAt: null,
  revokedAt: null,
  requestsPerMinute: 60,
  requestsPerDay: 10_000,
};

function request(extra: Record<string, unknown> = {}) {
  return new Request("https://knot.example/api/v1/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    body: JSON.stringify({
      protocolVersion: "1.0",
      connectorId: credential.connectorIds[0],
      idempotencyKey: "event-idempotency-0001",
      createdAt: 1_788_192_000,
      occurredAt: 1_788_192_000,
      eventType: "channel.message.available",
      channelOrigin: { spaceId: "space", chatId: "chat", messageId: "message" },
      ...extra,
    }),
  });
}

describe("transactional event ingress", () => {
  it("accepts only a pointer from a scoped connector-bound credential", async () => {
    const enqueue = vi.fn(async () => ({
      eventId: "00000000-0000-4000-8000-000000000031",
      created: true,
    }));
    const handler = createTransactionalEventHandler({
      events: { enqueue } as unknown as TransactionalEventRepository,
      authenticate: async () => credential,
      now: () => new Date(1_788_192_000_000),
    });
    const response = await handler(request());
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: credential.tenantId,
        values: expect.objectContaining({
          channelOrigin: {
            spaceId: "space",
            chatId: "chat",
            messageId: "message",
          },
        }),
      }),
    );
  });

  it("rejects Cloud-asserted participant identity and missing scope", async () => {
    const handler = createTransactionalEventHandler({
      events: {} as TransactionalEventRepository,
      authenticate: async () => ({ ...credential, scopes: [] }),
      now: () => new Date(1_788_192_000_000),
    });
    expect((await handler(request())).status).toBe(403);

    const scoped = createTransactionalEventHandler({
      events: {} as TransactionalEventRepository,
      authenticate: async () => credential,
      now: () => new Date(1_788_192_000_000),
    });
    expect(
      (
        await scoped(
          request({
            channelOrigin: {
              spaceId: "space",
              chatId: "chat",
              messageId: "message",
              participantId: "forged",
            },
          }),
        )
      ).status,
    ).toBe(400);
  });
});
