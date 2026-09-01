import type { NextRequest } from "next/server";

const readerPathPattern = /^\/(?:p|media)(?:\/|$)/u;

export function proxy(request: NextRequest): Response | undefined {
  const contentOrigin = configuredContentOrigin();
  const isReaderPath = readerPathPattern.test(request.nextUrl.pathname);
  if (contentOrigin && request.nextUrl.origin === contentOrigin) {
    if (isReaderPath) return undefined;
    return isolatedNotFound();
  }
  if (isReaderPath) return isolatedNotFound();
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

function isolatedNotFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": "text/plain; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
