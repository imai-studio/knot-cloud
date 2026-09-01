import { createHash } from "node:crypto";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { getR2Environment } from "@/lib/env";
import {
  privateObjectCacheControl,
  type ObjectLocator,
  type ObjectStore,
  type PublicationBundleLocator,
  type StoredObject,
  type StoredObjectDescriptor,
  type TombstonedObject,
} from "@/lib/ports";

const deleteBatchSize = 1_000;
const maximumAssetBytes = 104_857_600;
const defaultMaxObjectBytes = maximumAssetBytes;
const hardMaxObjectBytes = maximumAssetBytes;
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

export function publicationBundleKeyFor(
  locator: PublicationBundleLocator,
): string {
  validateLocator(locator);
  if (!tenantIdPattern.test(locator.publicationId)) {
    throw new TypeError("publicationId must be a canonical lowercase UUID");
  }
  if (!tenantIdPattern.test(locator.versionId)) {
    throw new TypeError("versionId must be a canonical lowercase UUID");
  }
  return `tenants/${locator.tenantId}/publications/${locator.publicationId}/versions/${locator.versionId}/${locator.sha256}.json`;
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
  const assetMatch = object.key.match(
    /^tenants\/([0-9a-f-]{36})\/assets\/([a-f0-9]{2})\/([a-f0-9]{64})$/u,
  );
  if (assetMatch) {
    if (
      assetMatch[1] !== object.tenantId ||
      assetMatch[2] !== assetMatch[3]?.slice(0, 2)
    ) {
      throw new TypeError("key must belong to tenantId");
    }
    return object.key;
  }
  const bundleMatch = object.key.match(
    /^tenants\/([0-9a-f-]{36})\/publications\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})\/([a-f0-9]{64})\.json$/u,
  );
  if (!bundleMatch || bundleMatch[1] !== object.tenantId) {
    throw new TypeError("key must be a canonical tenant object key");
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
        await reader
          .cancel("object exceeded its declared byte length")
          .catch(() => {});
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
  const encodedSize = metadata?.["byte-size"];
  if (!encodedSize || !/^(?:0|[1-9][0-9]*)$/u.test(encodedSize)) {
    throw new Error("stored object is missing valid byte-size metadata");
  }
  const size = Number(encodedSize);
  if (!Number.isSafeInteger(size)) {
    throw new Error("stored object is missing valid byte-size metadata");
  }
  return size;
}

function verifySinglePartEtag(
  etag: string | undefined,
  bytes: Uint8Array,
): void {
  if (etag === undefined) return;
  const normalized =
    etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
  if (!/^[a-f0-9]{32}$/iu.test(normalized)) return;
  if (normalized.toLowerCase() !== digest(bytes, "md5").toString("hex")) {
    throw new ObjectDigestMismatchError();
  }
}

