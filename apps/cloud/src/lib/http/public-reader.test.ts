import { describe, expect, it, vi } from "vitest";

import type {
  PublicAssetStore,
  PublicReaderRepository,
} from "@/lib/public-reader";

import { createPublicReaderHandlers, publicReaderCsp } from "./public-reader";

const tenantId = "00000000-0000-4000-8000-000000000001";
const siteId = "00000000-0000-4000-8000-000000000002";
const publicationId = "00000000-0000-4000-8000-000000000003";
const versionId = "00000000-0000-4000-8000-000000000004";
const digest = "a".repeat(64);
const page = {
  tenantId,
  siteId,
  publicationId,
  versionId,
  document: {
    schemaVersion: "1.0" as const,
    title: "Safe guide",
    blocks: [
      {
        type: "image" as const,
        assetDigest: digest,
        alt: "Cover",
      },
    ],
  },
  contentSha256: "b".repeat(64),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};
const environment = { baseUrl: new URL("https://pages.example.org") };

function dependencies(input?: {
  resolvePage?: PublicReaderRepository["resolvePage"];
  resolveAsset?: PublicReaderRepository["resolveAsset"];
  resolveSiteAccess?: PublicReaderRepository["resolveSiteAccess"];
  resolveCustomDomainSite?: PublicReaderRepository["resolveCustomDomainSite"];
  get?: PublicAssetStore["get"];
}) {
  const repository: PublicReaderRepository = {
    resolvePage: input?.resolvePage ?? vi.fn().mockResolvedValue(page),
    resolveAsset:
      input?.resolveAsset ??
      vi.fn().mockResolvedValue({
        tenantId,
        publicationId,
        versionId,
        sha256: digest,
        contentType: "image/png",
        byteSize: 3,
      }),
    ...(input?.resolveSiteAccess
      ? { resolveSiteAccess: input.resolveSiteAccess }
      : {}),
    ...(input?.resolveCustomDomainSite
      ? { resolveCustomDomainSite: input.resolveCustomDomainSite }
      : {}),
  };
  const objects: PublicAssetStore = {
    get:
      input?.get ??
      vi.fn().mockResolvedValue({
        descriptor: {
          tenantId,
          sha256: digest,
          key: "private-key",
          contentType: "image/png",
          size: 3,
        },
        cacheControl: "private, no-store, max-age=0",
        stream: bytes([1, 2, 3]),
      }),
  };
  return { repository, objects };
}

