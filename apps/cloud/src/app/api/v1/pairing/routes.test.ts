import { problemDetailsSchema } from "@imai/knot-cloud-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import { checkPairingPollRateLimit } from "@/lib/security/pairing-poll-rate-limit";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import {
  DELETE as revokeConnector,
  PATCH as renameConnector,
} from "../connectors/[connectorId]/route";
import { GET as listConnectors } from "../connectors/route";
import { POST as pollPairing } from "./poll/route";
import { PUT as decidePairing } from "./sessions/[pairingId]/route";
import { GET as listPairings, POST as createPairing } from "./sessions/route";

const repository = vi.hoisted(() => ({
  approve: vi.fn(),
  create: vi.fn(),
  deny: vi.fn(),
  listConnectors: vi.fn(),
  listReviews: vi.fn(),
  listSites: vi.fn(),
  poll: vi.fn(),
  rename: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@/lib/adapters/neon-pairing", () => ({
  NeonPairingRepository: function MockNeonPairingRepository() {
    return repository;
  },
}));
vi.mock("@/lib/auth", () => ({
  isTrustedHumanMutationOrigin: vi.fn(),
}));
vi.mock("@/lib/security/pairing-poll-rate-limit", () => ({
  checkPairingPollRateLimit: vi.fn(),
}));
vi.mock("@/lib/workspace-auth", () => ({
  getAuthorizedWorkspace: vi.fn(),
}));

const pairingId = "00000000-0000-4000-8000-000000000091";
const connectorId = "00000000-0000-4000-8000-000000000011";
const authorized = {
  identity: {
    session: { id: "session-1" },
    user: { email: "raj@example.test", id: "user-1", name: "Raj" },
  },
  workspace: {
    name: "Personal workspace",
    role: "owner" as const,
    suspended: false,
    tenantId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
  },
};

