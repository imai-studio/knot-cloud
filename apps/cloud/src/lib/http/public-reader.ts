import { renderPublication } from "@imai/knot-publication-renderer";

import { NeonPublicReaderRepository } from "@/lib/adapters/neon-public-reader";
import { createPublicAssetStore } from "@/lib/adapters/factory";
import { getContentEnvironment, type ContentEnvironment } from "@/lib/env";
import type {
  PublicAssetStore,
  PublicReaderRepository,
} from "@/lib/public-reader";

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
        !acceptsReaderRequest(request, dependencies.environment) ||
        !siteSlugPattern.test(siteSlug) ||
        !publicationSlugPattern.test(publicationSlug) ||
        publicationSlug.includes("//")
      ) {
        return notFound();
      }
      try {
        const first = await dependencies.repository.resolvePage({
          siteSlug,
          publicationSlug,
        });
        if (!first) return notFound();
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
        });
        if (!second || second.versionId !== first.versionId) return notFound();
        return new Response(html, {
          status: 200,
          headers: readerHeaders({ contentType: "text/html; charset=utf-8" }),
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
        !acceptsReaderRequest(request, dependencies.environment) ||
        !siteSlugPattern.test(siteSlug) ||
        !uuidPattern.test(publicationId) ||
        !sha256Pattern.test(sha256)
      ) {
        return notFound();
      }
      try {
        const first = await dependencies.repository.resolveAsset({
          siteSlug,
          publicationId,
          sha256,
        });
        if (!first) return notFound();
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
          }),
        });
      } catch {
        return unavailable();
      }
    },
  };
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

function acceptsReaderRequest(
  request: Request,
  environment: ContentEnvironment | undefined,
): boolean {
  if (!environment) return false;
  try {
    return new URL(request.url).origin === environment.baseUrl.origin;
  } catch {
    return false;
  }
}

function readerHeaders(input?: {
  contentType?: string;
  contentLength?: number;
  disposition?: string;
}): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": publicReaderCsp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (input?.contentType) headers.set("Content-Type", input.contentType);
  if (input?.contentLength !== undefined) {
    headers.set("Content-Length", String(input.contentLength));
  }
  if (input?.disposition) {
    headers.set("Content-Disposition", input.disposition);
  }
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
