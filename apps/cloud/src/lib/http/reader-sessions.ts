import { NeonPublicReaderRepository } from "@/lib/adapters/neon-public-reader";
import { NeonPlatformRepository } from "@/lib/adapters/neon-platform";
import { getContentEnvironment, type ContentEnvironment } from "@/lib/env";
import { PlatformService } from "@/lib/platform";
import { resolveReaderOrigin } from "@/lib/reader-origin";

import { jsonResponse, problemResponse } from "./problem";

const bodyLimit = 8 * 1024;
const siteSlugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function readerCookieName(siteSlug: string): string {
  if (!siteSlugPattern.test(siteSlug)) throw new TypeError("Invalid site slug");
  return `knot_reader_session_${siteSlug}`;
}

export function createReaderSessionHandler(input: {
  authorize(request: Request, siteSlug: string): Promise<boolean>;
  redeem(
    token: string,
    siteSlug: string,
  ): Promise<
    | { siteSlug: string; sessionToken: string; sessionExpiresAt: Date }
    | undefined
  >;
}) {
  return async function POST(request: Request): Promise<Response> {
    if (!isSameOrigin(request)) {
      return problemResponse({
        request,
        status: 403,
        code: "forbidden",
        title: "The request origin is not trusted",
      });
    }
    let credentials: { token: string; siteSlug: string };
    try {
      credentials = await readCredentials(request);
    } catch {
      return problemResponse({
        request,
        status: 400,
        code: "invalid-request",
        title: "The reader grant is invalid",
      });
    }
    if (!(await input.authorize(request, credentials.siteSlug))) {
      return problemResponse({
        request,
        status: 404,
        code: "not-found",
        title: "The reader site was not found",
      });
    }
    const redeemed = await input.redeem(
      credentials.token,
      credentials.siteSlug,
    );
    if (!redeemed || redeemed.siteSlug !== credentials.siteSlug) {
      return problemResponse({
        request,
        status: 401,
        code: "authentication-required",
        title: "The reader grant is expired, revoked, or already used",
      });
    }
    const response = jsonResponse({ siteSlug: redeemed.siteSlug });
    response.headers.append(
      "Set-Cookie",
      serializeReaderCookie(
        request,
        redeemed.siteSlug,
        redeemed.sessionToken,
        redeemed.sessionExpiresAt,
      ),
    );
    return response;
  };
}

export function createProductionReaderSessionHandler() {
  const platformRepository = new NeonPlatformRepository();
  const readerRepository = new NeonPublicReaderRepository();
  const service = new PlatformService(platformRepository, undefined, {
    async resolve() {
      return [];
    },
  });
  let environment: ContentEnvironment | undefined;
  try {
    environment = getContentEnvironment();
  } catch {
    environment = undefined;
  }
  return createReaderSessionHandler({
    authorize: async (request, siteSlug) => {
      try {
        return !!(await resolveReaderOrigin({
          url: new URL(request.url),
          environment,
          repository: readerRepository,
          siteSlug,
        }));
      } catch {
        return false;
      }
    },
    redeem: (token, siteSlug) => service.redeemReaderGrant(token, siteSlug),
  });
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readCredentials(
  request: Request,
): Promise<{ token: string; siteSlug: string }> {
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > bodyLimit) throw new Error("too-large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > bodyLimit) throw new Error("too-large");
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType === "application/json") {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as { token?: unknown }).token !== "string" ||
      typeof (parsed as { siteSlug?: unknown }).siteSlug !== "string" ||
      !siteSlugPattern.test((parsed as { siteSlug: string }).siteSlug)
    ) {
      throw new Error("invalid");
    }
    return parsed as { token: string; siteSlug: string };
  }
  if (contentType === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(new TextDecoder().decode(bytes));
    const token = form.get("token");
    const siteSlug = form.get("siteSlug");
    if (!token || !siteSlug || !siteSlugPattern.test(siteSlug)) {
      throw new Error("invalid");
    }
    return { token, siteSlug };
  }
  throw new Error("content-type");
}

function serializeReaderCookie(
  request: Request,
  siteSlug: string,
  token: string,
  expiresAt: Date,
): string {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${readerCookieName(siteSlug)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : undefined,
    `Expires=${expiresAt.toUTCString()}`,
  ]
    .filter(Boolean)
    .join("; ");
}
