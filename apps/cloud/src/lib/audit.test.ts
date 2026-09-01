import { describe, expect, it } from "vitest";

import {
  decodeAuditCursor,
  encodeAuditCursor,
  publicAuditMetadata,
} from "./audit";

describe("audit log boundaries", () => {
  it("round-trips opaque pagination cursors and rejects malformed values", () => {
    const cursor = {
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
      id: "00000000-0000-4000-8000-000000000001",
    };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor("not-a-cursor")).toBeUndefined();
  });

  it("exposes only explicitly safe operational metadata", () => {
    expect(
      publicAuditMetadata({
        connectorId: "connector-1",
        scope: "anytype.objects.read",
        pollToken: "must-not-leak",
        nested: { secret: "must-not-leak" },
      }),
    ).toEqual({
      connectorId: "connector-1",
      scope: "anytype.objects.read",
    });
  });
});
