import { problemDetailsSchema } from "@imai/knot-cloud-contract";
import { describe, expect, it, vi } from "vitest";

import { problemResponse } from "./http";

vi.mock("@/lib/env", () => ({
  getAppBaseUrl: () => "https://trusted.knot.test/console",
}));

describe("legacy route problem response", () => {
  it("does not derive the problem namespace from the request host", async () => {
    const response = problemResponse(
      new Request("https://attacker.example/api/v1/connectors"),
      { status: 403, code: "forbidden", title: "Forbidden" },
    );
    expect(problemDetailsSchema.parse(await response.json()).type).toBe(
      "https://trusted.knot.test/problems/forbidden",
    );
  });
});
