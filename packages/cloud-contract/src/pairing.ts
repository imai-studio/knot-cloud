import { z } from "zod";

import { unixSecondsSchema } from "./identifiers.js";
import {
  protocolVersion,
  scopeNameSchema,
  type ScopeName,
} from "./protocol.js";

const uuidSchema = z.uuid();

export const connectorPublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u);

export const pairingPollTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43,200}$/u);

export const slugGrantSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("//"), "Slug grant is ambiguous")
  .refine((value) => {
    const exact = value.endsWith("/*") ? value.slice(0, -2) : value;
    return /^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/u.test(exact);
  }, "Slug grant is not canonical");

const uniqueScopesSchema = z
  .array(scopeNameSchema)
  .min(1)
  .max(scopeNameSchema.options.length)
  .refine(
    (values) => new Set(values).size === values.length,
    "Scopes must be unique",
  );

const uniqueSlugGrantsSchema = z
  .array(slugGrantSchema)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Slug grants must be unique",
  );

const uniqueSiteIdsSchema = z
  .array(uuidSchema)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Site grants must be unique",
  );

export const pairingSessionCreateSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    connectorName: z.string().trim().min(1).max(100),
    publicKey: connectorPublicKeySchema,
    requestedScopes: uniqueScopesSchema,
    requestedSiteIds: uniqueSiteIdsSchema.default([]),
    requestedSlugGrants: uniqueSlugGrantsSchema.default([]),
  })
  .strict();

export const pairingSessionCreatedSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    pairingId: uuidSchema,
    pollToken: pairingPollTokenSchema,
    authorizationUrl: z.url().refine((value) => isSecureOrLoopbackUrl(value), {
      message: "Authorization URL must use HTTPS or loopback HTTP",
    }),
    expiresAt: unixSecondsSchema,
    pollAfterSeconds: z.number().int().min(1).max(60),
  })
  .strict();

export const pairingSessionPollSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    pairingId: uuidSchema,
    pollToken: pairingPollTokenSchema,
  })
  .strict();

export const pairingGrantSchema = z
  .object({
    siteIds: uniqueSiteIdsSchema,
    scopes: uniqueScopesSchema,
    slugGrants: uniqueSlugGrantsSchema,
  })
  .strict();

export const pairingSessionStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(protocolVersion),
      status: z.literal("pending"),
      pairingId: uuidSchema,
      expiresAt: unixSecondsSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(protocolVersion),
      status: z.literal("approved"),
      pairingId: uuidSchema,
      connectorId: uuidSchema,
      tenantId: uuidSchema,
      grant: pairingGrantSchema,
      approvedAt: unixSecondsSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(protocolVersion),
      status: z.enum(["denied", "expired", "consumed"]),
      pairingId: uuidSchema,
    })
    .strict(),
]);

export const pairingApprovalSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    pairingId: uuidSchema,
    decision: z.literal("approve"),
    grant: pairingGrantSchema,
  })
  .strict();

export const pairingDenialSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    pairingId: uuidSchema,
    decision: z.literal("deny"),
  })
  .strict();

function isSecureOrLoopbackUrl(value: string): boolean {
  const parsed = new URL(value);
  return (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))
  );
}

export type PairingSessionCreate = z.infer<typeof pairingSessionCreateSchema>;
export type PairingSessionCreated = z.infer<typeof pairingSessionCreatedSchema>;
export type PairingSessionPoll = z.infer<typeof pairingSessionPollSchema>;
export type PairingGrant = z.infer<typeof pairingGrantSchema>;
export type PairingSessionStatus = z.infer<typeof pairingSessionStatusSchema>;
export type PairingScope = ScopeName;
