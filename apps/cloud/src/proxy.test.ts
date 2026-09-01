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
    process.env.APP_BASE_URL = "https://knot.example.com";
    for (const path of ["/", "/dashboard", "/api/auth/sign-in"]) {
      const response = proxy(
        new NextRequest(`https://pages.example.org${path}`),
      );
      expect(response?.status).toBe(404);
      expect(response?.headers.has("Set-Cookie")).toBe(false);
    }
  });

  it("allows only reader routes on the content origin", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.example.com";
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
    expect(proxy(new NextRequest("https://knot.imai.tech/guide"))?.status).toBe(
      404,
    );
  });

  it("blocks app routes and every Vercel alias on untrusted hosts", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.example.com";
    for (const url of [
      "https://unknown.example.net/",
      "https://unknown.example.net/dashboard",
      "https://unknown.example.net/api/health",
      "https://knot-git-main-imai.vercel.app/p/demo/guide",
      "https://knot-git-main-imai.vercel.app/dashboard",
    ]) {
      const response = proxy(new NextRequest(url));
      expect(response?.status, url).toBe(404);
      expect(response?.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
        "no-store",
      );
    }
  });

  it("passes only custom-reader candidates to database-backed handlers", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    process.env.APP_BASE_URL = "https://knot.example.com";
    expect(
      proxy(new NextRequest("https://docs.example.net/guide")),
    ).toBeUndefined();
    expect(
      proxy(
        new NextRequest(
          `https://docs.example.net/media/demo/00000000-0000-4000-8000-000000000001/${"a".repeat(64)}`,
        ),
      ),
    ).toBeUndefined();
  });
});
