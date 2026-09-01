import { createHash, randomBytes } from "node:crypto";

import {
  protocolVersion,
  transactionalEventEnvelopeSchema,
  webhookSubscriptionSchema,
  type WebhookSubscription,
} from "@imai/knot-cloud-contract";

import type {
  ClaimedWebhookDelivery,
  TransactionalEventRepository,
} from "@/lib/transactional-events";
import { TransactionalEventError } from "@/lib/transactional-events";

import { ensureRuntimeDatabaseRole, getSql, withTenant } from "./neon";

function seconds(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

function subscription(row: Record<string, unknown>): WebhookSubscription {
  return webhookSubscriptionSchema.parse({
    id: row.id,
    name: row.name,
    destinationName: row.destination_name,
    eventTypes: row.event_types,
    connectorIds: row.connector_ids,
    active: row.active,
    createdAt: seconds(row.created_at as Date),
  });
}

export class NeonTransactionalEventRepository implements TransactionalEventRepository {
  async listSubscriptions(tenantId: string): Promise<WebhookSubscription[]> {
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`SELECT id,name,destination_name,event_types,connector_ids,active,created_at
        FROM webhook_subscriptions WHERE tenant_id=${tenantId}::uuid ORDER BY created_at DESC,id`,
    ]);
    return (rows as Record<string, unknown>[]).map(subscription);
  }

  async createSubscription(
    input: Parameters<TransactionalEventRepository["createSubscription"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`SELECT status, subscription_id AS id,
          subscription_name AS name, destination_name, event_types,
          connector_ids, active, created_at
        FROM create_webhook_subscription(
          ${input.tenantId}::uuid,${input.userId}::uuid,${input.values.name},
          ${input.values.destinationName},${input.values.eventTypes}::text[],
          ${input.values.connectorIds}::uuid[],${input.activeLimit}
        )`,
    ]);
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) throw new Error("Subscription creation returned no result");
    const status = String(row.status);
    if (status !== "created") {
      const messages = {
        "connector-denied": "A connector is not available in this workspace",
        "duplicate-subscription":
          "An equivalent active webhook subscription already exists",
        "subscription-name-conflict":
          "A webhook subscription already uses this name",
        "subscription-limit-exceeded":
          "The active webhook subscription limit has been reached",
      } as const;
      const code = status as keyof typeof messages;
      throw new TransactionalEventError(code, messages[code]);
    }
    return subscription(row);
  }

  async disableSubscription(
    input: Parameters<TransactionalEventRepository["disableSubscription"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`SELECT disable_webhook_subscription(
        ${input.tenantId}::uuid,${input.userId}::uuid,
        ${input.subscriptionId}::uuid
      ) AS disabled`,
    ]);
    return Boolean((rows[0] as { disabled?: boolean } | undefined)?.disabled);
  }

  async enqueue(input: Parameters<TransactionalEventRepository["enqueue"]>[0]) {
    try {
      const value = input.values;
      const [rows = []] = await withTenant(input.tenantId, (transaction) => [
        transaction`SELECT * FROM enqueue_transactional_event(
          ${input.tenantId}::uuid,${input.apiKeyId}::uuid,${value.connectorId}::uuid,
          ${value.idempotencyKey},${input.requestSha256},${value.eventType},
          ${value.channelOrigin.spaceId},${value.channelOrigin.chatId},
          ${value.channelOrigin.messageId},${new Date(value.occurredAt * 1000)}
        )`,
      ]);
      const row = rows[0] as
        { event_id: string; was_created: boolean } | undefined;
      if (!row) throw new Error("Event enqueue returned no row");
      return { eventId: row.event_id, created: row.was_created };
    } catch (error) {
      const databaseCode =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : undefined;
      const message = error instanceof Error ? error.message : "";
      if (databaseCode === "P0002") {
        throw new TransactionalEventError(
          "idempotency-conflict",
          "The idempotency key was used for another event",
        );
      }
      if (databaseCode === "P0001") {
        throw new TransactionalEventError(
          "quota-exceeded",
          "API key quota exceeded",
        );
      }
      if (databaseCode === "28000")
        throw new TransactionalEventError(
          "authentication-required",
          "The consumer API key is inactive",
        );
      if (databaseCode === "42501" && message.includes("scope"))
        throw new TransactionalEventError(
          "scope-denied",
          "API key scope denied",
        );
      if (databaseCode === "42501" && message.includes("Connector"))
        throw new TransactionalEventError(
          "connector-denied",
          "Connector binding denied",
        );
      throw error;
    }
  }

  async listDeliveryTenants(
    input: Parameters<TransactionalEventRepository["listDeliveryTenants"]>[0],
  ) {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql().query(
      "SELECT tenant_id FROM list_webhook_delivery_tenants($1,$2)",
      [input.now, input.limit],
    );
    return (rows as Array<{ tenant_id: string }>).map((row) => row.tenant_id);
  }

  async claim(input: Parameters<TransactionalEventRepository["claim"]>[0]) {
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseDigest = createHash("sha256").update(leaseToken).digest("hex");
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`SELECT * FROM claim_webhook_delivery(
        ${input.tenantId}::uuid,${input.now},${leaseDigest},${input.leaseSeconds}
      )`,
    ]);
    const row = rows[0] as
      | {
          delivery_id: string;
          subscription_id: string;
          destination_name: string;
          event_id: string;
          event_type: "channel.message.available";
          connector_id: string;
          origin_space_id: string;
          origin_chat_id: string;
          origin_message_id: string;
          occurred_at: Date;
          attempt: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      tenantId: input.tenantId,
      subscriptionId: row.subscription_id,
      destinationName: row.destination_name,
      deliveryId: row.delivery_id,
      attempt: row.attempt,
      leaseToken,
      envelope: transactionalEventEnvelopeSchema.parse({
        protocolVersion,
        deliveryId: row.delivery_id,
        eventId: row.event_id,
        eventType: row.event_type,
        occurredAt: seconds(row.occurred_at),
        attempt: row.attempt,
        channelOrigin: {
          spaceId: row.origin_space_id,
          chatId: row.origin_chat_id,
          messageId: row.origin_message_id,
        },
      }),
    } satisfies ClaimedWebhookDelivery;
  }

  async complete(
    input: Parameters<TransactionalEventRepository["complete"]>[0],
  ) {
    const digest = createHash("sha256")
      .update(input.delivery.leaseToken)
      .digest("hex");
    const [rows = []] = await withTenant(
      input.delivery.tenantId,
      (transaction) => [
        transaction`SELECT complete_webhook_delivery(
        ${input.delivery.tenantId}::uuid,${input.delivery.deliveryId}::uuid,
        ${input.delivery.attempt},${digest},${input.now},${input.success},${input.retryable},
        ${input.responseStatus ?? null},${input.responseSha256 ?? null},${input.errorCode ?? null}
      ) AS state`,
      ],
    );
    const state = (
      rows[0] as
        { state: "succeeded" | "retrying" | "dead-lettered" } | undefined
    )?.state;
    if (!state) throw new Error("Delivery completion returned no state");
    return state;
  }
}
