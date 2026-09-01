import type { NextRequest } from "next/server";

const fixedReaderPathPattern =
  /^(?:\/(?:p|media|access)(?:\/|$)|\/api\/v1\/reader\/sessions\/?$)/u;
const customReaderPathPattern =
  /^(?:\/(?:media|access)(?:\/|$)|\/api\/v1\/reader\/sessions\/?$)/u;
const nextStaticPathPattern = /^\/_next\/static(?:\/|$)/u;
const customControlPathPattern =
  /^\/(?:api|dashboard|login|_next|p)(?:\/|$)|^\/(?:apple-icon|icon)\.png$/u;

export function proxy(request: NextRequest): Response | undefined {
  const contentOrigin = configuredContentOrigin();
  const applicationOrigin = configuredApplicationOrigin();
  const path = request.nextUrl.pathname;
  const isFixedReaderPath = fixedReaderPathPattern.test(path);
  if (applicationOrigin && request.nextUrl.origin === applicationOrigin) {
    return isFixedReaderPath ? isolatedNotFound() : undefined;
  }
  if (contentOrigin && request.nextUrl.origin === contentOrigin) {
    return isFixedReaderPath || nextStaticPathPattern.test(path)
      ? undefined
      : isolatedNotFound();
  }
  if (request.nextUrl.hostname.toLowerCase().endsWith(".vercel.app")) {
    // Vercel deployment aliases remain usable for control-plane previews and
    // scheduled maintenance, but never become reader origins.
    return isFixedReaderPath ? isolatedNotFound() : undefined;
  }
  if (
    request.nextUrl.protocol !== "https:" ||
    request.nextUrl.port ||
    path === "/" ||
    (customControlPathPattern.test(path) &&
      !customReaderPathPattern.test(path) &&
      !nextStaticPathPattern.test(path))
  ) {
    return isolatedNotFound();
  }
  // A potential custom domain may reach only reader routes. Route handlers
  // still require a verified hostname-to-site mapping before any content,
  // access form, session, or asset is returned.
  return undefined;
}

function configuredContentOrigin(): string | undefined {
  const configured = process.env.CONTENT_BASE_URL?.trim();
  if (!configured) return undefined;
  try {
    return new URL(configured).origin;
  } catch {
    return undefined;
  }
}

function configuredApplicationOrigin(): string | undefined {
  const configured = process.env.APP_BASE_URL?.trim();
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
