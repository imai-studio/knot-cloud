import { z } from "zod";

export const scopeNameSchema = z.enum([
  "anytype.objects.read",
  "anytype.objects.write",
  "anytype.collections.write",
  "anytype.files.write",
  "anytype.chats.read",
  "anytype.chats.write",
  "publications.write",
  "publications.unpublish",
]);

import { opaqueIdSchema } from "./identifiers.js";

export const protocolVersion = "1.0" as const;
export const minimumProtocolVersion = protocolVersion;
export const maximumProtocolVersion = protocolVersion;

export const protocolMetaSchema = z.object({
  product: z.literal("knot-cloud"),
  minimumProtocolVersion: z.string(),
  maximumProtocolVersion: z.string(),
  serverUnixSeconds: z.number().int().nonnegative(),
});

export type ProtocolMeta = z.infer<typeof protocolMetaSchema>;

export const principalKindSchema = z.enum([
  "human-session",
  "connector-key",
  "consumer-api-key",
  "first-party-service",
]);

export const attestedProvenanceSchema = z.object({
  kind: z.literal("connector-attested-anytype"),
  connectorId: opaqueIdSchema,
  senderDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  spaceId: opaqueIdSchema,
  objectId: opaqueIdSchema.optional(),
  messageId: opaqueIdSchema.optional(),
});

export type AttestedProvenance = z.infer<typeof attestedProvenanceSchema>;
