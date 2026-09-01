import type { ConsumerDataRepository } from "@/lib/consumer-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { createSessionApiKeyHandlers } from "./session-api-keys";

vi.mock("@/lib/auth", () => ({
  isTrustedHumanMutationOrigin: vi.fn(() => true),
}));
vi.mock("@/lib/workspace-auth", () => ({
  getAuthorizedWorkspace: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  getApiKeyPeppers: () => [{ version: 1, value: "p".repeat(32) }],
}));

const tenantId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const apiKeyId = "00000000-0000-4000-8000-000000000003";
const connectorId = "00000000-0000-4000-8000-000000000004";
const metadata = {
  id: apiKeyId,
  name: "Reporting",
  keyId: "abcdefghijklmnop",
  scopes: ["anytype.objects.read" as const],
  connectorIds: [connectorId],
  expiresAt: null,
  revokedAt: null,
  createdAt: 1_788_264_000,
  requestsPerMinute: 60,
  requestsPerDay: 10_000,
};

function repository(): ConsumerDataRepository {
  return {
    resolveApiKey: vi.fn(),
    rehashApiKey: vi.fn(),
    listApiKeys: vi.fn().mockResolvedValue([metadata]),
    getApiKey: vi.fn().mockResolvedValue(metadata),
    createApiKey: vi.fn().mockResolvedValue(metadata),
    rotateApiKey: vi.fn().mockResolvedValue(metadata),
    revokeApiKey: vi.fn().mockResolvedValue(true),
    enqueueOperation: vi.fn(),
    getOperation: vi.fn(),
  };
}

describe("human API-key controls", () => {
  beforeEach(() => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue({
      identity: {
        session: { id: "session" },
        user: { id: "auth-user", email: "raj@example.test", name: "Raj" },
      },
      workspace: {
        tenantId,
        userId,
        name: "Personal workspace",
        role: "owner",
        suspended: false,
      },
    });
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(true);
  });

  it("creates, lists, and inspects keys without returning stored digests", async () => {
    const data = repository();
    const handlers = createSessionApiKeyHandlers(data);
    const create = await handlers.create(
      new Request("https://knot.test/api/v1/session/api-keys", {
        method: "POST",
        headers: {
          Origin: "https://knot.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Reporting",
          scopes: ["anytype.objects.read"],
          connectorIds: [connectorId],
        }),
      }),
    );
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.secret).toMatch(/^knot_live_/u);
    expect(created.apiKey).not.toHaveProperty("keyDigest");
    expect((await handlers.list(new Request("https://knot.test"))).status).toBe(
      200,
    );
    expect(
      (await handlers.inspect(new Request("https://knot.test"), apiKeyId))
        .status,
    ).toBe(200);
  });

  it("rotates once, revokes idempotently, and rejects untrusted mutations", async () => {
    const data = repository();
    const handlers = createSessionApiKeyHandlers(data);
    const rotate = await handlers.rotate(
      new Request("https://knot.test", { method: "POST" }),
      apiKeyId,
    );
    expect(rotate.status).toBe(200);
    expect((await rotate.json()).secret).toMatch(/^knot_live_/u);
    expect(
      (await handlers.revoke(new Request("https://knot.test"), apiKeyId))
        .status,
    ).toBe(204);

    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(false);
    expect(
      (await handlers.rotate(new Request("https://evil.test"), apiKeyId))
        .status,
    ).toBe(403);
  });

  it("denies member sessions", async () => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue({
      identity: {
        session: { id: "session" },
        user: { id: "auth-user", email: "member@example.test", name: "Member" },
      },
      workspace: {
        tenantId,
        userId,
        name: "Personal workspace",
        role: "member",
        suspended: false,
      },
    });
    expect(
      (
        await createSessionApiKeyHandlers(repository()).list(
          new Request("https://knot.test"),
        )
      ).status,
    ).toBe(403);
  });
});
