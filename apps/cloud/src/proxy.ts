import type { NextRequest } from "next/server";

const readerPathPattern = /^\/(?:p|media)(?:\/|$)/u;
const contentUiPathPattern =
  /^\/(?:access(?:\/|$)|api\/v1\/reader\/sessions\/?$|_next\/)/u;
const appOnlyPathPattern =
  /^\/(?:api(?:\/|$)|dashboard(?:\/|$)|login(?:\/|$)|access(?:\/|$)|_next(?:\/|$)|brand(?:\/|$)|art(?:\/|$)|icon\.png$|apple-icon\.png$)/u;

export function proxy(request: NextRequest): Response | undefined {
  const appOrigin = configuredOrigin("APP_BASE_URL");
  const contentOrigin = configuredContentOrigin();
  const isReaderPath = readerPathPattern.test(request.nextUrl.pathname);
  const requestOrigin = request.nextUrl.origin;

  if (appOrigin && requestOrigin === appOrigin) {
    if (
      !isReaderPath &&
      (request.nextUrl.pathname === "/" ||
        appOnlyPathPattern.test(request.nextUrl.pathname))
    ) {
      return undefined;
    }
    return isolatedNotFound();
  }
  if (contentOrigin && requestOrigin === contentOrigin) {
    if (isReaderPath || contentUiPathPattern.test(request.nextUrl.pathname)) {
      return undefined;
    }
    return isolatedNotFound();
  }
  if (request.nextUrl.hostname.toLowerCase().endsWith(".vercel.app")) {
    return isolatedNotFound();
  }
  if (
    request.nextUrl.pathname === "/" ||
    appOnlyPathPattern.test(request.nextUrl.pathname)
  ) {
    return isolatedNotFound();
  }

  // A custom reader hostname is not trusted here. Only reader candidates
  // reach route handlers, which resolve an exact verified database mapping.
  return undefined;
}

function configuredContentOrigin(): string | undefined {
  return configuredOrigin("CONTENT_BASE_URL");
}

function configuredOrigin(
  name: "APP_BASE_URL" | "CONTENT_BASE_URL",
): string | undefined {
  const configured = process.env[name]?.trim();
  if (!configured) return undefined;
  try {
    return new URL(configured).origin;
  } catch {
    return undefined;
  }
}

function isolatedNotFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": "text/plain; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Vercel-CDN-Cache-Control": "no-store",
    },
  });
}
