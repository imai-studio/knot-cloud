import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedPutInput {
  client: S3Client;
  bucket: string;
  key: string;
  contentLength: number;
  contentType: string;
  cacheControl: string;
  metadata: Record<string, string>;
  expiresInSeconds: number;
}

/**
 * Build the exact signed PUT contract shared by the runtime adapter and the
 * production provider smoke. Custom metadata must remain in request headers:
 * R2 authorizes hoisted x-amz-meta-* query values but does not persist them.
 */
export async function createPresignedPut(input: PresignedPutInput): Promise<{
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  expiresAt: Date;
}> {
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
    throw new TypeError("contentLength must be a positive safe integer");
  }
  if (
    !Number.isInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 30 ||
    input.expiresInSeconds > 900
  ) {
    throw new TypeError("expiresInSeconds must be between 30 and 900");
  }
  const metadataHeaders = Object.fromEntries(
    Object.entries(input.metadata).map(([name, value]) => [
      `x-amz-meta-${name}`,
      value,
    ]),
  );
  const command = new PutObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    ContentLength: input.contentLength,
    ContentType: input.contentType,
    CacheControl: input.cacheControl,
    IfNoneMatch: "*",
    Metadata: input.metadata,
  });
  const signingDate = new Date();
  return {
    uploadUrl: await getSignedUrl(input.client, command, {
      expiresIn: input.expiresInSeconds,
      signingDate,
      unhoistableHeaders: new Set(Object.keys(metadataHeaders)),
    }),
    requiredHeaders: {
      "cache-control": input.cacheControl,
      "content-length": String(input.contentLength),
      "content-type": input.contentType,
      "if-none-match": "*",
      ...metadataHeaders,
    },
    expiresAt: new Date(signingDate.getTime() + input.expiresInSeconds * 1_000),
  };
}
