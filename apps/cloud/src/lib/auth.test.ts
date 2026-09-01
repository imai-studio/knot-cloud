import { describe, expect, it } from "vitest";

import { normalizeAuthEmail } from "./auth-identity";

describe("authentication identity normalization", () => {
  it("stores sign-in email addresses in one canonical form", () => {
    expect(normalizeAuthEmail(" Raj@Example.Test ")).toBe("raj@example.test");
    expect(normalizeAuthEmail("raj@example.test")).toBe("raj@example.test");
  });
});
