import { z } from "zod";

import { canonicalJson, type JsonValue } from "./canonical-json.js";
import {
  idempotencyKeySchema,
  opaqueIdSchema,
  unixSecondsSchema,
} from "./identifiers.js";
import { protocolVersion } from "./protocol.js";

export const transactionalEventTypeSchema = z.enum([
  "channel.message.available",
]);

/**
 * An origin is deliberately only a lookup pointer. It never carries a display
 * name, participant ID, role, or an assertion that the sender is authorized.
 * A local connector must refetch this exact message from Anytype before using
 * it as authority.
 */
export const channelOriginPointerSchema = z
  .object({
    spaceId: opaqueIdSchema,
    chatId: opaqueIdSchema,
    messageId: opaqueIdSchema,
  })
  .strict();

export const transactionalEventCreateSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    connectorId: z.uuid(),
    idempotencyKey: idempotencyKeySchema,
    createdAt: unixSecondsSchema,
    occurredAt: unixSecondsSchema,
    eventType: transactionalEventTypeSchema,
    channelOrigin: channelOriginPointerSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.occurredAt <= value.createdAt &&
      value.createdAt - value.occurredAt <= 7 * 24 * 60 * 60,
    "Event occurrence must be no more than seven days before creation",
  );

export const transactionalEventAcceptedSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    eventId: z.uuid(),
    status: z.literal("accepted"),
    duplicate: z.boolean(),
  })
  .strict();

export const webhookSubscriptionCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    destinationName: z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u),
    eventTypes: z.array(transactionalEventTypeSchema).min(1).max(10),
    connectorIds: z.array(z.uuid()).min(1).max(100),
  })
  .strict()
  .transform((value) => ({
    ...value,
    eventTypes: [...new Set(value.eventTypes)],
    connectorIds: [...new Set(value.connectorIds)],
  }));

export const webhookSubscriptionSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(100),
    destinationName: z.string().min(1).max(64),
    eventTypes: z.array(transactionalEventTypeSchema).min(1).max(10),
    connectorIds: z.array(z.uuid()).min(1).max(100),
    active: z.boolean(),
    createdAt: unixSecondsSchema,
  })
  .strict();

export const webhookSubscriptionListSchema = z
  .object({ subscriptions: z.array(webhookSubscriptionSchema).max(1_000) })
  .strict();

export const transactionalEventEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    deliveryId: z.uuid(),
    eventId: z.uuid(),
    eventType: transactionalEventTypeSchema,
    occurredAt: unixSecondsSchema,
    attempt: z.number().int().min(1).max(20),
    channelOrigin: channelOriginPointerSchema,
  })
  .strict();

export const webhookSignatureScheme = "knot-webhook-hmac-sha256-v1" as const;

export function canonicalWebhookDelivery(input: {
  timestamp: number;
  deliveryId: string;
  body: z.infer<typeof transactionalEventEnvelopeSchema>;
}): string {
  const body = transactionalEventEnvelopeSchema.parse(input.body);
  return [
    webhookSignatureScheme,
    String(unixSecondsSchema.parse(input.timestamp)),
    z.uuid().parse(input.deliveryId),
    canonicalJson(body as unknown as JsonValue),
  ].join("\n");
}

export type ChannelOriginPointer = z.infer<typeof channelOriginPointerSchema>;
export type TransactionalEventCreate = z.infer<
  typeof transactionalEventCreateSchema
>;
export type TransactionalEventEnvelope = z.infer<
  typeof transactionalEventEnvelopeSchema
>;
export type WebhookSubscriptionCreate = z.output<
  typeof webhookSubscriptionCreateSchema
>;
export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>;
