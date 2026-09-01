import { describe, expect, it, vi } from "vitest";

import {
  privateObjectCacheControl,
  RevocableObjectReader,
  type ObjectLocator,
  type ObjectStore,
  type ObjectVisibility,
  type StoredObject,
} from "./ports";

const locator: ObjectLocator = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sha256: "1".repeat(64),
};

function objectStore(
  get: () => Promise<StoredObject | undefined>,
): ObjectStore {
  return {
    maxObjectBytes: 32,
    createPresignedAssetUpload: vi.fn(),
    putImmutable: vi.fn(),
    putPublicationBundleImmutable: vi.fn(),
    verify: vi.fn(),
    get: vi.fn(get),
    deleteTombstoned: vi.fn(),
  };
}

describe("RevocableObjectReader", () => {
  it.each(["missing", "tombstoned"] satisfies ObjectVisibility[])(
    "returns the same private not-found result for %s state",
    async (visibility) => {
      const objects = objectStore(async () => undefined);
      const reader = new RevocableObjectReader(objects, {
        getVisibility: async () => visibility,
      });

      await expect(reader.get(locator)).resolves.toEqual({
        status: "not-found",
        cacheControl: privateObjectCacheControl,
      });
      expect(objects.get).not.toHaveBeenCalled();
    },
  );

  it("checks durable visibility on every read", async () => {
    const stored: StoredObject = {
      descriptor: {
        ...locator,
        key: `tenants/${locator.tenantId}/assets/11/${locator.sha256}`,
        contentType: "image/png",
        size: 0,
      },
      cacheControl: privateObjectCacheControl,
      stream: new ReadableStream<Uint8Array>(),
    };
    const objects = objectStore(async () => stored);
    let visibility: ObjectVisibility = "active";
    const reader = new RevocableObjectReader(objects, {
      getVisibility: async () => visibility,
    });

    await expect(reader.get(locator)).resolves.toEqual({
      status: "available",
      object: stored,
    });
    visibility = "tombstoned";
    await expect(reader.get(locator)).resolves.toEqual({
      status: "not-found",
      cacheControl: privateObjectCacheControl,
    });
    expect(objects.get).toHaveBeenCalledTimes(1);
  });

  it("does not return bytes when a tombstone commits during the object read", async () => {
    const cancel = vi.fn();
    const stored: StoredObject = {
      descriptor: {
        ...locator,
        key: `tenants/${locator.tenantId}/assets/11/${locator.sha256}`,
        contentType: "image/png",
        size: 0,
      },
      cacheControl: privateObjectCacheControl,
      stream: new ReadableStream<Uint8Array>({ cancel }),
    };
    const objects = objectStore(async () => stored);
    const visibility = vi
      .fn<() => Promise<ObjectVisibility>>()
      .mockResolvedValueOnce("active")
      .mockResolvedValueOnce("tombstoned");
    const reader = new RevocableObjectReader(objects, {
      getVisibility: visibility,
    });

    await expect(reader.get(locator)).resolves.toEqual({
      status: "not-found",
      cacheControl: privateObjectCacheControl,
    });
    expect(cancel).toHaveBeenCalledWith(
      "object was tombstoned during the read",
    );
  });

  it("keeps a tombstoned read private when stream cancellation rejects", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const stored: StoredObject = {
      descriptor: {
        ...locator,
        key: `tenants/${locator.tenantId}/assets/11/${locator.sha256}`,
        contentType: "image/png",
        size: 0,
      },
      cacheControl: privateObjectCacheControl,
      stream: new ReadableStream<Uint8Array>({ cancel }),
    };
    const reader = new RevocableObjectReader(
      objectStore(async () => stored),
      {
        getVisibility: vi
          .fn<() => Promise<ObjectVisibility>>()
          .mockResolvedValueOnce("active")
          .mockResolvedValueOnce("tombstoned"),
      },
    );

    await expect(reader.get(locator)).resolves.toEqual({
      status: "not-found",
      cacheControl: privateObjectCacheControl,
    });
    expect(cancel).toHaveBeenCalledWith(
      "object was tombstoned during the read",
    );
  });

  it("cancels a fetched body when the second visibility check fails", async () => {
    const cancel = vi.fn();
    const stored: StoredObject = {
      descriptor: {
        ...locator,
        key: `tenants/${locator.tenantId}/assets/11/${locator.sha256}`,
        contentType: "image/png",
        size: 0,
      },
      cacheControl: privateObjectCacheControl,
      stream: new ReadableStream<Uint8Array>({ cancel }),
    };
    const objects = objectStore(async () => stored);
    const visibility = vi
      .fn<() => Promise<ObjectVisibility>>()
      .mockResolvedValueOnce("active")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const reader = new RevocableObjectReader(objects, {
      getVisibility: visibility,
    });

    await expect(reader.get(locator)).rejects.toThrow("database unavailable");
    expect(cancel).toHaveBeenCalledWith("visibility check failed");
  });
});
