import { afterEach, describe, expect, it, vi } from "vitest";

const environmentKeys = [
  "OBJECT_STORE_DRIVER",
  "R2_ACCESS_KEY_ID",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "R2_MAX_OBJECT_BYTES",
  "R2_SECRET_ACCESS_KEY",
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
});
