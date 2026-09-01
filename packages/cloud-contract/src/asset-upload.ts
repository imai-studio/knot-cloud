import { z } from "zod";

import {
  idempotencyKeySchema,
  sha256Schema,
  unixSecondsSchema,
} from "./identifiers.js";
import { protocolVersion } from "./protocol.js";

export const maximumAssetBytes = 100 * 1024 * 1024;

export const mediaTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7E]+)?$/u);

export const assetUploadRequestSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    connectorId: z.uuid(),
    siteId: z.uuid(),
    sha256: sha256Schema,
    byteSize: z.number().int().min(1).max(maximumAssetBytes),
    contentType: mediaTypeSchema,
    fileName: z.string().trim().min(1).max(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

const uploadHeaderNameSchema = z
  .string()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,100}$/u)
  .refine(
    (name) =>
      !["authorization", "cookie", "host", "proxy-authorization"].includes(
        name,
      ),
    "Upload headers cannot carry ambient credentials",
  );

export const assetUploadCreatedSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    assetId: z.uuid(),
    uploadId: z.uuid(),
    method: z.literal("PUT"),
    uploadUrl: z.url().refine((value) => isSecureOrLoopbackUrl(value), {
      message: "Upload URL must use HTTPS or loopback HTTP",
    }),
    requiredHeaders: z
      .record(uploadHeaderNameSchema, z.string().max(2_000))
      .refine((headers) => Object.keys(headers).length <= 20),
    expiresAt: unixSecondsSchema,
  })
  .strict();

export const assetUploadCommitSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    assetId: z.uuid(),
    uploadId: z.uuid(),
    expectedSha256: sha256Schema,
    expectedByteSize: z.number().int().min(1).max(maximumAssetBytes),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const assetUploadResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("verified"),
      assetId: z.uuid(),
      sha256: sha256Schema,
      byteSize: z.number().int().min(1).max(maximumAssetBytes),
      verifiedAt: unixSecondsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      assetId: z.uuid(),
      reason: z.enum(["digest-mismatch", "size-mismatch", "upload-missing"]),
    })
    .strict(),
]);

export type AssetUploadRequest = z.infer<typeof assetUploadRequestSchema>;
export type AssetUploadCreated = z.infer<typeof assetUploadCreatedSchema>;
export type AssetUploadCommit = z.infer<typeof assetUploadCommitSchema>;
export type AssetUploadResult = z.infer<typeof assetUploadResultSchema>;

function isSecureOrLoopbackUrl(value: string): boolean {
  const parsed = new URL(value);
  return (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))
  );
}
