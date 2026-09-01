import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import { getR2Environment } from "@/lib/env";
import type { ObjectStore, StoredObject } from "@/lib/ports";

const deleteBatchSize = 1_000;

function validateObjectKey(pathname: string): void {
  const segments = pathname.split("/");
  if (
    pathname.length === 0 ||
    pathname.startsWith("/") ||
    pathname.includes("\\") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    new TextEncoder().encode(pathname).byteLength > 1_024
  ) {
    throw new TypeError("pathname must be a safe R2 object key");
  }
}

function prepareBody(input: {
  body: ReadableStream<Uint8Array> | Uint8Array;
  contentLength?: number;
}): { body: ReadableStream<Uint8Array> | Uint8Array; size: number } {
  if (input.body instanceof Uint8Array) {
    if (
      input.contentLength !== undefined &&
      input.contentLength !== input.body.byteLength
    ) {
      throw new TypeError(
        "contentLength must match the Uint8Array byte length",
      );
    }
    return { body: input.body, size: input.body.byteLength };
  }
  if (
    !Number.isSafeInteger(input.contentLength) ||
    (input.contentLength ?? -1) < 0
  ) {
    throw new TypeError(
      "contentLength is required for streaming R2 object uploads",
    );
  }
  return { body: input.body, size: input.contentLength as number };
}

function isMissingObject(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === "NoSuchKey" || error.$metadata.httpStatusCode === 404)
  );
}

export class R2PrivateObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(input?: { client: S3Client; bucket: string }) {
    if (input) {
      this.#client = input.client;
      this.#bucket = input.bucket;
      return;
    }

    const environment = getR2Environment();
    this.#bucket = environment.R2_BUCKET_NAME;
    this.#client = new S3Client({
      region: "auto",
      endpoint: `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: environment.R2_ACCESS_KEY_ID,
        secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  async putImmutable(input: {
    pathname: string;
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentLength?: number;
    contentType: string;
  }): Promise<{ pathname: string; size: number }> {
    validateObjectKey(input.pathname);
    const { body, size } = prepareBody(input);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: input.pathname,
        Body: body,
        ContentLength: size,
        ContentType: input.contentType,
        IfNoneMatch: "*",
      }),
    );
    return { pathname: input.pathname, size };
  }

  async get(pathname: string): Promise<StoredObject | undefined> {
    validateObjectKey(pathname);
    try {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: pathname }),
      );
      if (!result.Body) return undefined;
      return {
        pathname,
        contentType: result.ContentType ?? "application/octet-stream",
        size: result.ContentLength ?? 0,
        stream: result.Body.transformToWebStream(),
      };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  async delete(pathnames: string[]): Promise<void> {
    for (const pathname of pathnames) validateObjectKey(pathname);
    for (let index = 0; index < pathnames.length; index += deleteBatchSize) {
      const batch = pathnames.slice(index, index + deleteBatchSize);
      if (batch.length === 0) continue;
      const result = await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: {
            Quiet: true,
            Objects: batch.map((Key) => ({ Key })),
          },
        }),
      );
      if (result.Errors && result.Errors.length > 0) {
        const failedKeys = result.Errors.map((error) => error.Key ?? "unknown")
          .slice(0, 3)
          .join(", ");
        throw new Error(
          `R2 failed to delete ${result.Errors.length} object(s): ${failedKeys}`,
        );
      }
    }
  }
}
