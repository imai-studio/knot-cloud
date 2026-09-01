import { z } from "zod";

import {
  anytypeOperationSchema,
  objectPropertiesSchema,
} from "./anytype-operation.js";
import {
  opaqueIdSchema,
  sha256Schema,
  unixSecondsSchema,
} from "./identifiers.js";
import { pageCursorSchema } from "./pagination.js";
import { problemDetailsSchema } from "./problem.js";
import { attestedProvenanceSchema, protocolVersion } from "./protocol.js";

export const anytypeObjectSnapshotSchema = z
  .object({
    spaceId: opaqueIdSchema,
    objectId: opaqueIdSchema,
    typeKey: z.string().trim().min(1).max(200),
    name: z.string().max(500),
    properties: objectPropertiesSchema,
    provenance: attestedProvenanceSchema,
  })
  .strict();

const objectResultSchema = (
  type: "object.read" | "object.create" | "object.update",
) =>
  z
    .object({
      type: z.literal(type),
      object: anytypeObjectSnapshotSchema,
    })
    .strict();

const chatMessageSchema = z
  .object({
    messageId: opaqueIdSchema,
    text: z.string().max(100_000),
    sentAt: unixSecondsSchema,
    senderDigest: sha256Schema,
    provenance: attestedProvenanceSchema,
  })
  .strict();

export const anytypeOperationResultSchema = z.discriminatedUnion("type", [
  objectResultSchema("object.read"),
  z
    .object({
      type: z.literal("object.query"),
      objects: z.array(anytypeObjectSnapshotSchema).max(100),
      nextCursor: pageCursorSchema.optional(),
    })
    .strict(),
  objectResultSchema("object.create"),
  objectResultSchema("object.update"),
  z
    .object({
      type: z.literal("object.archive"),
      spaceId: opaqueIdSchema,
      objectId: opaqueIdSchema,
      archived: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("collection.read"),
      spaceId: opaqueIdSchema,
      collectionId: opaqueIdSchema,
      objectIds: z.array(opaqueIdSchema).max(100),
      nextCursor: pageCursorSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["collection.members.add", "collection.members.remove"]),
      spaceId: opaqueIdSchema,
      collectionId: opaqueIdSchema,
      objectIds: z.array(opaqueIdSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("file.upload"),
      spaceId: opaqueIdSchema,
      fileId: opaqueIdSchema,
      assetDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("file.download"),
      spaceId: opaqueIdSchema,
      fileId: opaqueIdSchema,
      assetDigest: sha256Schema,
      name: z.string().trim().min(1).max(500),
      contentType: z.string().trim().min(3).max(200),
      byteSize: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("file.attach"),
      spaceId: opaqueIdSchema,
      objectId: opaqueIdSchema,
      fileId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.read"),
      spaceId: opaqueIdSchema,
      chatId: opaqueIdSchema,
      messages: z.array(chatMessageSchema).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.send"),
      spaceId: opaqueIdSchema,
      chatId: opaqueIdSchema,
      messageId: opaqueIdSchema,
      sentAt: unixSecondsSchema,
    })
    .strict(),
]);

const operationResourceBaseShape = {
  protocolVersion: z.literal(protocolVersion),
  operationId: opaqueIdSchema,
  connectorId: opaqueIdSchema,
  operation: anytypeOperationSchema,
  createdAt: unixSecondsSchema,
  expiresAt: unixSecondsSchema,
};

const operationSubmissionStateSchema = z.enum([
  "pending",
  "leased",
  "succeeded",
  "rejected-by-local-policy",
  "failed",
  "expired",
  "cancelled",
  "dead-lettered",
]);

export const operationAcceptedSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    operationId: opaqueIdSchema,
    status: operationSubmissionStateSchema,
    statusUrl: z.string().startsWith("/api/v1/operations/"),
    createdAt: unixSecondsSchema,
    expiresAt: unixSecondsSchema,
  })
  .strict();

export const operationResourceSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...operationResourceBaseShape,
      status: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      ...operationResourceBaseShape,
      status: z.literal("processing"),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...operationResourceBaseShape,
      status: z.literal("succeeded"),
      result: anytypeOperationResultSchema,
      completedAt: unixSecondsSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.result.type !== value.operation.type) {
        context.addIssue({
          code: "custom",
          message: "Operation result type must match the requested operation",
        });
      }
    }),
  z
    .object({
      ...operationResourceBaseShape,
      status: z.literal("rejected-by-local-policy"),
      reasonCode: z.string().min(1).max(200),
      completedAt: unixSecondsSchema,
    })
    .strict(),
  z
    .object({
      ...operationResourceBaseShape,
      status: z.literal("failed"),
      problem: problemDetailsSchema,
      willRetry: z.boolean(),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...operationResourceBaseShape,
      status: z.enum(["expired", "cancelled", "dead-lettered"]),
      completedAt: unixSecondsSchema,
      problem: problemDetailsSchema.optional(),
    })
    .strict(),
]);

export type AnytypeOperationResult = z.infer<
  typeof anytypeOperationResultSchema
>;
export type OperationAccepted = z.infer<typeof operationAcceptedSchema>;
export type OperationResource = z.infer<typeof operationResourceSchema>;
