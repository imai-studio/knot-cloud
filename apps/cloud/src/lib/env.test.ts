import { describe, expect, it } from "vitest";

import {
  parseCloudEnvironment,
  parseContentEnvironment,
  parseEmailEnvironment,
  parseR2Environment,
  parseUpstashEnvironment,
  signingAuthoritiesFromEnvironment,
  trustedAuthOriginsFromEnvironment,
} from "./env";

const required = {
  APP_BASE_URL: "https://cloud.knot.test",
  AUTH_BASE_URL: "https://app.knot.test",
  DATABASE_URL: "postgres://knot_app:secret@db.test/knot",
  AUTH_SECRET: "a".repeat(32),
  CRON_SECRET: "c".repeat(32),
  API_KEY_PEPPER: "p".repeat(32),
  API_KEY_PEPPER_VERSION: "1",
  IDENTITY_DIGEST_PEPPER: "i".repeat(32),
  IDENTITY_DIGEST_VERSION: "1",
};

describe("cloud environment", () => {
  it("treats blank optional values as absent", () => {
    const environment = parseCloudEnvironment({
      ...required,
      API_KEY_PEPPER_PREVIOUS: "",
      AUTH_TRUSTED_ORIGINS: "",
      KNOT_SIGNING_AUTHORITIES: "",
    });
    expect(environment.API_KEY_PEPPER_PREVIOUS).toBeUndefined();
    expect(environment.AUTH_TRUSTED_ORIGINS).toBeUndefined();
    expect(environment.KNOT_SIGNING_AUTHORITIES).toBeUndefined();
    expect(signingAuthoritiesFromEnvironment(environment)).toEqual([
      "cloud.knot.test",
    ]);
  });

  it("normalizes and deduplicates trusted authentication origins", () => {
    const environment = parseCloudEnvironment({
      ...required,
      AUTH_TRUSTED_ORIGINS:
        "https://legacy.knot.test/path, https://cloud.knot.test",
    });
    expect(trustedAuthOriginsFromEnvironment(environment)).toEqual([
      "https://app.knot.test",
      "https://cloud.knot.test",
      "https://legacy.knot.test",
    ]);
  });

  it("normalizes, deduplicates, and validates signing authorities", () => {
    const environment = parseCloudEnvironment({
      ...required,
      KNOT_SIGNING_AUTHORITIES: "cloud.knot.test, [::1]:3000, cloud.knot.test",
    });
    expect(signingAuthoritiesFromEnvironment(environment)).toEqual([
      "cloud.knot.test",
      "[::1]:3000",
    ]);
  });
});

describe("content environment", () => {
  it("accepts an isolated HTTPS reader origin", () => {
    expect(
      parseContentEnvironment({
        APP_BASE_URL: "https://knot.imai.tech",
        CONTENT_BASE_URL: "https://pages.example.org",
      })?.baseUrl.origin,
    ).toBe("https://pages.example.org");
  });

  it("stays disabled when no reader origin is configured", () => {
    expect(
      parseContentEnvironment({ APP_BASE_URL: "https://knot.imai.tech" }),
    ).toBeUndefined();
  });

  it("rejects a control-plane sibling, paths, and insecure remote origins", () => {
    expect(() =>
      parseContentEnvironment({
        APP_BASE_URL: "https://knot.imai.tech",
        CONTENT_BASE_URL: "https://reader.imai.tech",
      }),
    ).toThrow(/separate registrable domain/u);
    expect(() =>
      parseContentEnvironment({
        APP_BASE_URL: "https://knot.imai.tech",
        CONTENT_BASE_URL: "https://reader.example.org/path",
      }),
    ).toThrow(/bare origin/u);
    expect(() =>
      parseContentEnvironment({
        APP_BASE_URL: "https://knot.imai.tech",
        CONTENT_BASE_URL: "http://reader.example.org",
      }),
    ).toThrow(/HTTPS/u);
  });
});

describe("email environment", () => {
  it("accepts a named sender and a comma-separated allowlist", () => {
    expect(
      parseEmailEnvironment({
        EMAIL_FROM: "Knot <access@imai.studio>",
        KNOT_ALLOWED_EMAILS: "raj@imai.studio, ops@imai.studio",
        RESEND_API_KEY: "test-key",
      }),
    ).toMatchObject({
      EMAIL_FROM: "Knot <access@imai.studio>",
      KNOT_ALLOWED_EMAILS: "raj@imai.studio, ops@imai.studio",
    });
  });

  it("rejects malformed sender and allowlist values", () => {
    expect(() =>
      parseEmailEnvironment({
        EMAIL_FROM: "not-an-email",
        KNOT_ALLOWED_EMAILS: "also-not-an-email",
        RESEND_API_KEY: "test-key",
      }),
    ).toThrow();
  });
});

describe("R2 environment", () => {
  const requiredR2 = {
    R2_ACCOUNT_ID: "cloudflare-account",
    R2_BUCKET_NAME: "knot-private",
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
  };

  it("uses a bounded default object size", () => {
    expect(parseR2Environment(requiredR2).R2_MAX_OBJECT_BYTES).toBe(
      104_857_600,
    );
  });

  it("accepts an explicit limit and rejects unsafe values", () => {
    expect(
      parseR2Environment({
        ...requiredR2,
        R2_MAX_OBJECT_BYTES: "1048576",
      }).R2_MAX_OBJECT_BYTES,
    ).toBe(1_048_576);
    expect(() =>
      parseR2Environment({ ...requiredR2, R2_MAX_OBJECT_BYTES: "0" }),
    ).toThrow();
    expect(() =>
      parseR2Environment({
        ...requiredR2,
        R2_MAX_OBJECT_BYTES: "104857601",
      }),
    ).toThrow();
  });
});

describe("Upstash environment", () => {
  it("accepts Vercel KV integration names as a fallback", () => {
    expect(
      parseUpstashEnvironment({
        KV_REST_API_URL: "https://vercel-kv.upstash.io",
        KV_REST_API_TOKEN: "vercel-token",
      }),
    ).toEqual({
      UPSTASH_REDIS_REST_URL: "https://vercel-kv.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "vercel-token",
    });
  });

  it("prefers an explicit Upstash pair over Vercel integration names", () => {
    expect(
      parseUpstashEnvironment({
        UPSTASH_REDIS_REST_URL: "https://explicit.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "explicit-token",
        KV_REST_API_URL: "https://vercel-kv.upstash.io",
        KV_REST_API_TOKEN: "vercel-token",
      }),
    ).toEqual({
      UPSTASH_REDIS_REST_URL: "https://explicit.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "explicit-token",
    });
  });

  it("rejects incomplete explicit or fallback credential pairs", () => {
    expect(() =>
      parseUpstashEnvironment({
        UPSTASH_REDIS_REST_URL: "https://explicit.upstash.io",
        KV_REST_API_URL: "https://vercel-kv.upstash.io",
        KV_REST_API_TOKEN: "vercel-token",
      }),
    ).toThrow();
    expect(() =>
      parseUpstashEnvironment({
        KV_REST_API_URL: "https://vercel-kv.upstash.io",
      }),
    ).toThrow();
  });
});
