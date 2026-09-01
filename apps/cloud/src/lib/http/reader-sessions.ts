import { NeonPlatformRepository } from "@/lib/adapters/neon-platform";
import { PlatformService } from "@/lib/platform";

import { jsonResponse, problemResponse } from "./problem";

const bodyLimit = 8 * 1024;
export const readerCookieName = "knot_reader_session";

export function createReaderSessionHandler(input: {
  redeem(
    token: string,
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
    let token: string;
    try {
      token = await readToken(request);
    } catch {
      return problemResponse({
        request,
        status: 400,
        code: "invalid-request",
        title: "The reader grant is invalid",
      });
    }
    const redeemed = await input.redeem(token);
    if (!redeemed) {
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
        redeemed.sessionToken,
        redeemed.sessionExpiresAt,
      ),
    );
    return response;
  };
}

export function createProductionReaderSessionHandler() {
  const repository = new NeonPlatformRepository();
  const service = new PlatformService(repository, undefined, {
    async resolve() {
      return [];
    },
  });
  return createReaderSessionHandler({
    redeem: (token) => service.redeemReaderGrant(token),
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

async function readToken(request: Request): Promise<string> {
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
      typeof (parsed as { token?: unknown }).token !== "string"
    ) {
      throw new Error("invalid");
    }
    return (parsed as { token: string }).token;
  }
  if (contentType === "application/x-www-form-urlencoded") {
    const token = new URLSearchParams(new TextDecoder().decode(bytes)).get(
      "token",
    );
    if (!token) throw new Error("invalid");
    return token;
  }
  throw new Error("content-type");
}

function serializeReaderCookie(
  request: Request,
  token: string,
  expiresAt: Date,
): string {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${readerCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : undefined,
    `Expires=${expiresAt.toUTCString()}`,
  ]
    .filter(Boolean)
    .join("; ");
}
