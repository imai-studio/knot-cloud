import { createHash, createHmac } from "node:crypto";

import {
  canonicalJson,
  canonicalWebhookDelivery,
  type JsonValue,
} from "@imai/knot-cloud-contract";

import type {
  ClaimedWebhookDelivery,
  TransactionalEventRepository,
} from "./transactional-events";

const maximumResponseBytes = 64 * 1024;

export class WebhookDeliveryWorker {
  constructor(
    private readonly repository: TransactionalEventRepository,
    private readonly destinations: ReadonlyMap<
      string,
      { url: string; secret: string }
    >,
    private readonly send: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async drainTenant(
    tenantId: string,
    limit = 20,
  ): Promise<{ delivered: number; retried: number; deadLettered: number }> {
    const totals = { delivered: 0, retried: 0, deadLettered: 0 };
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.repository.claim({
        tenantId,
        now: this.now(),
        leaseSeconds: 30,
      });
      if (!delivery) break;
      const state = await this.deliver(delivery);
      if (state === "succeeded") totals.delivered += 1;
      else if (state === "retrying") totals.retried += 1;
      else totals.deadLettered += 1;
    }
    return totals;
  }

  private async deliver(delivery: ClaimedWebhookDelivery) {
    const destination = this.destinations.get(delivery.destinationName);
    if (!destination)
      return this.repository.complete({
        delivery,
        now: this.now(),
        success: false,
        retryable: false,
        errorCode: "destination-removed",
      });
    const timestamp = Math.floor(this.now().getTime() / 1_000);
    const body = canonicalJson(delivery.envelope as unknown as JsonValue);
    const signature = createHmac("sha256", destination.secret)
      .update(
        canonicalWebhookDelivery({
          timestamp,
          deliveryId: delivery.deliveryId,
          body: delivery.envelope,
        }),
      )
      .digest("hex");
    try {
      const response = await this.send(destination.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Knot-Cloud-Webhook/1.0",
          "Knot-Delivery-Id": delivery.deliveryId,
          "Knot-Event-Id": delivery.envelope.eventId,
          "Knot-Timestamp": String(timestamp),
          "Knot-Signature": `v1=${signature}`,
        },
        body,
      });
      const responseBody = await readBoundedResponse(response);
      const responseSha256 = createHash("sha256")
        .update(responseBody.bytes)
        .digest("hex");
      if (responseBody.tooLarge)
        return this.repository.complete({
          delivery,
          now: this.now(),
          success: false,
          retryable: false,
          responseStatus: response.status,
          responseSha256,
          errorCode: "response-too-large",
        });
      const success = response.status >= 200 && response.status < 300;
      const retryable =
        [408, 409, 425, 429].includes(response.status) ||
        response.status >= 500;
      return this.repository.complete({
        delivery,
        now: this.now(),
        success,
        retryable,
        responseStatus: response.status,
        responseSha256,
        ...(!success ? { errorCode: `http-${response.status}` } : {}),
      });
    } catch {
      return this.repository.complete({
        delivery,
        now: this.now(),
        success: false,
        retryable: true,
        errorCode: "network-failure",
      });
    }
  }
}

async function readBoundedResponse(
  response: Response,
): Promise<{ bytes: Uint8Array; tooLarge: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), tooLarge: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (total + next.value.byteLength > maximumResponseBytes) {
      const remaining = maximumResponseBytes - total;
      if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
      await reader.cancel();
      return { bytes: concat(chunks), tooLarge: true };
    }
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  return { bytes: concat(chunks), tooLarge: false };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
