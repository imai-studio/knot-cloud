import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { R2PrivateObjectStore } from "./r2";

function mockClient(send: (command: unknown) => Promise<unknown>): S3Client {
  return { send: vi.fn(send) } as unknown as S3Client;
}

describe("R2PrivateObjectStore", () => {
  it("uses a conditional write so immutable objects cannot be overwritten", async () => {
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(
      store.putImmutable({
        pathname: "tenant/assets/digest",
        body: new Uint8Array([1, 2, 3]),
        contentType: "application/octet-stream",
      }),
    ).resolves.toEqual({ pathname: "tenant/assets/digest", size: 3 });

    const command = vi.mocked(client.send).mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: "knot-test",
      Key: "tenant/assets/digest",
      ContentLength: 3,
      IfNoneMatch: "*",
    });
  });

  it("reads private objects through the authenticated S3 endpoint", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    const client = mockClient(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return {
        Body: { transformToWebStream: () => stream },
        ContentLength: 2,
        ContentType: "image/png",
      };
    });
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    const object = await store.get("tenant/assets/digest");
    expect(object).toMatchObject({
      pathname: "tenant/assets/digest",
      size: 2,
      contentType: "image/png",
    });
  });

  it("rejects unsafe keys and batches deletes at the R2 limit", async () => {
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(store.get("../secret")).rejects.toThrow(/safe R2 object key/u);
    await expect(store.get("assets//digest")).rejects.toThrow(
      /safe R2 object key/u,
    );

    const keys = Array.from({ length: 1_001 }, (_, index) => `assets/${index}`);
    await store.delete(keys);
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

  it("streams uploads when an explicit content length is supplied", async () => {
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });

    await expect(
      store.putImmutable({
        pathname: "tenant/assets/stream",
        body: stream,
        contentLength: 2,
        contentType: "application/octet-stream",
      }),
    ).resolves.toEqual({ pathname: "tenant/assets/stream", size: 2 });
    const command = vi.mocked(client.send).mock.calls[0]?.[0];
    expect((command as PutObjectCommand).input.Body).toBe(stream);
    expect((command as PutObjectCommand).input.ContentLength).toBe(2);
  });

  it("rejects an unbounded stream instead of buffering it in memory", async () => {
    const client = mockClient(async () => ({}));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });
    const stream = new ReadableStream<Uint8Array>();

    await expect(
      store.putImmutable({
        pathname: "tenant/assets/stream",
        body: stream,
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow(/contentLength is required/u);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("fails when R2 reports a partial batch-delete error", async () => {
    const client = mockClient(async () => ({
      Errors: [{ Key: "assets/two", Code: "InternalError" }],
    }));
    const store = new R2PrivateObjectStore({ client, bucket: "knot-test" });

    await expect(store.delete(["assets/one", "assets/two"])).rejects.toThrow(
      /assets\/two/u,
    );
  });
});
