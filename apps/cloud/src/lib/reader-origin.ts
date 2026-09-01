import type { ContentEnvironment } from "@/lib/env";
import type { PublicReaderRepository } from "@/lib/public-reader";

export type ReaderOriginKind = "content" | "custom";

/**
 * Authorize a reader-facing request origin for one site. The fixed content
 * origin may address every site. Any other origin must be HTTPS, have no
 * explicit port, and be a verified custom-domain mapping for this exact site.
 */
export async function resolveReaderOrigin(input: {
  url: URL;
  environment: ContentEnvironment | undefined;
  repository: PublicReaderRepository;
  siteSlug: string;
}): Promise<ReaderOriginKind | undefined> {
  if (!input.environment) return undefined;
  if (input.url.origin === input.environment.baseUrl.origin) return "content";
  if (
    input.url.protocol !== "https:" ||
    input.url.port ||
    !input.repository.resolveCustomDomainSite
  ) {
    return undefined;
  }
  const custom = await input.repository.resolveCustomDomainSite(
    input.url.hostname.toLowerCase(),
  );
  return custom?.siteSlug === input.siteSlug ? "custom" : undefined;
}

export function readerUrlFromHeaders(
  headers: Pick<Headers, "get">,
): URL | undefined {
  const host = firstHeaderValue(
    headers.get("host") ?? headers.get("x-forwarded-host"),
  );
  const forwardedProtocol = firstHeaderValue(headers.get("x-forwarded-proto"));
  const protocol =
    forwardedProtocol ??
    (host && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(host)
      ? "http"
      : undefined);
  if (!host || !protocol || !/^https?$/u.test(protocol)) {
    return undefined;
  }
  try {
    const url = new URL(`${protocol}://${host}`);
    return url.username || url.password || url.pathname !== "/"
      ? undefined
      : url;
  } catch {
    return undefined;
  }
}

function firstHeaderValue(value: string | null): string | undefined {
  const first = value?.split(",", 1)[0]?.trim();
  return first || undefined;
}
