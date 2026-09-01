import { z } from "zod";

import { opaqueIdSchema, unixSecondsSchema } from "./identifiers.js";
import { scopeNameSchema } from "./protocol.js";

export const anytypeScopeSchema = scopeNameSchema.exclude([
  "publications.read",
  "publications.write",
  "publications.unpublish",
]);

export const consumerApiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(anytypeScopeSchema).min(1).max(11),
    connectorIds: z.array(z.uuid()).min(1).max(100),
    expiresAt: unixSecondsSchema.optional(),
    requestsPerMinute: z.number().int().min(1).max(1_000).default(60),
    requestsPerDay: z.number().int().min(1).max(1_000_000).default(10_000),
  })
  .strict()
  .transform((value) => ({
    ...value,
    scopes: [...new Set(value.scopes)],
    connectorIds: [...new Set(value.connectorIds)],
  }));

export const consumerApiKeyMetadataSchema = z
  .object({
    id: opaqueIdSchema,
    name: z.string().min(1).max(100),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    scopes: z.array(anytypeScopeSchema),
    connectorIds: z.array(opaqueIdSchema),
    expiresAt: unixSecondsSchema.nullable(),
    revokedAt: unixSecondsSchema.nullable(),
    createdAt: unixSecondsSchema,
    requestsPerMinute: z.number().int().min(1).max(1_000),
    requestsPerDay: z.number().int().min(1).max(1_000_000),
  })
  .strict();

export const consumerApiKeyCreatedSchema = z
  .object({
    apiKey: consumerApiKeyMetadataSchema,
    secret: z.string().startsWith("knot_live_").max(200),
  })
  .strict();

export const consumerApiKeyListSchema = z
  .object({ apiKeys: z.array(consumerApiKeyMetadataSchema).max(1_000) })
  .strict();

export type ConsumerApiKeyCreate = z.output<typeof consumerApiKeyCreateSchema>;
export type ConsumerApiKeyMetadata = z.infer<
  typeof consumerApiKeyMetadataSchema
>;
