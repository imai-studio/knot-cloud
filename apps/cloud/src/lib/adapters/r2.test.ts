import { createHash } from "node:crypto";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { privateObjectCacheControl, type ObjectLocator } from "../ports";
import {
  ObjectDigestMismatchError,
  ObjectSizeError,
  objectKeyFor,
  R2PrivateObjectStore,
} from "./r2";

const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function locator(bytes: Uint8Array, tenantId = tenantA): ObjectLocator {
  return { tenantId, sha256: digest(bytes) };
}

function mockClient(send: (command: unknown) => Promise<unknown>): S3Client {
  return { send: vi.fn(send) } as unknown as S3Client;
}

function responseBody(bytes: Uint8Array) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { transformToWebStream: () => stream };
}

async function consume(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("R2PrivateObjectStore", () => {
  it("returns every caller-controlled header required by a presigned upload", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const object = locator(bytes);
    const client = new S3Client({
      region: "auto",
      endpoint: "https://test-account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    });
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    const signed = await store.createPresignedAssetUpload({
      locator: object,
      contentLength: bytes.byteLength,
      contentType: "image/png",
      expiresInSeconds: 600,
    });
    const url = new URL(signed.uploadUrl);

    expect(signed.requiredHeaders).toEqual({
      "cache-control": privateObjectCacheControl,
      "content-length": "3",
      "content-type": "image/png",
      "if-none-match": "*",
    });
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "host", "if-none-match"]),
    );
    expect(url.searchParams.get("x-amz-meta-sha256")).toBe(object.sha256);
    expect(url.searchParams.get("x-amz-meta-tenant-id")).toBe(tenantA);
  });

  it("derives tenant-scoped keys and rejects caller-controlled path data", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const first = objectKeyFor(locator(bytes));
    const second = objectKeyFor(locator(bytes, tenantB));

    expect(first).toBe(
      `tenants/${tenantA}/assets/${digest(bytes).slice(0, 2)}/${digest(bytes)}`,
    );
    expect(second).not.toBe(first);
    expect(() =>
      objectKeyFor({
        tenantId: "../other-tenant",
        sha256: digest(bytes),
      }),
    ).toThrow(/canonical lowercase UUID/u);
    expect(() =>
      objectKeyFor({
        tenantId: tenantA,
        sha256: "not-a-digest",
      }),
    ).toThrow(/64-character digest/u);
  });

  it("verifies the digest before an immutable write", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        locator: { ...locator(bytes), sha256: "0".repeat(64) },
        body: bytes,
        contentType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(ObjectDigestMismatchError);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("rejects malformed media types before writing", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        locator: locator(bytes),
        body: bytes,
        contentType: "not-a-media-type",
      }),
    ).rejects.toThrow(/media type/u);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("writes transport checksums, private cache metadata, and object identity", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const object = locator(bytes);
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        locator: object,
        body: bytes,
        contentType: "application/octet-stream",
      }),
    ).resolves.toEqual({
      ...object,
      key: objectKeyFor(object),
      contentType: "application/octet-stream",
      size: 3,
    });

    const command = vi.mocked(client.send).mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: "knot-test",
      Key: objectKeyFor(object),
      ContentLength: 3,
      ContentMD5: createHash("md5").update(bytes).digest("base64"),
      CacheControl: privateObjectCacheControl,
      IfNoneMatch: "*",
      Metadata: {
        "byte-size": "3",
        kind: "asset",
        sha256: object.sha256,
        "tenant-id": tenantA,
      },
    });
  });

  it("treats an exact existing digest-key object as an idempotent retry", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const object = locator(bytes);
    const client = mockClient(async (command) => {
      if (command instanceof PutObjectCommand) {
        throw Object.assign(new Error("already exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      expect(command).toBeInstanceOf(HeadObjectCommand);
      return {
        ContentLength: bytes.byteLength,
        ContentType: "application/octet-stream",
        Metadata: {
          "byte-size": String(bytes.byteLength),
          kind: "asset",
          sha256: object.sha256,
          "tenant-id": object.tenantId,
        },
      };
    });
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        locator: object,
        body: bytes,
        contentType: "application/octet-stream",
      }),
    ).resolves.toMatchObject({ key: objectKeyFor(object), size: 3 });
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", " 3", "+3", "03", "3.0", "3e0", "9007199254740992"])(
    "rejects a 412 retry with non-canonical byte-size metadata: %s",
    async (byteSize) => {
      const bytes = new Uint8Array([1, 2, 3]);
      const object = locator(bytes);
      const client = mockClient(async (command) => {
        if (command instanceof PutObjectCommand) {
          throw Object.assign(new Error("already exists"), {
            name: "PreconditionFailed",
            $metadata: { httpStatusCode: 412 },
          });
        }
        return {
          ContentLength: bytes.byteLength,
          ContentType: "application/octet-stream",
          Metadata: {
            ...(byteSize === undefined ? {} : { "byte-size": byteSize }),
            kind: "asset",
            sha256: object.sha256,
            "tenant-id": object.tenantId,
          },
        };
      });
      const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

      await expect(
        store.putImmutable({
          locator: object,
          body: bytes,
          contentType: "application/octet-stream",
        }),
      ).rejects.toThrow(/valid byte-size/u);
    },
  );

  it("propagates a missing object during 412 retry verification", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const object = locator(bytes);
    const missing = new S3ServiceException({
      $fault: "client",
      $metadata: { httpStatusCode: 404 },
      name: "NotFound",
    });
    const client = mockClient(async (command) => {
      if (command instanceof PutObjectCommand) {
        throw Object.assign(new Error("already exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      throw missing;
    });
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        locator: object,
        body: bytes,
        contentType: "application/octet-stream",
      }),
    ).rejects.toBe(missing);
  });

  it("rejects a canonical single-part ETag that does not match the bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = mockClient(async () => ({ ETag: `\"${"0".repeat(32)}\"` }));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        locator: locator(bytes),
        body: bytes,
        contentType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(ObjectDigestMismatchError);
  });

  it("rejects a digest-key retry when stored metadata differs", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const object = locator(bytes);
    const client = mockClient(async (command) => {
      if (command instanceof PutObjectCommand) {
        throw Object.assign(new Error("already exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      return {
        ContentLength: bytes.byteLength,
        ContentType: "text/plain",
        Metadata: {
          "byte-size": String(bytes.byteLength),
          kind: "asset",
          sha256: object.sha256,
          "tenant-id": object.tenantId,
        },
      };
    });
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        locator: object,
        body: bytes,
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow(/does not match/u);
  });

  it("bounds streaming uploads and checks their exact byte length", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({
      client,
      bucket: "knot-test",
      maxObjectBytes: 3,
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await expect(
      store.putImmutable({
        locator: locator(bytes),
        body: stream,
        contentLength: 3,
        contentType: "application/octet-stream",
      }),
    ).resolves.toMatchObject({ size: 3 });

    await expect(
      store.putImmutable({
        locator: locator(bytes),
        body: new Uint8Array([1, 2, 3, 4]),
        contentType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(ObjectSizeError);

    await expect(
      store.putImmutable({
        locator: locator(bytes),
        body: new ReadableStream<Uint8Array>(),
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow(/contentLength is required/u);
  });

  it("cancels a stream that exceeds its declared byte length", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(bytes);
      },
    });
    const store = new R2PrivateObjectStore({
      client: mockClient(async () => ({})),
      bucket: "knot-test",
      maxObjectBytes: 8,
    });

    await expect(
      store.putImmutable({
        locator: locator(bytes),
        body: stream,
        contentLength: 3,
        contentType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(ObjectSizeError);
    expect(cancel).toHaveBeenCalledWith(
      "object exceeded its declared byte length",
    );
  });

  it("preserves the size error when over-length stream cancellation fails", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cancelError = new Error("source refused cancellation");
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(cancelError),
      start(controller) {
        controller.enqueue(bytes);
      },
    });
    const store = new R2PrivateObjectStore({
      client: mockClient(async () => ({})),
      bucket: "knot-test",
      maxObjectBytes: 8,
    });

    await expect(
      store.putImmutable({
        locator: locator(bytes),
        body: stream,
        contentLength: 3,
        contentType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(ObjectSizeError);
  });

  it("reads through the authenticated endpoint and verifies the bytes", async () => {
    const bytes = new Uint8Array([4, 5]);
    const object = locator(bytes);
    const client = mockClient(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return {
        Body: responseBody(bytes),
        ContentLength: bytes.byteLength,
        ContentType: "image/png",
        Metadata: {
          "byte-size": String(bytes.byteLength),
          kind: "asset",
          sha256: object.sha256,
          "tenant-id": object.tenantId,
        },
      };
    });
    const store = new R2PrivateObjectStore({
      client,
      bucket: "knot-test",
      maxObjectBytes: 8,
    });

    const stored = await store.get(object);
    expect(stored).toMatchObject({
      descriptor: {
        ...object,
        key: objectKeyFor(object),
        size: 2,
        contentType: "image/png",
      },
      cacheControl: privateObjectCacheControl,
    });
    await expect(consume(stored!.stream)).resolves.toEqual(bytes);

    const command = vi.mocked(client.send).mock.calls[0]?.[0];
    expect((command as GetObjectCommand).input).toMatchObject({
      Bucket: "knot-test",
      Key: objectKeyFor(object),
    });
    expect((command as GetObjectCommand).input.Range).toBeUndefined();
  });

  it("falls back only when stored Content-Type is absent", async () => {
    const bytes = new Uint8Array([4, 5]);
    const object = locator(bytes);
    const metadata = {
      "byte-size": "2",
      kind: "asset",
      sha256: object.sha256,
      "tenant-id": object.tenantId,
    };
    const missingTypeStore = new R2PrivateObjectStore({
      client: mockClient(async () => ({
        Body: responseBody(bytes),
        ContentLength: 2,
        Metadata: metadata,
      })),
      bucket: "knot-test",
    });
    await expect(missingTypeStore.get(object)).resolves.toMatchObject({
      descriptor: { contentType: "application/octet-stream" },
    });

    const invalidTypeStore = new R2PrivateObjectStore({
      client: mockClient(async () => ({
        Body: responseBody(bytes),
        ContentLength: 2,
        ContentType: "invalid media type",
        Metadata: metadata,
      })),
      bucket: "knot-test",
    });
    await expect(invalidTypeStore.get(object)).rejects.toThrow(/media type/u);
  });

  it("preserves invalid metadata errors when response cancellation fails", async () => {
    const bytes = new Uint8Array([4, 5]);
    const object = locator(bytes);
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const source = new ReadableStream<Uint8Array>({ cancel });
    const store = new R2PrivateObjectStore({
      client: mockClient(async () => ({
        Body: { transformToWebStream: () => source },
        ContentLength: 2,
        ContentType: "image/png",
        Metadata: {
          "byte-size": " 2",
          kind: "asset",
          sha256: object.sha256,
          "tenant-id": object.tenantId,
        },
      })),
      bucket: "knot-test",
    });

    await expect(store.get(object)).rejects.toThrow(/valid byte-size/u);
    expect(cancel).toHaveBeenCalledWith("stored object metadata is invalid");
  });

  it("cancels an over-length stored response without replacing the size error", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const object = locator(new Uint8Array([4, 5]));
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const source = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(bytes);
      },
    });
    const store = new R2PrivateObjectStore({
      client: mockClient(async () => ({
        Body: { transformToWebStream: () => source },
        ContentLength: 2,
        ContentType: "image/png",
        Metadata: {
          "byte-size": "2",
          kind: "asset",
          sha256: object.sha256,
          "tenant-id": object.tenantId,
        },
      })),
      bucket: "knot-test",
    });

    await expect(store.get(object)).rejects.toBeInstanceOf(ObjectSizeError);
    expect(cancel).toHaveBeenCalledWith(
      "object exceeded its declared byte length",
    );
  });

  it("verifies a direct upload without returning a second buffered body", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const object = locator(bytes);
    const client = mockClient(async () => ({
      Body: responseBody(bytes),
      ContentLength: bytes.byteLength,
      ContentType: "image/png",
      Metadata: {
        "byte-size": String(bytes.byteLength),
        kind: "asset",
        sha256: object.sha256,
        "tenant-id": object.tenantId,
      },
    }));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(store.verify(object)).resolves.toEqual({
      ...object,
      key: objectKeyFor(object),
      contentType: "image/png",
      size: bytes.byteLength,
    });
  });

  it("fails a download whose bytes or metadata do not match the key", async () => {
    const expected = new Uint8Array([4, 5]);
    const actual = new Uint8Array([4, 6]);
    const object = locator(expected);
    const metadata = {
      "byte-size": "2",
      kind: "asset",
      sha256: object.sha256,
      "tenant-id": object.tenantId,
    };
    const client = mockClient(async () => ({
      Body: responseBody(actual),
      ContentLength: 2,
      Metadata: metadata,
    }));
    const store = new R2PrivateObjectStore({
      client,
      bucket: "knot-test",
      maxObjectBytes: 8,
    });

    await expect(store.get(object)).rejects.toBeInstanceOf(
      ObjectDigestMismatchError,
    );

    metadata["tenant-id"] = tenantB;
    await expect(store.get(object)).rejects.toThrow(/metadata does not match/u);
  });

  it("rejects oversized stored objects before returning a body", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const object = locator(bytes);
    const client = mockClient(async () => ({
      Body: responseBody(bytes),
      ContentLength: 4,
      Metadata: {
        "byte-size": "4",
        kind: "asset",
        sha256: object.sha256,
        "tenant-id": object.tenantId,
      },
    }));
    const store = new R2PrivateObjectStore({
      client,
      bucket: "knot-test",
      maxObjectBytes: 3,
    });

    await expect(store.get(object)).rejects.toBeInstanceOf(ObjectSizeError);
  });

  it("rejects a stored object whose response length differs from metadata", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const object = locator(bytes);
    const client = mockClient(async () => ({
      Body: responseBody(bytes),
      ContentLength: 2,
      Metadata: {
        "byte-size": "3",
        kind: "asset",
        sha256: object.sha256,
        "tenant-id": object.tenantId,
      },
    }));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(store.get(object)).rejects.toBeInstanceOf(ObjectSizeError);
  });

  it("maps only modeled missing-key responses to undefined", async () => {
    const object = locator(new Uint8Array([1]));
    const missing = new S3ServiceException({
      $fault: "client",
      $metadata: { httpStatusCode: 404 },
      name: "NoSuchKey",
    });
    const missingStore = new R2PrivateObjectStore({
      client: mockClient(async () => Promise.reject(missing)),
      bucket: "knot-test",
    });
    await expect(missingStore.get(object)).resolves.toBeUndefined();

    const missingBucket = new S3ServiceException({
      $fault: "client",
      $metadata: { httpStatusCode: 404 },
      name: "NoSuchBucket",
    });
    const brokenStore = new R2PrivateObjectStore({
      client: mockClient(async () => Promise.reject(missingBucket)),
      bucket: "knot-test",
    });
    await expect(brokenStore.get(object)).rejects.toBe(missingBucket);
  });

  it("rejects a successful object response without a body", async () => {
    const object = locator(new Uint8Array([1]));
    const store = new R2PrivateObjectStore({
      client: mockClient(async () => ({
        ContentLength: 1,
        Metadata: {
          "byte-size": "1",
          kind: "asset",
          sha256: object.sha256,
          "tenant-id": object.tenantId,
        },
      })),
      bucket: "knot-test",
    });

    await expect(store.get(object)).rejects.toThrow(/without a body/u);
  });

  it("deletes only tombstoned tenant objects, with deduplication and batching", async () => {
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });
    const tombstonedAt = new Date("2026-09-01T00:00:00.000Z");
    const objects = Array.from({ length: 1_001 }, (_, index) => {
      const bytes = new TextEncoder().encode(String(index));
      const object = locator(bytes);
      return {
        tenantId: object.tenantId,
        key: objectKeyFor(object),
        tombstonedAt,
      };
    });
    objects.push(objects[0]!);

    await store.deleteTombstoned(objects);
    const calls = vi.mocked(client.send).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBeInstanceOf(DeleteObjectsCommand);
    expect(
      (calls[0]?.[0] as DeleteObjectsCommand).input.Delete?.Objects,
    ).toHaveLength(1_000);
    expect(
      (calls[1]?.[0] as DeleteObjectsCommand).input.Delete?.Objects,
    ).toHaveLength(1);
  });

  it("fails when R2 reports a partial batch-delete error", async () => {
    const bytes = new Uint8Array([1]);
    const object = locator(bytes);
    const client = mockClient(async () => ({
      Errors: [{ Key: objectKeyFor(object), Code: "InternalError" }],
    }));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.deleteTombstoned([
        {
          tenantId: object.tenantId,
          key: objectKeyFor(object),
          tombstonedAt: new Date(),
        },
      ]),
    ).rejects.toThrow(new RegExp(object.sha256, "u"));
  });

  it("rejects a tombstone key from another tenant", async () => {
    const object = locator(new Uint8Array([1]));
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.deleteTombstoned([
        {
          tenantId: tenantB,
          key: objectKeyFor(object),
          tombstonedAt: new Date(),
        },
      ]),
    ).rejects.toThrow(/belong to tenantId/u);
    expect(client.send).not.toHaveBeenCalled();
  });
});
