import { describe, expect, it, vi } from "vitest";

import {
  createReaderSessionHandler,
  readerCookieName,
} from "./reader-sessions";

function handler(input: {
  redeem: ReturnType<typeof vi.fn>;
  authorize?: ReturnType<typeof vi.fn>;
}) {
  type HandlerInput = Parameters<typeof createReaderSessionHandler>[0];
  return createReaderSessionHandler({
    redeem: input.redeem as HandlerInput["redeem"],
    authorize: (input.authorize ??
      vi.fn().mockResolvedValue(true)) as HandlerInput["authorize"],
  });
}

describe("reader sessions", () => {
  it("exchanges a same-origin grant and sets a constrained http-only cookie", async () => {
    const expiresAt = new Date("2026-10-01T00:00:00Z");
    const redeem = vi.fn().mockResolvedValue({
      siteSlug: "guide",
      sessionToken: "knot_session_secret",
      sessionExpiresAt: expiresAt,
    });
    const authorize = vi.fn().mockResolvedValue(true);
    const response = await handler({ redeem, authorize })(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://pages.example.org",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "knot_reader_grant", siteSlug: "guide" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), "guide");
    expect(redeem).toHaveBeenCalledWith("knot_reader_grant", "guide");
    expect(await response.json()).toEqual({ siteSlug: "guide" });
    expect(response.headers.get("Set-Cookie")).toBe(
      `${readerCookieName("guide")}=knot_session_secret; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=${expiresAt.toUTCString()}`,
    );
  });

  it("rejects cross-origin, malformed, and expired grants without a cookie", async () => {
    const redeem = vi.fn().mockResolvedValue(undefined);
    const sessions = handler({ redeem });
    const crossOrigin = await sessions(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "grant", siteSlug: "guide" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(redeem).not.toHaveBeenCalled();

    const malformed = await sessions(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://pages.example.org",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(malformed.status).toBe(400);

    const expired = await sessions(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://pages.example.org",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "token=expired&siteSlug=guide",
      }),
    );
    expect(expired.status).toBe(401);
    expect(expired.headers.has("Set-Cookie")).toBe(false);
  });

  it("fails before redemption when the request host is not authorized for the site", async () => {
    const redeem = vi.fn();
    const authorize = vi.fn().mockResolvedValue(false);
    const response = await handler({ redeem, authorize })(
      new Request("https://unknown.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://unknown.example.org",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "grant", siteSlug: "guide" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(redeem).not.toHaveBeenCalled();
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });

  it("does not set a cookie if the redeemed grant belongs to another site", async () => {
    const response = await handler({
      redeem: vi.fn().mockResolvedValue({
        siteSlug: "other",
        sessionToken: "secret",
        sessionExpiresAt: new Date("2026-10-01T00:00:00Z"),
      }),
    })(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://pages.example.org",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "grant", siteSlug: "guide" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });
});
