import { renderPublication } from "@imai/knot-publication-renderer";

import { NeonPublicReaderRepository } from "@/lib/adapters/neon-public-reader";
import { createPublicAssetStore } from "@/lib/adapters/factory";
import { getContentEnvironment, type ContentEnvironment } from "@/lib/env";
import { readerCookieName } from "@/lib/http/reader-sessions";
import { sha256 } from "@/lib/platform";
import type {
  PublicAssetStore,
  PublicReaderRepository,
} from "@/lib/public-reader";
import { resolveReaderOrigin } from "@/lib/reader-origin";

const siteSlugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const publicationSlugPattern = /^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const safeInlineMediaTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const publicReaderCsp = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
].join("; ");

export function createPublicReaderHandlers(dependencies: {
  repository: PublicReaderRepository;
  objects: PublicAssetStore;
  environment: ContentEnvironment | undefined;
}) {
  return {
    async page(
      request: Request,
      siteSlug: string,
      publicationSlug: string,
    ): Promise<Response> {
      if (
        !siteSlugPattern.test(siteSlug) ||
        !publicationSlugPattern.test(publicationSlug) ||
        publicationSlug.includes("//")
      ) {
        return notFound();
      }
      try {
        if (
          !(await acceptsReaderRequest(
            request,
            dependencies.environment,
            dependencies.repository,
            siteSlug,
          ))
        ) {
          return notFound();
        }
        const sessionDigest = readerSessionDigest(request, siteSlug);
        const first = await dependencies.repository.resolvePage({
          siteSlug,
          publicationSlug,
          ...(sessionDigest ? { sessionDigest } : {}),
        });
        if (!first) {
          return (await requiresReaderAccess(dependencies.repository, siteSlug))
            ? readerAccessRedirect(request, siteSlug)
            : notFound();
        }
        const baseUrl = dependencies.environment!.baseUrl;
        const canonicalUrl = new URL(
          `/p/${encodeURIComponent(siteSlug)}/${publicationSlug
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          baseUrl,
        ).toString();
        const html = renderPublication(first.document, {
          canonicalUrl,
          mediaUrl: (digest) =>
            `/media/${encodeURIComponent(siteSlug)}/${encodeURIComponent(first.publicationId)}/${encodeURIComponent(digest)}`,
        });
        const second = await dependencies.repository.resolvePage({
          siteSlug,
          publicationSlug,
          ...(sessionDigest ? { sessionDigest } : {}),
        });
        if (!second || second.versionId !== first.versionId) return notFound();
        return new Response(html, {
          status: 200,
          headers: readerHeaders({
            contentType: "text/html; charset=utf-8",
            authenticated: !!sessionDigest,
          }),
        });
      } catch {
        return unavailable();
      }
    },

    async customPage(
      request: Request,
      publicationSlug: string,
    ): Promise<Response> {
      if (
        !publicationSlugPattern.test(publicationSlug) ||
        publicationSlug.includes("//") ||
        !dependencies.repository.resolveCustomDomainSite
      ) {
        return notFound();
      }
      try {
        const url = new URL(request.url);
        if (!dependencies.environment) return notFound();
        const site = await dependencies.repository.resolveCustomDomainSite(
          url.hostname.toLowerCase(),
        );
        if (!site) return notFound();
        if (
          (await resolveReaderOrigin({
            url,
            environment: dependencies.environment,
            repository: dependencies.repository,
            siteSlug: site.siteSlug,
          })) !== "custom"
        ) {
          return notFound();
        }
        const sessionDigest = readerSessionDigest(request, site.siteSlug);
        const first = await dependencies.repository.resolvePage({
          siteSlug: site.siteSlug,
          publicationSlug,
          ...(sessionDigest ? { sessionDigest } : {}),
        });
        if (!first) {
          return site.readerAccess === "authenticated"
            ? readerAccessRedirect(request, site.siteSlug)
            : notFound();
        }
        const canonicalUrl = new URL(
          `/${publicationSlug.split("/").map(encodeURIComponent).join("/")}`,
          url.origin,
        ).toString();
        const html = renderPublication(first.document, {
          canonicalUrl,
          mediaUrl: (digest) =>
            `/media/${encodeURIComponent(site.siteSlug)}/${encodeURIComponent(first.publicationId)}/${encodeURIComponent(digest)}`,
        });
        const second = await dependencies.repository.resolvePage({
          siteSlug: site.siteSlug,
          publicationSlug,
          ...(sessionDigest ? { sessionDigest } : {}),
        });
        if (!second || second.versionId !== first.versionId) return notFound();
        return new Response(html, {
          status: 200,
          headers: readerHeaders({
            contentType: "text/html; charset=utf-8",
            authenticated: site.readerAccess === "authenticated",
          }),
        });
      } catch {
        return unavailable();
      }
    },

    async media(
      request: Request,
      siteSlug: string,
      publicationId: string,
      sha256: string,
    ): Promise<Response> {
      if (
        !siteSlugPattern.test(siteSlug) ||
        !uuidPattern.test(publicationId) ||
        !sha256Pattern.test(sha256)
      ) {
        return notFound();
      }
      try {
        if (
          !(await acceptsReaderRequest(
            request,
            dependencies.environment,
            dependencies.repository,
            siteSlug,
          ))
        ) {
          return notFound();
        }
        const sessionDigest = readerSessionDigest(request, siteSlug);
        const first = await dependencies.repository.resolveAsset({
          siteSlug,
          publicationId,
          sha256,
          ...(sessionDigest ? { sessionDigest } : {}),
        });
        if (!first) return notFound();
        const entityTag = `"sha256-${first.sha256}"`;
        if (request.headers.get("If-None-Match") === entityTag) {
          return new Response(null, {
            status: 304,
            headers: readerHeaders({
              entityTag,
              media: true,
              authenticated: !!sessionDigest,
            }),
          });
        }
        const object = await dependencies.objects.get({
          tenantId: first.tenantId,
          sha256: first.sha256,
        });
        if (!object) return notFound();
        if (
          object.descriptor.contentType !== first.contentType ||
          object.descriptor.size !== first.byteSize
        ) {
          await object.stream
            .cancel("public asset metadata mismatch")
            .catch(() => {});
          return unavailable();
        }
        const second = await dependencies.repository.resolveAsset({
          siteSlug,
          publicationId,
          sha256,
          ...(sessionDigest ? { sessionDigest } : {}),
        });
        if (!second || second.versionId !== first.versionId) {
          await object.stream
            .cancel("publication is no longer active")
            .catch(() => {});
          return notFound();
        }
        const inline = safeInlineMediaTypes.has(
          first.contentType.toLowerCase(),
        );
        return new Response(object.stream, {
          status: 200,
          headers: readerHeaders({
            contentType: first.contentType,
            contentLength: first.byteSize,
            disposition: `${inline ? "inline" : "attachment"}; filename="${sha256}"`,
            entityTag,
            media: true,
            authenticated: !!sessionDigest,
          }),
        });
      } catch {
        return unavailable();
      }
    },
  };
}

async function requiresReaderAccess(
  repository: PublicReaderRepository,
  siteSlug: string,
) {
  return (
    !!repository.resolveSiteAccess &&
    (await repository.resolveSiteAccess(siteSlug)) === "authenticated"
  );
}

function readerAccessRedirect(request: Request, siteSlug: string): Response {
  const url = new URL(request.url);
  const target = new URL(`/access/${encodeURIComponent(siteSlug)}`, url.origin);
  target.searchParams.set("next", `${url.pathname}${url.search}`);
  const headers = readerHeaders({ authenticated: true });
  headers.set("Location", target.toString());
  return new Response(null, {
    status: 307,
    headers,
  });
}

function readerSessionDigest(
  request: Request,
  siteSlug: string,
): string | undefined {
  const cookieName = readerCookieName(siteSlug);
  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (!cookie) return undefined;
  let token: string;
  try {
    token = decodeURIComponent(cookie.slice(cookieName.length + 1));
  } catch {
    return undefined;
  }
  return /^knot_session_[A-Za-z0-9_-]{43}$/u.test(token)
    ? sha256(token)
    : undefined;
}

export function createProductionPublicReaderHandlers() {
  let environment: ContentEnvironment | undefined;
  try {
    environment = getContentEnvironment();
  } catch {
    environment = undefined;
  }
  return createPublicReaderHandlers({
    repository: new NeonPublicReaderRepository(),
    objects: createPublicAssetStore(),
    environment,
  });
}

async function acceptsReaderRequest(
  request: Request,
  environment: ContentEnvironment | undefined,
  repository: PublicReaderRepository,
  siteSlug: string,
): Promise<boolean> {
  try {
    return !!(await resolveReaderOrigin({
      url: new URL(request.url),
      environment,
      repository,
      siteSlug,
    }));
  } catch {
    return false;
  }
}

function readerHeaders(input?: {
  contentType?: string;
  contentLength?: number;
  disposition?: string;
  entityTag?: string;
  media?: boolean;
  authenticated?: boolean;
}): Headers {
  const headers = new Headers({
    "Cache-Control": input?.authenticated
      ? "private, no-store, max-age=0"
      : "no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Security-Policy": publicReaderCsp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Vercel-CDN-Cache-Control": "no-store",
  });
  headers.set("Surrogate-Control", "no-store");
  if (input?.authenticated) headers.set("Vary", "Cookie");
  if (input?.contentType) headers.set("Content-Type", input.contentType);
  if (input?.contentLength !== undefined) {
    headers.set("Content-Length", String(input.contentLength));
  }
  if (input?.disposition) {
    headers.set("Content-Disposition", input.disposition);
  }
  if (input?.entityTag) headers.set("ETag", input.entityTag);
  return headers;
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: readerHeaders({ contentType: "text/plain; charset=utf-8" }),
  });
}

function unavailable(): Response {
  return new Response("Temporarily unavailable", {
    status: 503,
    headers: readerHeaders({ contentType: "text/plain; charset=utf-8" }),
  });
}
