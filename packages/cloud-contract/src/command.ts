import { z } from "zod";

import {
  anytypeOperationSchema,
  requiredScopeForAnytypeOperation,
} from "./anytype-operation.js";
import { opaqueIdSchema, unixSecondsSchema } from "./identifiers.js";
import { anytypeOperationResultSchema } from "./operation-resource.js";
import {
  principalKindSchema,
  protocolVersion,
  scopeNameSchema,
} from "./protocol.js";
import {
  publicationControlOperationSchema,
  publicationControlResultSchema,
} from "./publication.js";

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

export const commandActorProvenanceSchema = z.enum([
  "authenticated-cloud-session",
  "connector-key",
  "consumer-api-key",
  "first-party-service",
  "unverified-legacy",
]);

export const commandActorSchema = z
  .object({
    principalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    digestVersion: z.number().int().positive(),
    provenance: commandActorProvenanceSchema,
  })
  .strict();

export const commandEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    commandId: z.uuid(),
    connectorId: opaqueIdSchema,
    requiredScope: scopeNameSchema,
    createdBy: principalKindSchema,
    actor: commandActorSchema,
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
    const expectedScope =
      value.payload.domain === "anytype"
        ? requiredScopeForAnytypeOperation(value.payload.operation)
        : value.payload.operation.type === "publication.unpublish"
          ? "publications.unpublish"
          : "publications.write";
    if (value.requiredScope !== expectedScope) {
      context.addIssue({
        code: "custom",
        message: `Command requires ${expectedScope}`,
      });
    }
    const expectedProvenance =
      value.createdBy === "human-session"
        ? "authenticated-cloud-session"
        : value.createdBy;
    const isLegacySentinel =
      value.actor.principalDigest === "0".repeat(64) &&
      value.actor.digestVersion === 1;
    if (value.actor.provenance === "unverified-legacy" && !isLegacySentinel) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Unverified legacy provenance requires the legacy sentinel",
      });
    } else if (
      value.actor.provenance !== "unverified-legacy" &&
      isLegacySentinel
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor", "provenance"],
        message: "The legacy sentinel requires unverified-legacy provenance",
      });
    } else if (
      value.actor.provenance !== "unverified-legacy" &&
      value.actor.provenance !== expectedProvenance
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor", "provenance"],
        message: `Command actor provenance must be ${expectedProvenance}`,
      });
    }
  });

export const commandResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("succeeded"),
      result: z.union([
        anytypeOperationResultSchema,
        publicationControlResultSchema,
      ]),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("rejected-by-local-policy"),
      reasonCode: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      retryable: z.boolean(),
      errorCode: z.string().min(1).max(200),
      retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
    })
    .superRefine((value, context) => {
      if (value.retryAfterSeconds !== undefined && !value.retryable) {
        context.addIssue({
          code: "custom",
          message: "retryAfterSeconds requires retryable to be true",
        });
      }
    })
    .strict(),
]);

export const commandClaimRequestSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    maximumCommands: z.literal(1).default(1),
    leaseSeconds: z.number().int().min(15).max(300).default(60),
  })
  .strict();

export const commandClaimResponseSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    commands: z.array(commandEnvelopeSchema).max(1),
    pollAfterSeconds: z.number().int().min(1).max(300),
  })
  .strict();

export const commandLeaseExtensionSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    commandId: z.uuid(),
    attempt: z.number().int().positive(),
    leaseToken: z.string().min(32).max(200),
    extendBySeconds: z.number().int().min(15).max(300),
  })
  .strict();

export const commandLeaseFenceSchema = z
  .object({
    attempt: z.number().int().positive(),
    leaseToken: z.string().min(32).max(200),
  })
  .strict();

export const commandLeaseExtendedSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    commandId: z.uuid(),
    attempt: z.number().int().positive(),
    leaseExpiresAt: unixSecondsSchema,
  })
  .strict();

export const commandResultSubmissionSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    commandId: z.uuid(),
    attempt: z.number().int().positive(),
    leaseToken: z.string().min(32).max(200),
    result: commandResultSchema,
  })
  .strict();

export const commandResultReceiptSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    commandId: z.uuid(),
    attempt: z.number().int().positive(),
    status: z.enum(["accepted", "duplicate"]),
    state: commandStateSchema,
  })
  .strict();

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type CommandClaimRequest = z.infer<typeof commandClaimRequestSchema>;
export type CommandClaimResponse = z.infer<typeof commandClaimResponseSchema>;
export type CommandLeaseExtension = z.infer<typeof commandLeaseExtensionSchema>;
export type CommandResultSubmission = z.infer<
  typeof commandResultSubmissionSchema
>;
export type CommandResultReceipt = z.infer<typeof commandResultReceiptSchema>;
