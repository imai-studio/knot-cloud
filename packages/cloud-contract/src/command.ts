import { z } from "zod";

import { anytypeOperationSchema } from "./anytype-operation.js";
import { opaqueIdSchema, unixSecondsSchema } from "./identifiers.js";
import { principalKindSchema, scopeNameSchema } from "./protocol.js";
import { publicationControlOperationSchema } from "./publication.js";

export const commandStateSchema = z.enum([
  "pending",
  "leased",
  "succeeded",
  "rejected-by-local-policy",
  "failed",
  "expired",
  "cancelled",
  "dead-lettered",
]);

export const commandPayloadSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("anytype"), operation: anytypeOperationSchema }),
  z.object({
    domain: z.literal("publication"),
    operation: publicationControlOperationSchema,
  }),
]);

export const commandEnvelopeSchema = z
  .object({
    protocolVersion: z.literal("1.0"),
    commandId: opaqueIdSchema,
    connectorId: opaqueIdSchema,
    requiredScope: scopeNameSchema,
    createdBy: principalKindSchema,
    createdAt: unixSecondsSchema,
    notBefore: unixSecondsSchema,
    expiresAt: unixSecondsSchema,
    attempt: z.number().int().positive(),
    leaseToken: z.string().min(32).max(200),
    leaseExpiresAt: unixSecondsSchema,
    payload: commandPayloadSchema,
  })
  .superRefine((value, context) => {
    const maximumLifetimeSeconds = 7 * 24 * 60 * 60;
    if (
      value.createdAt > value.notBefore ||
      value.notBefore > value.leaseExpiresAt ||
      value.leaseExpiresAt > value.expiresAt ||
      value.expiresAt - value.createdAt > maximumLifetimeSeconds
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Command timestamps are out of order or exceed the maximum lifetime",
      });
    }
  });

export const commandResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("succeeded"), result: z.unknown() }),
  z.object({
    outcome: z.literal("rejected-by-local-policy"),
    reasonCode: z.string().min(1).max(200),
  }),
  z.object({
    outcome: z.literal("failed"),
    retryable: z.boolean(),
    errorCode: z.string().min(1).max(200),
  }),
]);

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
