import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import type { PlatformRepository, PlatformUsage } from "@/lib/platform";
import { PlatformService } from "@/lib/platform";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { createPlatformHandlers } from "./platform";

vi.mock("@/lib/auth", () => ({
  isTrustedHumanMutationOrigin: vi.fn(),
}));
vi.mock("@/lib/workspace-auth", () => ({
  getAuthorizedWorkspace: vi.fn(),
}));

const tenantId = "00000000-0000-4000-8000-000000000001";
const siteId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";

const authorized = {
  identity: {
    session: { id: "session-1" },
    user: { email: "owner@example.test", id: "user-1", name: "Owner" },
  },
  workspace: {
    name: "Workspace",
    role: "owner" as const,
    suspended: false,
    tenantId,
    userId,
  },
};

describe("platform HTTP service", () => {
  beforeEach(() => {
    vi.mocked(getAuthorizedWorkspace).mockReset();
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue(authorized);
    vi.mocked(isTrustedHumanMutationOrigin).mockReset();
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(true);
  });

  it("allows reads but rejects platform mutations from a non-admin member", async () => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue({
      ...authorized,
      workspace: { ...authorized.workspace, role: "member" },
    });
    const repo = repository();
    const handlers = handlersFor(repo);
    const read = await handlers.getPlatform(
      new Request("https://knot.test/api/v1/session/platform"),
    );
    expect(read.status).toBe(200);

    const mutation = await handlers.updateSiteAccess(
      jsonRequest(`/api/v1/session/sites/${siteId}/access`, {
        readerAccess: "authenticated",
      }),
      siteId,
    );
    expect(mutation.status).toBe(403);
    expect(repo.setSiteReaderAccess).not.toHaveBeenCalled();
  });

  it("fails closed when custom-domain verification has no server secret", async () => {
    const repo = repository({
      listCustomDomains: vi.fn().mockResolvedValue([
        {
          id: "00000000-0000-4000-8000-000000000004",
          siteId,
          hostname: "docs.example.com",
          status: "pending",
          challengeExpiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
        },
      ]),
    });
    const handlers = handlersFor(repo);
    const list = await handlers.listDomains(
      new Request(`https://knot.test/api/v1/session/sites/${siteId}/domains`),
      siteId,
    );
    expect(list.status).toBe(200);
    expect((await list.json()) as unknown).toMatchObject([
      { hostname: "docs.example.com", status: "pending" },
    ]);

    const response = await handlers.createDomain(
      jsonRequest(`/api/v1/session/sites/${siteId}/domains`, {
        hostname: "docs.example.com",
      }),
      siteId,
    );
    expect(response.status).toBe(503);
    expect(repo.createCustomDomain).not.toHaveBeenCalled();
  });

  it("returns an explicit quota response for database-enforced limits", async () => {
    const repo = repository({
      createReaderGrant: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("limit"), { code: "P0001" }),
        ),
    });
    const response = await handlersFor(repo).createReaderGrant(
      jsonRequest(`/api/v1/session/sites/${siteId}/reader-grants`, {
        label: "Reviewers",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxRedemptions: 1,
      }),
      siteId,
    );
    expect(response.status).toBe(429);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "quota-exceeded",
    });
  });
});

function handlersFor(repo: PlatformRepository) {
  return createPlatformHandlers({
    repository: repo,
    service: new PlatformService(repo, undefined, { resolve: vi.fn() }),
  });
}

function repository(
  overrides: Partial<PlatformRepository> = {},
): PlatformRepository {
  return {
    getSite: vi.fn().mockResolvedValue({
      id: siteId,
      slug: "guide",
      readerAccess: "public",
    }),
    setSiteReaderAccess: vi.fn().mockResolvedValue(true),
    listCustomDomains: vi.fn().mockResolvedValue([]),
    createCustomDomain: vi.fn(),
    recordCustomDomainCheck: vi.fn(),
    disableCustomDomain: vi.fn(),
    listReaderGrants: vi.fn().mockResolvedValue([]),
    createReaderGrant: vi.fn(),
    revokeReaderGrant: vi.fn(),
    redeemReaderGrant: vi.fn(),
    getUsage: vi.fn().mockResolvedValue(emptyUsage()),
    ...overrides,
  };
}

function emptyUsage(): PlatformUsage {
  const counter = { used: 0, limit: 1 };
  return {
    sites: counter,
    customDomains: counter,
    readerGrants: counter,
    apiKeys: counter,
    connectors: counter,
    storageBytes: counter,
    derivativeJobs: counter,
  };
}

function jsonRequest(pathname: string, body: unknown) {
  return new Request(`https://knot.test${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://knot.test",
    },
    body: JSON.stringify(body),
  });
}
