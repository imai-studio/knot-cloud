import { createHmac } from "node:crypto";

import { canonicalWebhookDelivery } from "@imai/knot-cloud-contract";
import { describe, expect, it, vi } from "vitest";

import type {
  ClaimedWebhookDelivery,
  TransactionalEventRepository,
} from "./transactional-events";
import { redactSensitiveText } from "./transactional-events";
import { WebhookDeliveryWorker } from "./webhook-delivery";

const delivery: ClaimedWebhookDelivery = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  subscriptionId: "00000000-0000-4000-8000-000000000002",
  destinationName: "automation",
  deliveryId: "00000000-0000-4000-8000-000000000003",
  attempt: 1,
  leaseToken: "lease-token-never-leaves-the-repository",
  envelope: {
    protocolVersion: "1.0",
    deliveryId: "00000000-0000-4000-8000-000000000003",
    eventId: "00000000-0000-4000-8000-000000000004",
    eventType: "channel.message.available",
    occurredAt: 1_788_192_000,
    attempt: 1,
    channelOrigin: { spaceId: "space", chatId: "chat", messageId: "message" },
  },
};

function repository() {
  const complete = vi.fn(
    async (input: Parameters<TransactionalEventRepository["complete"]>[0]) =>
      input.success
        ? ("succeeded" as const)
        : input.retryable
          ? ("retrying" as const)
          : ("dead-lettered" as const),
  );
  let claimed = false;
  return {
    value: {
      claim: vi.fn(async () =>
        claimed ? undefined : ((claimed = true), delivery),
      ),
      complete,
    } as unknown as TransactionalEventRepository,
    complete,
  };
}

describe("webhook delivery worker", () => {
  it("delivers a signed bounded envelope only to a named deployment destination", async () => {
    const repo = repository();
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const signature = String(
          (init?.headers as Record<string, string>)["Knot-Signature"],
        );
        const expected = createHmac("sha256", "s".repeat(32))
          .update(
            canonicalWebhookDelivery({
              timestamp: 1_788_192_010,
              deliveryId: delivery.deliveryId,
              body: delivery.envelope,
            }),
          )
          .digest("hex");
        expect(signature).toBe(`v1=${expected}`);
        expect(init?.redirect).toBe("error");
        expect(String(init?.body)).not.toContain("participant");
        return new Response("ok", { status: 200 });
      },
    );
    const worker = new WebhookDeliveryWorker(
      repo.value,
      new Map([
        [
          "automation",
          { url: "https://hooks.example/events", secret: "s".repeat(32) },
        ],
      ]),
      send as typeof fetch,
      () => new Date(1_788_192_010_000),
    );
    await expect(worker.drainTenant(delivery.tenantId)).resolves.toEqual({
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries transient failure and dead-letters a removed named destination", async () => {
    const retryRepo = repository();
    const retryWorker = new WebhookDeliveryWorker(
      retryRepo.value,
      new Map([
        [
          "automation",
          { url: "https://hooks.example/events", secret: "s".repeat(32) },
        ],
      ]),
      vi.fn(async () => new Response("later", { status: 503 })) as typeof fetch,
    );
    await retryWorker.drainTenant(delivery.tenantId);
    expect(retryRepo.complete).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true, errorCode: "http-503" }),
    );

    const deadRepo = repository();
    const deadWorker = new WebhookDeliveryWorker(deadRepo.value, new Map());
    await deadWorker.drainTenant(delivery.tenantId);
    expect(deadRepo.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: false,
        errorCode: "destination-removed",
      }),
    );
  });

  it("recursively redacts credentials in nested diagnostics", () => {
    expect(
      redactSensitiveText({
        nested: [
          { Authorization: "Bearer abc.def", message: "knot_live_secret" },
        ],
      }),
    ).toEqual({
      nested: [{ Authorization: "[REDACTED]", message: "[REDACTED]" }],
    });
  });
});
