import { describe, expect, it, vi } from "vitest";

import {
  createReaderSessionHandler,
  readerCookieName,
} from "./reader-sessions";

describe("reader sessions", () => {
  it("exchanges a same-origin grant and sets a constrained http-only cookie", async () => {
    const expiresAt = new Date("2026-10-01T00:00:00Z");
    const redeem = vi.fn().mockResolvedValue({
      siteSlug: "guide",
      sessionToken: "knot_session_secret",
      sessionExpiresAt: expiresAt,
    });
    const response = await createReaderSessionHandler({ redeem })(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://pages.example.org",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "knot_reader_grant" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(redeem).toHaveBeenCalledWith("knot_reader_grant");
    expect(await response.json()).toEqual({ siteSlug: "guide" });
    expect(response.headers.get("Set-Cookie")).toBe(
      `${readerCookieName}=knot_session_secret; Path=/; HttpOnly; SameSite=Strict; Secure; Expires=${expiresAt.toUTCString()}`,
    );
  });

  it("rejects cross-origin, malformed, and expired grants without a cookie", async () => {
    const redeem = vi.fn().mockResolvedValue(undefined);
    const handler = createReaderSessionHandler({ redeem });
    const crossOrigin = await handler(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "grant" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(redeem).not.toHaveBeenCalled();

    const malformed = await handler(
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

    const expired = await handler(
      new Request("https://pages.example.org/api/v1/reader/sessions", {
        method: "POST",
        headers: {
          Origin: "https://pages.example.org",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "token=expired",
      }),
    );
    expect(expired.status).toBe(401);
    expect(expired.headers.has("Set-Cookie")).toBe(false);
  });
});
