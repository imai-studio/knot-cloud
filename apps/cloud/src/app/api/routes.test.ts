import { protocolMetaSchema } from "@imai/knot-cloud-contract";
import { describe, expect, it } from "vitest";

import { GET as health } from "./health/route";
import { GET as metadata } from "./v1/meta/route";

describe("service foundation routes", () => {
  it("returns an uncached liveness response without requiring provider configuration", async () => {
    const response = health();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "healthy",
      product: "knot-cloud",
    });
  });

  it("advertises a valid protocol range and server time", async () => {
    const before = Math.floor(Date.now() / 1_000);
    const response = metadata();
    const body = protocolMetaSchema.parse(await response.json());
    const after = Math.floor(Date.now() / 1_000);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.minimumProtocolVersion).toBe("1.0");
    expect(body.maximumProtocolVersion).toBe("1.0");
    expect(body.serverUnixSeconds).toBeGreaterThanOrEqual(before);
    expect(body.serverUnixSeconds).toBeLessThanOrEqual(after);
  });
});
