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
      transaction`WITH authorized AS (
        SELECT count(*)::int AS count FROM connectors
        WHERE tenant_id=${input.tenantId}::uuid
          AND id=ANY(${input.values.connectorIds}::uuid[])
      ), inserted AS (
      INSERT INTO webhook_subscriptions(
        tenant_id,name,destination_name,event_types,connector_ids,created_by
      ) SELECT
        ${input.tenantId}::uuid,${input.values.name},${input.values.destinationName},
        ${input.values.eventTypes}::text[],${input.values.connectorIds}::uuid[],${input.userId}::uuid
      FROM authorized WHERE count=${input.values.connectorIds.length}
      RETURNING id,name,destination_name,event_types,connector_ids,active,created_at
      ), audited AS (
        INSERT INTO audit_events(
          tenant_id,principal_kind,principal_id,action,target_kind,target_id,outcome,metadata
        ) SELECT
          ${input.tenantId}::uuid,'human-session',${input.userId}::uuid,
          'webhook.subscription.create','webhook-subscription',inserted.id,'succeeded',
          jsonb_build_object('connectors',inserted.connector_ids)
        FROM inserted
      ) SELECT * FROM inserted`,
    ]);
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) throw new Error("connector-denied");
    return subscription(row);
  }

  async disableSubscription(
    input: Parameters<TransactionalEventRepository["disableSubscription"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`WITH updated AS (
        UPDATE webhook_subscriptions SET active=false,updated_at=now()
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.subscriptionId}::uuid AND active
        RETURNING id
      ), dead AS (
        UPDATE webhook_deliveries AS delivery
        SET state='dead-lettered',last_error_code='subscription-disabled',
          completed_at=now(),updated_at=now()
        FROM updated
        WHERE delivery.tenant_id=${input.tenantId}::uuid
          AND delivery.subscription_id=updated.id
          AND delivery.state IN ('pending','retrying')
        RETURNING delivery.id
      ), audited AS (
        INSERT INTO audit_events(
          tenant_id,principal_kind,principal_id,action,target_kind,target_id,outcome,metadata
        ) SELECT
          ${input.tenantId}::uuid,'human-session',${input.userId}::uuid,
          'webhook.subscription.disable',
          'webhook-subscription',updated.id,'succeeded','{}'::jsonb
        FROM updated
      ), dead_audited AS (
        INSERT INTO audit_events(
          tenant_id,principal_kind,principal_id,action,target_kind,target_id,outcome,metadata
        ) SELECT
          ${input.tenantId}::uuid,'human-session',${input.userId}::uuid,
          'webhook.delivery','webhook-delivery',dead.id,'dead-lettered','{}'::jsonb
        FROM dead
      ) SELECT id FROM updated`,
    ]);
    return (rows as unknown[]).length === 1;
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
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String(error.code) === "P0002"
      ) {
        const { TransactionalEventError } =
          await import("@/lib/transactional-events");
        throw new TransactionalEventError(
          "idempotency-conflict",
          "The idempotency key was used for another event",
        );
      }
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
