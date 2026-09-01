import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { proxy } from "./proxy";

const previousContentBaseUrl = process.env.CONTENT_BASE_URL;
const previousAppBaseUrl = process.env.APP_BASE_URL;

afterEach(() => {
  if (previousContentBaseUrl === undefined) {
    delete process.env.CONTENT_BASE_URL;
  } else {
    process.env.CONTENT_BASE_URL = previousContentBaseUrl;
  }
  if (previousAppBaseUrl === undefined) {
    delete process.env.APP_BASE_URL;
  } else {
    process.env.APP_BASE_URL = previousAppBaseUrl;
  }
});

describe("reader-origin proxy", () => {
  it("blocks dashboard and API routes on the public content origin", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.imai.tech";
    for (const path of [
      "/",
      "/dashboard",
      "/api/auth/sign-in",
      "/unknown-api",
    ]) {
      const response = proxy(
        new NextRequest(`https://pages.example.org${path}`),
      );
      expect(response?.status).toBe(404);
      expect(response?.headers.has("Set-Cookie")).toBe(false);
    }
  });

  it("allows only reader, grant exchange, and immutable application assets on the content origin", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.imai.tech";
    expect(
      proxy(new NextRequest("https://pages.example.org/p/demo/guide")),
    ).toBeUndefined();
    expect(
      proxy(
        new NextRequest(
          `https://pages.example.org/media/demo/00000000-0000-4000-8000-000000000001/${"a".repeat(64)}`,
        ),
      ),
    ).toBeUndefined();
    expect(
      proxy(new NextRequest("https://pages.example.org/access/demo")),
    ).toBeUndefined();
    expect(
      proxy(
        new NextRequest("https://pages.example.org/api/v1/reader/sessions"),
      ),
    ).toBeUndefined();
    expect(
      proxy(new NextRequest("https://pages.example.org/_next/static/app.js")),
    ).toBeUndefined();
  });

  it("blocks reader routes on the dashboard origin", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.imai.tech";
    expect(
      proxy(new NextRequest("https://knot.imai.tech/p/demo/guide"))?.status,
    ).toBe(404);
    expect(
      proxy(new NextRequest("https://knot.imai.tech/dashboard")),
    ).toBeUndefined();
    expect(
      proxy(new NextRequest("https://knot.imai.tech/access/demo"))?.status,
    ).toBe(404);
    expect(
      proxy(new NextRequest("https://knot.imai.tech/api/v1/reader/sessions"))
        ?.status,
    ).toBe(404);
  });

  it("allows only potential reader surfaces on custom hosts", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.imai.tech";
    for (const path of [
      "/guide",
      "/media/demo/id/digest",
      "/access/demo",
      "/api/v1/reader/sessions",
      "/_next/static/app.js",
    ]) {
      expect(
        proxy(new NextRequest(`https://notes.example.org${path}`)),
      ).toBeUndefined();
    }
    for (const path of ["/", "/dashboard", "/login", "/api/v1/session/sites"]) {
      expect(
        proxy(new NextRequest(`https://notes.example.org${path}`))?.status,
      ).toBe(404);
    }
  });

  it("rejects Vercel preview aliases with cache-bypass headers", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.imai.tech";
    const response = proxy(
      new NextRequest("https://knot-git-main-imai.vercel.app/p/demo/guide"),
    );
    expect(response?.status).toBe(404);
    expect(response?.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
      "no-store",
    );
    expect(
      proxy(
        new NextRequest("https://knot-git-main-imai.vercel.app/api/health"),
      ),
    ).toBeUndefined();
    expect(
      proxy(
        new NextRequest(
          "https://knot-git-main-imai.vercel.app/api/internal/publications/maintenance",
        ),
      ),
    ).toBeUndefined();
  });
});
