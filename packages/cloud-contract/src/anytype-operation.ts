import { z } from "zod";

import {
  idempotencyKeySchema,
  opaqueIdSchema,
  sha256Schema,
  unixSecondsSchema,
} from "./identifiers.js";
import { protocolVersion, type ScopeName } from "./protocol.js";

export const propertyValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string().max(100_000),
  z.array(z.string().max(2_000)).max(1_000),
  z.null(),
]);

const forbiddenPropertyKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
export const objectPropertiesSchema = z
  .record(z.string().max(200), propertyValueSchema)
  .refine((value) => Object.keys(value).length <= 1_000, "Too many properties")
  .refine(
    (value) =>
      Object.keys(value).every((key) => !forbiddenPropertyKeys.has(key)),
    "Reserved property key",
  );

export const anytypeOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("object.read"),
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
  }),
  z.object({
    type: z.literal("object.query"),
    spaceId: opaqueIdSchema,
    typeKey: z.string().trim().min(1).max(200).optional(),
    text: z.string().trim().max(2_000).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    type: z.literal("object.create"),
    spaceId: opaqueIdSchema,
    typeKey: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(500),
    properties: objectPropertiesSchema.default({}),
  }),
  z.object({
    type: z.literal("object.update"),
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
    properties: objectPropertiesSchema,
  }),
  z.object({
    type: z.literal("object.archive"),
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
  }),
  z.object({
    type: z.literal("collection.read"),
    spaceId: opaqueIdSchema,
    collectionId: opaqueIdSchema,
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,512}$/u)
      .optional(),
  }),
  z.object({
    type: z.enum(["collection.members.add", "collection.members.remove"]),
    spaceId: opaqueIdSchema,
    collectionId: opaqueIdSchema,
    objectIds: z.array(opaqueIdSchema).min(1).max(100),
  }),
  z.object({
    type: z.literal("file.upload"),
    spaceId: opaqueIdSchema,
    assetDigest: sha256Schema,
    name: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal("file.download"),
    spaceId: opaqueIdSchema,
    fileId: opaqueIdSchema,
  }),
  z.object({
    type: z.literal("file.attach"),
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
    assetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    name: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal("chat.read"),
    spaceId: opaqueIdSchema,
    chatId: opaqueIdSchema,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    type: z.literal("chat.send"),
    spaceId: opaqueIdSchema,
    chatId: opaqueIdSchema,
    message: z.string().min(1).max(100_000),
  }),
]);

export const anytypeOperationRequestSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    connectorId: opaqueIdSchema,
    idempotencyKey: idempotencyKeySchema,
    createdAt: unixSecondsSchema,
    expiresAt: unixSecondsSchema,
    operation: anytypeOperationSchema,
  })
  .refine(
    (value) =>
      value.expiresAt >= value.createdAt &&
      value.expiresAt - value.createdAt <= 24 * 60 * 60,
    "Operation expiry must be within 24 hours of creation",
  );

export type AnytypeOperation = z.infer<typeof anytypeOperationSchema>;
export type AnytypeOperationRequest = z.infer<
  typeof anytypeOperationRequestSchema
>;

export function requiredScopeForAnytypeOperation(
  operation: AnytypeOperation,
): ScopeName {
  switch (operation.type) {
    case "object.read":
    case "object.query":
      return "anytype.objects.read";
    case "object.create":
    case "object.update":
    case "object.archive":
      return "anytype.objects.write";
    case "collection.read":
      return "anytype.collections.read";
    case "collection.members.add":
    case "collection.members.remove":
      return "anytype.collections.write";
    case "file.download":
      return "anytype.files.read";
    case "file.upload":
    case "file.attach":
      return "anytype.files.write";
    case "chat.read":
      return "anytype.chats.read";
    case "chat.send":
      return "anytype.chats.send";
  }
}
