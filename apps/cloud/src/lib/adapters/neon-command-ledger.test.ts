import { describe, expect, it } from "vitest";

import { serializeCommandResult } from "./neon-command-ledger";

describe("Neon command result binding", () => {
  it("binds absent failed and rejected results as SQL NULL", () => {
    expect(serializeCommandResult(null)).toBeNull();
  });

  it("serializes successful results as JSON", () => {
    expect(serializeCommandResult({ type: "object.read", ok: true })).toBe(
      '{"type":"object.read","ok":true}',
    );
  });

  it("rejects a successful result that JSON cannot represent", () => {
    expect(() => serializeCommandResult(undefined)).toThrow(
      "A successful command result must be JSON serializable",
    );
  });
});
