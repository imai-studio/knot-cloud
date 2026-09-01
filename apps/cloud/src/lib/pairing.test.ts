import { describe, expect, it, vi } from "vitest";

import {
  createPairingSession,
  digestPollToken,
  pollPairingSession,
  type PairingRepository,
} from "./pairing";

import type { AuthorizedWorkspace } from "./workspace-auth";

const pairingId = "00000000-0000-4000-8000-000000000091";
const tenantId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000081";
const pollToken = "a".repeat(43);

describe("connector pairing service", () => {
  it("returns the poll token once while persisting only its digest", async () => {
    const repository = pairingRepository();
    vi.mocked(repository.create).mockResolvedValue(pairingId);
    const now = new Date("2026-09-01T12:00:00.000Z");

    const result = await createPairingSession(
      workspace("owner"),
      pairingRequest(),
      repository,
      { baseUrl: "https://knot.example", now, pollToken },
    );

    expect(result).toEqual({
      authorizationUrl: `https://knot.example/dashboard?view=connectors&pairing=${pairingId}`,
      expiresAt: 1_788_264_600,
      pairingId,
      pollAfterSeconds: 3,
      pollToken,
      protocolVersion: "1.0",
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: userId,
        pollTokenDigest: digestPollToken(pollToken),
        tenantId,
      }),
    );
    expect(repository.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ pollToken }),
    );
  });

  it("does not create a request for an ordinary member", async () => {
    const repository = pairingRepository();
    await expect(
      createPairingSession(workspace("member"), pairingRequest(), repository, {
        baseUrl: "https://knot.example",
        pollToken,
      }),
    ).resolves.toBeNull();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("hashes a poll token before repository access", async () => {
    const repository = pairingRepository();
    vi.mocked(repository.poll).mockResolvedValue({
      expiresAt: 1_788_264_600,
      pairingId,
      protocolVersion: "1.0",
      status: "pending",
    });

    await expect(
      pollPairingSession({ pairingId, pollToken }, repository),
    ).resolves.toMatchObject({ status: "pending" });
    expect(repository.poll).toHaveBeenCalledWith(
      expect.objectContaining({
        pairingId,
        pollTokenDigest: digestPollToken(pollToken),
      }),
    );
  });
});

function pairingRequest() {
  return {
    connectorName: "Raj's laptop",
    protocolVersion: "1.0" as const,
    publicKey: "b".repeat(43),
    requestedScopes: ["anytype.objects.read" as const],
    requestedSlugGrants: ["notes/project/*"],
  };
}

function workspace(role: "owner" | "admin" | "member"): AuthorizedWorkspace {
  return {
    identity: {
      session: { id: "auth-session" },
      user: { email: "raj@example.test", id: "auth-user", name: "Raj" },
    },
    workspace: {
      name: "Raj's workspace",
      role,
      suspended: false,
      tenantId,
      userId,
    },
  };
}

function pairingRepository(): PairingRepository {
  return {
    approve: vi.fn(),
    create: vi.fn(),
    deny: vi.fn(),
    listConnectors: vi.fn(),
    listReviews: vi.fn(),
    poll: vi.fn(),
    rename: vi.fn(),
    revoke: vi.fn(),
  };
}
