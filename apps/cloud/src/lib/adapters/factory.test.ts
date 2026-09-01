import { afterEach, describe, expect, it, vi } from "vitest";

const environmentKeys = [
  "OBJECT_STORE_DRIVER",
  "R2_ACCESS_KEY_ID",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "R2_MAX_OBJECT_BYTES",
  "R2_SECRET_ACCESS_KEY",
  "REPLAY_STORE_DRIVER",
  "CONNECTOR_RATE_LIMIT_STORE_DRIVER",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;

const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  vi.resetModules();
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("adapter factory", () => {
  it("memoizes the configured object store for the process", async () => {
    process.env.OBJECT_STORE_DRIVER = "r2";
    process.env.R2_ACCOUNT_ID = "account";
    process.env.R2_BUCKET_NAME = "knot-test";
    process.env.R2_ACCESS_KEY_ID = "access";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    process.env.R2_MAX_OBJECT_BYTES = "1024";

    const { createObjectStore } = await import("./factory");
    const first = createObjectStore();
    const second = createObjectStore();

    expect(second).toBe(first);
  });

  it("rejects an unsupported replay-store driver", async () => {
    process.env.REPLAY_STORE_DRIVER = "memory";
    const { createReplayNonceStore } = await import("./factory");
    expect(() => createReplayNonceStore()).toThrow(
      "Unsupported REPLAY_STORE_DRIVER: memory",
    );
  });

  it("uses Postgres for correctness-durable replay claims", async () => {
    process.env.REPLAY_STORE_DRIVER = "postgres";
    const { createReplayNonceStore } = await import("./factory");
    expect(createReplayNonceStore().constructor.name).toBe(
      "NeonReplayNonceStore",
    );
  });

  it("preflights Upstash credentials for connector rate limiting", async () => {
    process.env.CONNECTOR_RATE_LIMIT_STORE_DRIVER = "upstash";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const { createConnectorRateLimitStore } = await import("./factory");
    expect(() => createConnectorRateLimitStore()).toThrow();
  });

  it("constructs the rate-limit store from Vercel KV integration names", async () => {
    process.env.CONNECTOR_RATE_LIMIT_STORE_DRIVER = "upstash";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = "https://vercel-kv.upstash.io";
    process.env.KV_REST_API_TOKEN = "vercel-token";
    const { createConnectorRateLimitStore } = await import("./factory");
    expect(createConnectorRateLimitStore()).toBeDefined();
  });
});
