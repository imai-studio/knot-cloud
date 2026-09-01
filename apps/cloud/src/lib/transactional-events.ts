import type {
  TransactionalEventCreate,
  TransactionalEventEnvelope,
  WebhookSubscription,
  WebhookSubscriptionCreate,
} from "@imai/knot-cloud-contract";

export class TransactionalEventError extends Error {
  constructor(
    readonly code:
      | "idempotency-conflict"
      | "destination-denied"
      | "connector-denied"
      | "scope-denied"
      | "invalid-request",
    message: string,
  ) {
    super(message);
  }
}

export interface ClaimedWebhookDelivery {
  tenantId: string;
  subscriptionId: string;
  destinationName: string;
  deliveryId: string;
  attempt: number;
  leaseToken: string;
  envelope: TransactionalEventEnvelope;
}

export interface TransactionalEventRepository {
  listSubscriptions(tenantId: string): Promise<WebhookSubscription[]>;
  createSubscription(input: {
    tenantId: string;
    userId: string;
    values: WebhookSubscriptionCreate;
  }): Promise<WebhookSubscription>;
  disableSubscription(input: {
    tenantId: string;
    userId: string;
    subscriptionId: string;
  }): Promise<boolean>;
  enqueue(input: {
    tenantId: string;
    apiKeyId: string;
    values: TransactionalEventCreate;
    requestSha256: string;
  }): Promise<{ eventId: string; created: boolean }>;
  listDeliveryTenants(input: { now: Date; limit: number }): Promise<string[]>;
  claim(input: {
    tenantId: string;
    now: Date;
    leaseSeconds: number;
  }): Promise<ClaimedWebhookDelivery | undefined>;
  complete(input: {
    delivery: ClaimedWebhookDelivery;
    now: Date;
    success: boolean;
    retryable: boolean;
    responseStatus?: number;
    responseSha256?: string;
    errorCode?: string;
  }): Promise<"succeeded" | "retrying" | "dead-lettered">;
}

const sensitiveKey =
  /(?:authorization|cookie|credential|key|password|secret|token)/iu;
const sensitiveText =
  /(?:bearer\s+[A-Za-z0-9._~-]+|knot_live_[A-Za-z0-9_-]+)/giu;

/** Redacts nested diagnostic values before they can cross an audit boundary. */
export function redactSensitiveText(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[REDACTED_DEPTH]";
  if (typeof value === "string")
    return value.replace(sensitiveText, "[REDACTED]");
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((entry) => redactSensitiveText(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [
        key,
        sensitiveKey.test(key)
          ? "[REDACTED]"
          : redactSensitiveText(entry, depth + 1),
      ]),
  );
}
