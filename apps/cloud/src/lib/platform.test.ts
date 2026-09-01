import { describe, expect, it, vi } from "vitest";

import type { PlatformRepository, PlatformUsage } from "./platform";
import {
  normalizeCustomHostname,
  PlatformService,
  PlatformUnavailableError,
  sha256,
} from "./platform";

const tenantId = "00000000-0000-4000-8000-000000000001";
const siteId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";

function repository(): PlatformRepository {
  return {
    getSite: vi.fn(),
    setSiteReaderAccess: vi.fn(),
    listCustomDomains: vi.fn().mockResolvedValue([]),
    createCustomDomain: vi.fn(async (input) => ({
      id: input.domainId,
      siteId: input.siteId,
      hostname: input.hostname,
      status: "pending" as const,
      challengeExpiresAt: input.challengeExpiresAt,
      createdAt: new Date(),
    })),
    recordCustomDomainCheck: vi.fn(async (input) => ({
      id: input.domainId,
      siteId,
      hostname: "docs.example.com",
      status: input.verified ? ("verified" as const) : ("failed" as const),
      challengeExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    })),
    disableCustomDomain: vi.fn(),
    listReaderGrants: vi.fn().mockResolvedValue([]),
    createReaderGrant: vi.fn(async (input) => ({
      id: input.grantId,
      siteId: input.siteId,
      label: input.label,
      expiresAt: input.expiresAt,
      maxRedemptions: input.maxRedemptions,
      redemptionCount: 0,
      createdAt: new Date(),
    })),
    revokeReaderGrant: vi.fn(),
    redeemReaderGrant: vi.fn().mockResolvedValue({
      tenantId,
      siteId,
      siteSlug: "guide",
      sessionExpiresAt: new Date(Date.now() + 60_000),
    }),
    getUsage: vi.fn().mockResolvedValue(emptyUsage()),
  };
}

describe("platform service", () => {
  it("creates a deterministic, secret-backed DNS challenge and verifies it", async () => {
    const repo = repository();
    let dnsValue = "";
    const txt = { resolve: vi.fn(async () => [[dnsValue]]) };
    const service = new PlatformService(repo, "s".repeat(32), txt);
    const created = await service.createCustomDomain({
      tenantId,
      userId,
      siteId,
      hostname: "Docs.Example.com.",
    });
    dnsValue = created.dnsValue;

    expect(created.hostname).toBe("docs.example.com");
    expect(created.dnsName).toBe("_knot.docs.example.com");
    expect(created.dnsValue).toMatch(/^knot-domain-verification=/u);
    expect(
      vi.mocked(repo.createCustomDomain).mock.calls[0]?.[0].challengeDigest,
    ).toBe(sha256(created.dnsValue.replace("knot-domain-verification=", "")));

    const verified = await service.verifyCustomDomain({
      tenantId,
      userId,
      domain: created,
    });
    expect(verified.status).toBe("verified");
    expect(txt.resolve).toHaveBeenCalledWith("_knot.docs.example.com");
  });

  it("fails closed when custom-domain verification is not configured", async () => {
    const service = new PlatformService(repository(), undefined, {
      resolve: vi.fn(),
    });
    expect(service.capabilities().customDomains).toEqual({
      available: false,
      reasonCode: "provider-not-configured",
    });
    await expect(
      service.createCustomDomain({
        tenantId,
        userId,
        siteId,
        hostname: "docs.example.com",
      }),
    ).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("stores only reader token digests and exchanges a valid grant for a session", async () => {
    const repo = repository();
    const service = new PlatformService(repo, undefined, { resolve: vi.fn() });
    const { token } = await service.createReaderGrant({
      tenantId,
      userId,
      siteId,
      label: "Reviewers",
      expiresAt: new Date(Date.now() + 60_000),
      maxRedemptions: 2,
    });
    const createInput = vi.mocked(repo.createReaderGrant).mock.calls[0]?.[0];

    expect(token).toMatch(/^knot_reader_[A-Za-z0-9_-]{43}$/u);
    expect(createInput?.tokenDigest).toBe(sha256(token));
    expect(JSON.stringify(createInput)).not.toContain(token);

    const redeemed = await service.redeemReaderGrant(token, "guide");
    expect(redeemed?.siteSlug).toBe("guide");
    expect(redeemed?.sessionToken).toMatch(/^knot_session_[A-Za-z0-9_-]{43}$/u);
    const redeemInput = vi.mocked(repo.redeemReaderGrant).mock.calls[0]?.[0];
    expect(redeemInput?.grantDigest).toBe(sha256(token));
    expect(redeemInput?.expectedSiteSlug).toBe("guide");
    expect(redeemInput?.sessionDigest).toBe(
      sha256(redeemed?.sessionToken ?? ""),
    );
    await expect(
      service.redeemReaderGrant("bad", "guide"),
    ).resolves.toBeUndefined();
  });

  it("accepts only bare, canonical hostnames", () => {
    expect(normalizeCustomHostname("Bücher.Example")).toBe(
      "xn--bcher-kva.example",
    );
    for (const value of [
      "https://docs.example.com",
      "docs.example.com:443",
      "user@docs.example.com",
      "localhost",
      "-bad.example",
    ]) {
      expect(() => normalizeCustomHostname(value)).toThrow(TypeError);
    }
  });
});

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