function boundedStoredStream(
  source: ReadableStream<Uint8Array>,
  expectedSize: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let observedSize = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (observedSize !== expectedSize) {
            controller.error(
              new ObjectSizeError(
                "stored object length does not match its verified metadata",
              ),
            );
          } else {
            controller.close();
          }
          reader.releaseLock();
          return;
        }
        observedSize += chunk.value.byteLength;
        if (observedSize > expectedSize) {
          await reader
            .cancel("stored object exceeds its verified length")
            .catch(() => {});
          controller.error(
            new ObjectSizeError(
              "stored object length does not match its verified metadata",
            ),
          );
          reader.releaseLock();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function validateStoredAssetMetadata(input: {
  locator: ObjectLocator;
  metadata?: Record<string, string>;
  contentLength?: number;
  contentType?: string;
  maxObjectBytes: number;
}): { contentType: string; size: number } {
  const size = parseStoredSize(input.metadata);
  const contentType = input.contentType ?? "application/octet-stream";
  if (input.contentType !== undefined) validateContentType(input.contentType);
  if (
    input.metadata?.sha256 !== input.locator.sha256 ||
    input.metadata?.["tenant-id"] !== input.locator.tenantId ||
    input.metadata?.kind !== "asset"
  ) {
    throw new Error("stored object metadata does not match its key");
  }
  if (
    size > input.maxObjectBytes ||
    (input.contentLength !== undefined && input.contentLength !== size)
  ) {
    throw new ObjectSizeError(
      "stored object length does not match its verified metadata",
    );
  }
  return {
    contentType,
    size,
  };
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

  async createPresignedAssetUpload(input: {
    locator: ObjectLocator;
    contentLength: number;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
    expiresAt: Date;
  }> {
    const key = objectKeyFor(input.locator);
    validateContentType(input.contentType);
    if (
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 1 ||
      input.contentLength > this.maxObjectBytes
    ) {
      throw new ObjectSizeError("asset exceeds the configured upload limit");
    }
    if (
      !Number.isInteger(input.expiresInSeconds) ||
      input.expiresInSeconds < 30 ||
      input.expiresInSeconds > 900
    ) {
      throw new TypeError("expiresInSeconds must be between 30 and 900");
    }
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      ContentLength: input.contentLength,
      ContentType: input.contentType,
      CacheControl: privateObjectCacheControl,
      IfNoneMatch: "*",
      Metadata: {
        "byte-size": String(input.contentLength),
        kind: "asset",
        sha256: input.locator.sha256,
        "tenant-id": input.locator.tenantId,
      },
    });
    const now = Date.now();
    return {
      uploadUrl: await getSignedUrl(this.#client, command, {
        expiresIn: input.expiresInSeconds,
      }),
      requiredHeaders: {
        "cache-control": privateObjectCacheControl,
        "content-length": String(input.contentLength),
        "content-type": input.contentType,
        "if-none-match": "*",
      },
      expiresAt: new Date(now + input.expiresInSeconds * 1_000),
    };
  }

  async putImmutable(input: {
    locator: ObjectLocator;
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentLength?: number;
    contentType: string;
  }): Promise<StoredObjectDescriptor> {
    return this.#putAtKey({
      ...input,
      key: objectKeyFor(input.locator),
      kind: "asset",
    });
  }

  async putPublicationBundleImmutable(input: {
    locator: PublicationBundleLocator;
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentLength?: number;
    contentType: "application/vnd.imai.knot.publication+json";
  }): Promise<StoredObjectDescriptor> {
    return this.#putAtKey({
      ...input,
      key: publicationBundleKeyFor(input.locator),
      kind: "publication-bundle",
    });
  }

  async #putAtKey(input: {
    locator: ObjectLocator;
    key: string;
    kind: "asset" | "publication-bundle";
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentLength?: number;
    contentType: string;
  }): Promise<StoredObjectDescriptor> {
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
      const result = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: input.key,
          Body: body,
          ContentLength: body.byteLength,
          ContentMD5: digest(body, "md5").toString("base64"),
          ContentType: input.contentType,
          CacheControl: privateObjectCacheControl,
          Metadata: {
            "byte-size": String(body.byteLength),
            kind: input.kind,
            sha256,
            "tenant-id": input.locator.tenantId,
          },
          IfNoneMatch: "*",
        }),
      );
      verifySinglePartEtag(result.ETag, body);
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      const existing = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: input.key }),
      );
      const storedSize = parseStoredSize(existing.Metadata);
      verifySinglePartEtag(existing.ETag, body);
      if (
        existing.Metadata?.sha256 !== sha256 ||
        existing.Metadata?.["tenant-id"] !== input.locator.tenantId ||
        existing.Metadata?.kind !== input.kind ||
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
      key: input.key,
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
      let metadata: { contentType: string; size: number };
      try {
        metadata = validateStoredAssetMetadata({
          locator,
          metadata: result.Metadata,
          contentLength: result.ContentLength,
          contentType: result.ContentType,
          maxObjectBytes: this.maxObjectBytes,
        });
      } catch (error) {
        await source
          .cancel("stored object metadata is invalid")
          .catch(() => {});
        throw error;
      }

      const descriptor = {
        ...locator,
        key,
        contentType: metadata.contentType,
        size: metadata.size,
      };
      return {
        descriptor,
        cacheControl: privateObjectCacheControl,
        // Direct uploads are fully hashed by verify() before they become
        // publishable. Reads validate immutable key metadata and stream the
        // object instead of buffering and hashing it again on every request.
        stream: boundedStoredStream(source, metadata.size),
      };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  async verify(
    locator: ObjectLocator,
  ): Promise<StoredObjectDescriptor | undefined> {
    const key = objectKeyFor(locator);
    try {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (!result.Body) return undefined;
      const source = result.Body.transformToWebStream();
      let metadata: { contentType: string; size: number };
      try {
        metadata = validateStoredAssetMetadata({
          locator,
          metadata: result.Metadata,
          contentLength: result.ContentLength,
          contentType: result.ContentType,
          maxObjectBytes: this.maxObjectBytes,
        });
      } catch (error) {
        await source.cancel("stored object metadata is invalid");
        throw error;
      }

      const hash = createHash("sha256");
      const reader = source.getReader();
      let observedSize = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          observedSize += chunk.value.byteLength;
          if (observedSize > metadata.size) {
            await reader.cancel("stored object exceeds its verified length");
            throw new ObjectSizeError(
              "stored object length does not match its verified metadata",
            );
          }
          hash.update(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (observedSize !== metadata.size) {
        throw new ObjectSizeError(
          "stored object length does not match its verified metadata",
        );
      }
      if (hash.digest("hex") !== locator.sha256) {
        throw new ObjectDigestMismatchError();
      }
      return { ...locator, key, ...metadata };
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
