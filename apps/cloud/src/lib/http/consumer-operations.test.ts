import { createApiKey } from "@/lib/security/api-key";
import { authenticateConsumerApiKey } from "@/lib/security/consumer-api-key";
import {
  ConsumerDataError,
  type ConsumerDataRepository,
  type ResolvedConsumerApiKey,
} from "@/lib/consumer-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createConsumerOperationHandlers } from "./consumer-operations";

const now = new Date("2026-09-01T12:00:00Z");
const tenantId = "00000000-0000-4000-8000-000000000001";
const apiKeyId = "00000000-0000-4000-8000-000000000002";
const connectorId = "00000000-0000-4000-8000-000000000003";
const commandId = "00000000-0000-4000-8000-000000000004";

const credential: ResolvedConsumerApiKey = {
  id: apiKeyId,
  tenantId,
  keyId: "abcdefghijklmnop",
  keyDigest: "0".repeat(64),
  digestVersion: 1,
  scopes: ["anytype.objects.read"],
  connectorIds: [connectorId],
  expiresAt: null,
  revokedAt: null,
  requestsPerMinute: 60,
  requestsPerDay: 10_000,
};

function repository(): ConsumerDataRepository {
  return {
    resolveApiKey: vi.fn(),
    rehashApiKey: vi.fn(),
    listApiKeys: vi.fn(),
    getApiKey: vi.fn(),
    createApiKey: vi.fn(),
    rotateApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    enqueueOperation: vi.fn().mockResolvedValue({
      commandId,
      state: "pending",
      created: true,
    }),
    getOperation: vi.fn(),
  };
}

function request(operation: unknown, key = "operation-key-0001") {
  const createdAt = Math.floor(now.getTime() / 1_000);
  return new Request("https://knot.test/api/v1/operations", {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: "1.0",
      connectorId,
      idempotencyKey: key,
      createdAt,
      expiresAt: createdAt + 600,
      operation,
    }),
  });
}

describe("consumer Anytype operations", () => {
  let data: ConsumerDataRepository;

  beforeEach(() => {
    data = repository();
  });

  it("accepts only a typed operation and returns its durable command ID", async () => {
    const handlers = createConsumerOperationHandlers({
      repository: data,
      authenticate: () => Promise.resolve(credential),
      actorDigest: () => ({ digest: "a".repeat(64), version: 1 }),
      now: () => now,
    });
    const response = await handlers.submit(
      request({
        type: "object.read",
        spaceId: "space-1",
        objectId: "object-1",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      operationId: commandId,
      statusUrl: `/api/v1/operations/${commandId}`,
    });
    expect(data.enqueueOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        apiKeyId,
        connectorId,
        requiredScope: "anytype.objects.read",
        actorDigest: "a".repeat(64),
      }),
    );
  });

  it("rejects arbitrary execution, scope mismatch, and connector mismatch", async () => {
    const submit = (current: ResolvedConsumerApiKey, operation: unknown) =>
      createConsumerOperationHandlers({
        repository: data,
        authenticate: () => Promise.resolve(current),
        actorDigest: () => ({ digest: "a".repeat(64), version: 1 }),
        now: () => now,
      }).submit(request(operation));

    expect(
      (await submit(credential, { type: "execute", prompt: "run ls" })).status,
    ).toBe(400);
    expect(
      (
        await submit(credential, {
          type: "object.update",
          spaceId: "space-1",
          objectId: "object-1",
          properties: { name: "changed" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await submit(
          { ...credential, connectorIds: ["another-connector"] },
          { type: "object.read", spaceId: "space-1", objectId: "object-1" },
        )
      ).status,
    ).toBe(403);
    expect(data.enqueueOperation).not.toHaveBeenCalled();
  });

  it("maps durable quota and idempotency failures without leaking details", async () => {
    const operation = {
      type: "object.read",
      spaceId: "space-1",
      objectId: "object-1",
    };
    const responses = [];
    for (const error of [
      new ConsumerDataError("quota-exceeded", "API key quota exceeded"),
      new ConsumerDataError(
        "idempotency-conflict",
        "The idempotency key was used for another request",
      ),
    ]) {
      vi.mocked(data.enqueueOperation).mockRejectedValueOnce(error);
      responses.push(
        await createConsumerOperationHandlers({
          repository: data,
          authenticate: () => Promise.resolve(credential),
          actorDigest: () => ({ digest: "a".repeat(64), version: 1 }),
          now: () => now,
        }).submit(request(operation)),
      );
    }
    expect(responses.map((response) => response.status)).toEqual([429, 409]);
    await expect(responses[0]!.json()).resolves.not.toHaveProperty("keyId");
  });

  it("binds status lookup to the authenticated tenant and API key", async () => {
    vi.mocked(data.getOperation).mockResolvedValue(undefined);
    const response = await createConsumerOperationHandlers({
      repository: data,
      authenticate: () => Promise.resolve(credential),
    }).status(
      new Request(`https://knot.test/api/v1/operations/${commandId}`, {
        headers: { Authorization: "Bearer test" },
      }),
      commandId,
    );
    expect(response.status).toBe(404);
    expect(data.getOperation).toHaveBeenCalledWith({
      tenantId,
      apiKeyId,
      commandId,
    });
  });
});

describe("consumer API-key authentication", () => {
  it("rejects revoked and expired keys and rehashes a previous-pepper key", async () => {
    const oldPepper = { version: 1, value: "o".repeat(32) };
    const currentPepper = { version: 2, value: "n".repeat(32) };
    const generated = createApiKey(oldPepper);
    const data = repository();
    const record: ResolvedConsumerApiKey = {
      ...credential,
      keyId: generated.keyId,
      keyDigest: generated.digest,
      digestVersion: generated.digestVersion,
    };
    vi.mocked(data.resolveApiKey).mockResolvedValue(record);

    await expect(
      authenticateConsumerApiKey({
        authorization: `Bearer ${generated.secret}`,
        repository: data,
        peppers: [currentPepper, oldPepper],
        now,
      }),
    ).resolves.toMatchObject({ id: apiKeyId });
    expect(data.rehashApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ digestVersion: 2, expectedDigestVersion: 1 }),
    );

    for (const inactive of [
      { revokedAt: new Date(now.getTime() - 1) },
      { expiresAt: new Date(now.getTime() - 1) },
    ]) {
      vi.mocked(data.resolveApiKey).mockResolvedValue({
        ...record,
        ...inactive,
      });
      await expect(
        authenticateConsumerApiKey({
          authorization: `Bearer ${generated.secret}`,
          repository: data,
          peppers: [oldPepper],
          now,
        }),
      ).rejects.toMatchObject({ code: "authentication-required" });
    }
  });
});
