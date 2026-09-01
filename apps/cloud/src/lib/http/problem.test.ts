import { describe, expect, it } from "vitest";

import { problemResponse } from "./problem";

describe("problem response", () => {
  it.each([429, 503] as const)(
    "adds Retry-After to retryable %s responses",
    (status) => {
      const response = problemResponse({
        request: new Request("https://knot.test/api/v1/example"),
        status,
        code: status === 429 ? "rate-limited" : "dependency-unavailable",
        title: "Try again later",
        retryable: true,
        retryAfterSeconds: 17,
      });

      expect(response.headers.get("Retry-After")).toBe("17");
    },
  );

  it("does not add Retry-After to other status codes", () => {
    const response = problemResponse({
      request: new Request("https://knot.test/api/v1/example"),
      status: 500,
      code: "internal-error",
      title: "Try again later",
      retryable: true,
      retryAfterSeconds: 17,
    });

    expect(response.headers.has("Retry-After")).toBe(false);
  });
});
