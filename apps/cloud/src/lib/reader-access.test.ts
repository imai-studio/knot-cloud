import { describe, expect, it } from "vitest";

import { safeReaderReturnPath } from "./reader-access";

describe("reader access return paths", () => {
  it("accepts local paths and rejects authority and backslash forms", () => {
    expect(safeReaderReturnPath("/p/guide/start?mode=read", "guide")).toBe(
      "/p/guide/start?mode=read",
    );
    expect(safeReaderReturnPath("//evil.example", "guide")).toBe(
      "/p/guide/index",
    );
    expect(safeReaderReturnPath("/\\evil.example", "guide")).toBe(
      "/p/guide/index",
    );
    expect(safeReaderReturnPath("https://evil.example", "guide")).toBe(
      "/p/guide/index",
    );
  });
});
