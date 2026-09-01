import { describe, expect, it, vi } from "vitest";

import { problemResponse } from "./problem";

describe("problem response", () => {
  it.each([429, 503] as const)(
    "adds Retry-After to retryable %s responses",
    (status) => {
      const response = problemResponse({
        problemBaseUrl: "https://trusted.knot.test/console",
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
      problemBaseUrl: "https://trusted.knot.test/console",
      status: 500,
      code: "internal-error",
      title: "Try again later",
      retryable: true,
      retryAfterSeconds: 17,
    });

    expect(response.headers.has("Retry-After")).toBe(false);
  });

  it("builds problem types from the trusted application origin", async () => {
    const response = problemResponse({
      problemBaseUrl: "https://trusted.knot.test/console",
      status: 400,
      code: "invalid-request",
      title: "Invalid request",
    });

    await expect(response.json()).resolves.toMatchObject({
      type: "https://trusted.knot.test/problems/invalid-request",
    });
  });

  it("logs only a fixed event and response correlation metadata", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = problemResponse({
      problemBaseUrl: "https://trusted.knot.test",
      status: 503,
      code: "dependency-unavailable",
      title: "Unavailable",
      detail: "secret provider diagnostic",
      logEvent: "connector-provider-unavailable",
    });
    const body = await response.json();

    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      level: "error",
      event: "connector-provider-unavailable",
      requestId: body.requestId,
      status: 503,
      code: "dependency-unavailable",
    });
    expect(error.mock.calls[0]?.[0]).not.toContain(
      "secret provider diagnostic",
    );
    error.mockRestore();
  });
});
