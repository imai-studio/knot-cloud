import { createHash } from "node:crypto";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import { getR2Environment } from "@/lib/env";
import {
  privateObjectCacheControl,
  type ObjectLocator,
  type ObjectStore,
  type StoredObject,
  type StoredObjectDescriptor,
  type TombstonedObject,
} from "@/lib/ports";

const deleteBatchSize = 1_000;
const defaultMaxObjectBytes = 33_554_432;
const hardMaxObjectBytes = 134_217_728;
const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const mediaTypePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[^;\r\n\0]+)*$/iu;

export class ObjectDigestMismatchError extends Error {
  constructor() {
    super("object bytes do not match the declared SHA-256 digest");
    this.name = "ObjectDigestMismatchError";
  }
}

export class ObjectSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectSizeError";
  }
}

function validateLocator(locator: ObjectLocator): void {
  if (!tenantIdPattern.test(locator.tenantId)) {
    throw new TypeError("tenantId must be a canonical lowercase UUID");
  }
  if (!sha256Pattern.test(locator.sha256)) {
    throw new TypeError("sha256 must be a lowercase 64-character digest");
  }
}

export function objectKeyFor(locator: ObjectLocator): string {
  validateLocator(locator);
  return `tenants/${locator.tenantId}/assets/${locator.sha256.slice(0, 2)}/${locator.sha256}`;
}

function validateContentType(contentType: string): void {
  if (
    contentType.length === 0 ||
    contentType.length > 255 ||
    /[\r\n\0]/u.test(contentType) ||
    !mediaTypePattern.test(contentType)
  ) {
    throw new TypeError("contentType must be a safe non-empty media type");
  }
}

function validateTombstonedKey(object: TombstonedObject): string {
  if (!tenantIdPattern.test(object.tenantId)) {
    throw new TypeError("tenantId must be a canonical lowercase UUID");
  }
  const match = object.key.match(
    /^tenants\/([0-9a-f-]{36})\/assets\/([a-f0-9]{2})\/([a-f0-9]{64})$/u,
  );
  if (
    !match ||
    match[1] !== object.tenantId ||
    match[2] !== match[3]?.slice(0, 2)
  ) {
    throw new TypeError("key must be a canonical asset key for tenantId");
  }
  return object.key;
}

async function materializeBody(input: {
  body: ReadableStream<Uint8Array> | Uint8Array;
  contentLength?: number;
  maxObjectBytes: number;
}): Promise<Uint8Array> {
  if (input.body instanceof Uint8Array) {
    if (
      input.contentLength !== undefined &&
      input.contentLength !== input.body.byteLength
    ) {
      throw new ObjectSizeError(
        "contentLength does not match the Uint8Array byte length",
      );
    }
    if (input.body.byteLength > input.maxObjectBytes) {
      throw new ObjectSizeError("object exceeds the configured upload limit");
    }
    return input.body;
  }

  if (
    !Number.isSafeInteger(input.contentLength) ||
    (input.contentLength ?? -1) < 0
  ) {
    throw new ObjectSizeError(
      "contentLength is required for streaming object uploads",
    );
  }
  const contentLength = input.contentLength as number;
  if (contentLength > input.maxObjectBytes) {
    throw new ObjectSizeError("object exceeds the configured upload limit");
  }

  const reader = input.body.getReader();
  const body = new Uint8Array(contentLength);
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > contentLength || size > input.maxObjectBytes) {
        await reader.cancel("object exceeded its declared byte length");
        throw new ObjectSizeError(
          "stream contains more bytes than its declared length",
        );
      }
      body.set(result.value, size - result.value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }

  if (size !== contentLength) {
    throw new ObjectSizeError(
      "stream byte length does not match contentLength",
    );
  }

  return body;
}

function digest(bytes: Uint8Array, algorithm: "md5" | "sha256"): Buffer {
  return createHash(algorithm).update(bytes).digest();
}

function isMissingObject(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === "NoSuchKey" || error.name === "NotFound")
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (Reflect.get(error, "name") === "PreconditionFailed" ||
      Reflect.get(Reflect.get(error, "$metadata") ?? {}, "httpStatusCode") ===
        412)
  );
}

