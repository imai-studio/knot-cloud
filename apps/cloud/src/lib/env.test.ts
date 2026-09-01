import { describe, expect, it } from "vitest";

import {
  parseCloudEnvironment,
  parseEmailEnvironment,
  signingAuthoritiesFromEnvironment,
  trustedAuthOriginsFromEnvironment,
} from "./env";

const required = {
  APP_BASE_URL: "https://cloud.knot.test",
  AUTH_BASE_URL: "https://app.knot.test",
  CONTENT_BASE_URL: "https://content.knot.test",
  DATABASE_URL: "postgres://knot_app:secret@db.test/knot",
  AUTH_SECRET: "a".repeat(32),
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