describe("public reader", () => {
  it("fails closed when the reader origin is absent or the host mismatches", async () => {
    const deps = dependencies();
    const disabled = createPublicReaderHandlers({
      ...deps,
      environment: undefined,
    });
    expect(
      (
        await disabled.page(
          request("https://pages.example.org/p/demo/guide"),
          "demo",
          "guide",
        )
      ).status,
    ).toBe(404);
    const handler = createPublicReaderHandlers({ ...deps, environment });
    expect(
      (
        await handler.page(
          request("https://knot.imai.tech/p/demo/guide"),
          "demo",
          "guide",
        )
      ).status,
    ).toBe(404);
    expect(deps.repository.resolvePage).not.toHaveBeenCalled();
  });

  it("serves typed HTML without cookies and with a restrictive CSP", async () => {
    const deps = dependencies();
    const response = await createPublicReaderHandlers({
      ...deps,
      environment,
    }).page(
      request("https://pages.example.org/p/demo/guide", "session=dashboard"),
      "demo",
      "guide",
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      publicReaderCsp,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(html).toContain(`/media/demo/${publicationId}/${digest}`);
    expect(html).not.toContain("session=dashboard");
    expect(deps.repository.resolvePage).toHaveBeenCalledTimes(2);
  });

  it("returns 404 when disable or rollback changes visibility during rendering", async () => {
    const deps = dependencies({
      resolvePage: vi
        .fn()
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce(undefined),
    });
    const response = await createPublicReaderHandlers({
      ...deps,
      environment,
    }).page(request("https://pages.example.org/p/demo/guide"), "demo", "guide");
    expect(response.status).toBe(404);
  });

  it("redirects authenticated sites to grant exchange and hashes valid session cookies", async () => {
    const resolvePage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page);
    const deps = dependencies({
      resolvePage,
      resolveSiteAccess: vi.fn().mockResolvedValue("authenticated"),
    });
    const handler = createPublicReaderHandlers({ ...deps, environment });
    const redirect = await handler.page(
      request("https://pages.example.org/p/demo/guide"),
      "demo",
      "guide",
    );
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("Location")).toBe(
      "https://pages.example.org/access/demo?next=%2Fp%2Fdemo%2Fguide",
    );

    const token = `knot_session_${"a".repeat(43)}`;
    const response = await handler.page(
      request(
        "https://pages.example.org/p/demo/guide",
        `ignored=x; knot_reader_session=${token}`,
      ),
      "demo",
      "guide",
    );
    expect(response.status).toBe(200);
    expect(resolvePage).toHaveBeenLastCalledWith({
      siteSlug: "demo",
      publicationSlug: "guide",
      sessionDigest:
        "be174c48b342abe96669d10364763aafb981f31ad57b64134094d1ace737fb66",
    });
  });

  it("serves a site only through its verified custom-domain mapping", async () => {
    const deps = dependencies({
      resolveCustomDomainSite: vi.fn(async (hostname) =>
        hostname === "notes.example.org"
          ? { siteSlug: "demo", readerAccess: "public" as const }
          : undefined,
      ),
    });
    const handler = createPublicReaderHandlers({ ...deps, environment });
    const response = await handler.customPage(
      request("https://notes.example.org/guide"),
      "guide",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      'rel="canonical" href="https://notes.example.org/guide"',
    );
    expect(deps.repository.resolveCustomDomainSite).toHaveBeenCalledWith(
      "notes.example.org",
    );
  });

  it("rechecks active-version membership after the private object read", async () => {
    let cancelled = false;
    const deps = dependencies({
      resolveAsset: vi
        .fn()
        .mockResolvedValueOnce({
          tenantId,
          publicationId,
          versionId,
          sha256: digest,
          contentType: "image/png",
          byteSize: 3,
        })
        .mockResolvedValueOnce(undefined),
      get: vi.fn().mockResolvedValue({
        descriptor: {
          tenantId,
          sha256: digest,
          key: "private-key",
          contentType: "image/png",
          size: 3,
        },
        cacheControl: "private, no-store, max-age=0",
        stream: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });
    const response = await createPublicReaderHandlers({
      ...deps,
      environment,
    }).media(
      request(
        `https://pages.example.org/media/demo/${publicationId}/${digest}`,
      ),
      "demo",
      publicationId,
      digest,
    );
    expect(response.status).toBe(404);
    expect(cancelled).toBe(true);
  });

  it("forces unsafe media types to download and applies CSP to media", async () => {
    const deps = dependencies({
      resolveAsset: vi.fn().mockResolvedValue({
        tenantId,
        publicationId,
        versionId,
        sha256: digest,
        contentType: "image/svg+xml",
        byteSize: 3,
      }),
      get: vi.fn().mockResolvedValue({
        descriptor: {
          tenantId,
          sha256: digest,
          key: "private-key",
          contentType: "image/svg+xml",
          size: 3,
        },
        cacheControl: "private, no-store, max-age=0",
        stream: bytes([1, 2, 3]),
      }),
    });
    const response = await createPublicReaderHandlers({
      ...deps,
      environment,
    }).media(
      request(
        `https://pages.example.org/media/demo/${publicationId}/${digest}`,
      ),
      "demo",
      publicationId,
      digest,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment/u);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      publicReaderCsp,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

function request(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { Cookie: cookie } : undefined });
}

function bytes(values: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(values));
      controller.close();
    },
  });
}