function parseStoredSize(metadata: Record<string, string> | undefined): number {
  const size = Number(metadata?.["byte-size"]);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("stored object is missing valid byte-size metadata");
  }
  return size;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export class R2PrivateObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly maxObjectBytes: number;

  constructor(input?: {
    client: S3Client;
    bucket: string;
    maxObjectBytes?: number;
  }) {
    if (input) {
      this.#client = input.client;
      this.#bucket = input.bucket;
      this.maxObjectBytes = input.maxObjectBytes ?? defaultMaxObjectBytes;
    } else {
      const environment = getR2Environment();
      this.#bucket = environment.R2_BUCKET_NAME;
      this.maxObjectBytes = environment.R2_MAX_OBJECT_BYTES;
      this.#client = new S3Client({
        region: "auto",
        endpoint: `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: environment.R2_ACCESS_KEY_ID,
          secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
        },
      });
    }

    if (
      !Number.isSafeInteger(this.maxObjectBytes) ||
      this.maxObjectBytes < 1 ||
      this.maxObjectBytes > hardMaxObjectBytes
    ) {
      throw new TypeError(
        `maxObjectBytes must be between 1 and ${hardMaxObjectBytes}`,
      );
    }
  }

  async putImmutable(input: {
    locator: ObjectLocator;
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentLength?: number;
    contentType: string;
  }): Promise<StoredObjectDescriptor> {
    const key = objectKeyFor(input.locator);
    validateContentType(input.contentType);
    const body = await materializeBody({
      body: input.body,
      contentLength: input.contentLength,
      maxObjectBytes: this.maxObjectBytes,
    });
    const sha256 = digest(body, "sha256").toString("hex");
    if (sha256 !== input.locator.sha256) {
      throw new ObjectDigestMismatchError();
    }

    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ContentMD5: digest(body, "md5").toString("base64"),
          ContentType: input.contentType,
          CacheControl: privateObjectCacheControl,
          Metadata: {
            "byte-size": String(body.byteLength),
            kind: "asset",
            sha256,
            "tenant-id": input.locator.tenantId,
          },
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      const existing = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      const storedSize = parseStoredSize(existing.Metadata);
      if (
        existing.Metadata?.sha256 !== sha256 ||
        existing.Metadata?.["tenant-id"] !== input.locator.tenantId ||
        existing.Metadata?.kind !== "asset" ||
        existing.ContentLength !== storedSize ||
        storedSize !== body.byteLength ||
        existing.ContentType !== input.contentType
      ) {
        throw new Error(
          "existing immutable object does not match the requested write",
        );
      }
    }

    return {
      ...input.locator,
      key,
      contentType: input.contentType,
      size: body.byteLength,
    };
  }

  async get(locator: ObjectLocator): Promise<StoredObject | undefined> {
    const key = objectKeyFor(locator);
    try {
      const result = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
        }),
      );
      if (!result.Body) {
        throw new Error(
          "R2 returned a successful object response without a body",
        );
      }

      const source = result.Body.transformToWebStream();
      let size: number;
      try {
        size = parseStoredSize(result.Metadata);
        if (
          result.Metadata?.sha256 !== locator.sha256 ||
          result.Metadata?.["tenant-id"] !== locator.tenantId ||
          result.Metadata?.kind !== "asset"
        ) {
          throw new Error("stored object metadata does not match its key");
        }
        if (
          size > this.maxObjectBytes ||
          (result.ContentLength !== undefined && result.ContentLength !== size)
        ) {
          throw new ObjectSizeError(
            "stored object length does not match its verified metadata",
          );
        }
      } catch (error) {
        await source
          .cancel("stored object metadata is invalid")
          .catch(() => {});
        throw error;
      }

      const body = await materializeBody({
        body: source,
        contentLength: size,
        maxObjectBytes: this.maxObjectBytes,
      });
      if (digest(body, "sha256").toString("hex") !== locator.sha256) {
        throw new ObjectDigestMismatchError();
      }

      const descriptor = {
        ...locator,
        key,
        contentType: result.ContentType ?? "application/octet-stream",
        size,
      };
      return {
        descriptor,
        cacheControl: privateObjectCacheControl,
        stream: streamFromBytes(body),
      };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  async deleteTombstoned(objects: TombstonedObject[]): Promise<void> {
    const keys = [
      ...new Set(
        objects.map((object) => {
          const { tombstonedAt } = object;
          if (
            !(tombstonedAt instanceof Date) ||
            !Number.isFinite(tombstonedAt.getTime())
          ) {
            throw new TypeError("tombstonedAt must be a valid Date");
          }
          return validateTombstonedKey(object);
        }),
      ),
    ];

    for (let index = 0; index < keys.length; index += deleteBatchSize) {
      const batch = keys.slice(index, index + deleteBatchSize);
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