describe("pairing and connector routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(true);
    vi.mocked(checkPairingPollRateLimit).mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 1,
    });
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue(authorized);
  });

  it("rejects every credential class except the one-time poll token", async () => {
    const credentialHeaders: Record<string, string>[] = [
      { Authorization: "Bearer connector-secret" },
      { Cookie: "better-auth.session_token=human-session" },
      { "x-api-key": "consumer-key" },
      { "Knot-Connector-Id": connectorId },
    ];
    for (const headers of credentialHeaders) {
      const response = await pollPairing(
        request("/api/v1/pairing/poll", pollBody(), { headers }),
      );
      expect(response.status).toBe(400);
      const problem = problemDetailsSchema.parse(await response.json());
      expect(problem.code).toBe("invalid-request");
    }
    expect(repository.poll).not.toHaveBeenCalled();
  });

  it("does not substitute connector credentials for a human session", async () => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue(null);
    const response = await createPairing(
      request("/api/v1/pairing/sessions", createBody(), {
        headers: { Authorization: "Bearer connector-secret" },
      }),
    );
    expect(response.status).toBe(401);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("keeps malformed and unknown poll credentials indistinguishable", async () => {
    repository.poll.mockResolvedValue(undefined);
    const malformed = await pollPairing(
      request("/api/v1/pairing/poll", {
        ...pollBody(),
        pairingId: "not-a-uuid",
      }),
    );
    const unknown = await pollPairing(
      request("/api/v1/pairing/poll", pollBody()),
    );

    expect(malformed.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await malformed.json()).title).toBe((await unknown.json()).title);
  });

  it("rate limits unauthenticated poll attempts before repository access", async () => {
    vi.mocked(checkPairingPollRateLimit).mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 17,
    });
    const response = await pollPairing(
      request("/api/v1/pairing/poll", pollBody()),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(repository.poll).not.toHaveBeenCalled();
  });

  it("fails closed when poll protection is unavailable", async () => {
    vi.mocked(checkPairingPollRateLimit).mockRejectedValue(
      new Error("rate-limit store unavailable"),
    );
    const response = await pollPairing(
      request("/api/v1/pairing/poll", pollBody()),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("3");
    expect(repository.poll).not.toHaveBeenCalled();
  });

  it("allows only owners and admins to create or review pairing requests", async () => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue({
      ...authorized,
      workspace: { ...authorized.workspace, role: "member" },
    });
    const created = await createPairing(
      request("/api/v1/pairing/sessions", createBody()),
    );
    expect(created.status).toBe(403);

    const decision = await decidePairing(
      request(`/api/v1/pairing/sessions/${pairingId}`, approvalBody(), {
        method: "PUT",
      }),
      { params: Promise.resolve({ pairingId }) },
    );
    expect(decision.status).toBe(403);
    expect(repository.approve).not.toHaveBeenCalled();
  });

  it("reports scope escalation without creating a connector", async () => {
    repository.approve.mockResolvedValue({ outcome: "scope-escalation" });
    const response = await decidePairing(
      request(`/api/v1/pairing/sessions/${pairingId}`, approvalBody(), {
        method: "PUT",
      }),
      { params: Promise.resolve({ pairingId }) },
    );
    expect(response.status).toBe(409);
    const problem = problemDetailsSchema.parse(await response.json());
    expect(problem.code).toBe("scope-denied");
  });

  it("maps an authorization race to forbidden instead of conflict", async () => {
    repository.approve.mockResolvedValue({ outcome: "forbidden" });
    const response = await decidePairing(
      request(`/api/v1/pairing/sessions/${pairingId}`, approvalBody(), {
        method: "PUT",
      }),
      { params: Promise.resolve({ pairingId }) },
    );
    expect(response.status).toBe(403);
  });

  it("rejects cross-origin human mutations including connector deletion", async () => {
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(false);
    const responses = await Promise.all([
      createPairing(request("/api/v1/pairing/sessions", createBody())),
      decidePairing(
        request(`/api/v1/pairing/sessions/${pairingId}`, approvalBody(), {
          method: "PUT",
        }),
        { params: Promise.resolve({ pairingId }) },
      ),
      renameConnector(
        request(
          `/api/v1/connectors/${connectorId}`,
          { name: "Changed" },
          {
            method: "PATCH",
          },
        ),
        { params: Promise.resolve({ connectorId }) },
      ),
      revokeConnector(
        request(`/api/v1/connectors/${connectorId}`, null, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ connectorId }) },
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403, 403,
    ]);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.approve).not.toHaveBeenCalled();
    expect(repository.rename).not.toHaveBeenCalled();
    expect(repository.revoke).not.toHaveBeenCalled();
  });

  it("returns connector and pairing status only to an authenticated workspace", async () => {
    repository.listConnectors.mockResolvedValue([]);
    repository.listReviews.mockResolvedValue([]);
    const connectors = await listConnectors(
      new Request("https://knot.example/api/v1/connectors"),
    );
    const pairings = await listPairings(
      new Request("https://knot.example/api/v1/pairing/sessions"),
    );
    expect(connectors.status).toBe(200);
    expect(pairings.status).toBe(200);

    vi.mocked(getAuthorizedWorkspace).mockResolvedValue(null);
    const denied = await listConnectors(
      new Request("https://knot.example/api/v1/connectors"),
    );
    expect(denied.status).toBe(401);
  });

  it("revokes an exact UUID and rejects malformed connector IDs", async () => {
    repository.revoke.mockResolvedValue(true);
    const revoked = await revokeConnector(
      request(`/api/v1/connectors/${connectorId}`, null, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ connectorId }) },
    );
    const malformed = await revokeConnector(
      request("/api/v1/connectors/not-a-uuid", null, { method: "DELETE" }),
      { params: Promise.resolve({ connectorId: "not-a-uuid" }) },
    );
    expect(revoked.status).toBe(200);
    expect(malformed.status).toBe(400);
    expect(repository.revoke).toHaveBeenCalledTimes(1);
  });

  it("binds connector management to the authorized tenant", async () => {
    repository.rename.mockResolvedValue(true);
    const response = await renameConnector(
      request(
        `/api/v1/connectors/${connectorId}`,
        { name: "Office Mac" },
        {
          method: "PATCH",
        },
      ),
      { params: Promise.resolve({ connectorId }) },
    );
    expect(response.status).toBe(200);
    expect(repository.rename).toHaveBeenCalledWith({
      actorUserId: authorized.workspace.userId,
      connectorId,
      name: "Office Mac",
      tenantId: authorized.workspace.tenantId,
    });
  });
});

function createBody() {
  return {
    connectorName: "Raj's laptop",
    protocolVersion: "1.0",
    publicKey: "b".repeat(43),
    requestedScopes: ["anytype.objects.read"],
    requestedSiteIds: [],
    requestedSlugGrants: [],
  };
}

function approvalBody() {
  return {
    decision: "approve",
    grant: {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    },
    pairingId,
    protocolVersion: "1.0",
  };
}

function pollBody() {
  return {
    pairingId,
    pollToken: "a".repeat(43),
    protocolVersion: "1.0",
  };
}

function request(
  pathname: string,
  body: unknown,
  options?: { headers?: Record<string, string>; method?: string },
) {
  return new Request(`https://knot.example${pathname}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://knot.example",
      ...options?.headers,
    },
    method: options?.method ?? "POST",
  });
}
