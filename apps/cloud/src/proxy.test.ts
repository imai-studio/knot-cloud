import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { proxy } from "./proxy";

const previousContentBaseUrl = process.env.CONTENT_BASE_URL;

afterEach(() => {
  if (previousContentBaseUrl === undefined) {
    delete process.env.CONTENT_BASE_URL;
  } else {
    process.env.CONTENT_BASE_URL = previousContentBaseUrl;
  }
});

describe("reader-origin proxy", () => {
  it("blocks dashboard and API routes on the public content origin", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    for (const path of [
      "/",
      "/dashboard",
      "/api/auth/sign-in",
      "/_next/static/app.js",
    ]) {
      const response = proxy(
        new NextRequest(`https://pages.example.org${path}`),
      );
      expect(response?.status).toBe(404);
      expect(response?.headers.has("Set-Cookie")).toBe(false);
    }
  });

  it("allows only reader routes on the content origin", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
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
  });

  it("blocks reader routes on the dashboard origin", () => {
    process.env.CONTENT_BASE_URL = "https://pages.example.org";
    expect(
      proxy(new NextRequest("https://knot.imai.tech/p/demo/guide"))?.status,
    ).toBe(404);
    expect(
      proxy(new NextRequest("https://knot.imai.tech/dashboard")),
    ).toBeUndefined();
  });
});
