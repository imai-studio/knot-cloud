import { describe, expect, it, vi } from "vitest";

import type { PublicReaderRepository } from "@/lib/public-reader";

import { readerUrlFromHeaders, resolveReaderOrigin } from "./reader-origin";

const environment = { baseUrl: new URL("https://pages.example.org") };

function repository(): PublicReaderRepository {
  return {
    resolvePage: vi.fn(),
    resolveAsset: vi.fn(),
    resolveCustomDomainSite: vi.fn(async (hostname) =>
      hostname === "notes.example.org"
        ? { siteSlug: "demo", readerAccess: "authenticated" as const }
        : undefined,
    ),
  };
}

describe("reader origin authorization", () => {
  it("accepts the isolated content origin and an exact verified site mapping", async () => {
    const repo = repository();
    await expect(
      resolveReaderOrigin({
        url: new URL("https://pages.example.org"),
        environment,
        repository: repo,
        siteSlug: "demo",
      }),
    ).resolves.toBe("content");
    await expect(
      resolveReaderOrigin({
        url: new URL("https://notes.example.org"),
        environment,
        repository: repo,
        siteSlug: "demo",
      }),
    ).resolves.toBe("custom");
  });

  it("fails closed without configuration or for an unknown, wrong-site, insecure, or ported host", async () => {
    const repo = repository();
    for (const [url, siteSlug] of [
      ["https://unknown.example.org", "demo"],
      ["https://notes.example.org", "other"],
      ["http://notes.example.org", "demo"],
      ["https://notes.example.org:8443", "demo"],
    ] as const) {
      await expect(
        resolveReaderOrigin({
          url: new URL(url),
          environment,
          repository: repo,
          siteSlug,
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      resolveReaderOrigin({
        url: new URL("https://pages.example.org"),
        environment: undefined,
        repository: repo,
        siteSlug: "demo",
      }),
    ).resolves.toBeUndefined();
  });

  it("constructs an origin only from canonical forwarded host metadata", () => {
    expect(
      readerUrlFromHeaders(
        new Headers({
          "x-forwarded-host": "notes.example.org",
          "x-forwarded-proto": "https",
        }),
      )?.origin,
    ).toBe("https://notes.example.org");
    expect(
      readerUrlFromHeaders(
        new Headers({ host: "notes.example.org", "x-forwarded-proto": "ftp" }),
      ),
    ).toBeUndefined();
  });
});
