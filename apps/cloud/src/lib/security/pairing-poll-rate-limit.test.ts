import { describe, expect, it, vi } from "vitest";

import {
  checkPairingPollRateLimit,
  pairingPollClientAddress,
} from "./pairing-poll-rate-limit";

describe("pairing poll rate limit", () => {
  it("uses only the platform-normalized client address", () => {
    const request = new Request("https://knot.example/api/v1/pairing/poll", {
      headers: {
        "x-forwarded-for": "203.0.113.1",
        "x-vercel-forwarded-for": "198.51.100.2, 10.0.0.1",
      },
    });
    expect(pairingPollClientAddress(request)).toBe("198.51.100.2");
    expect(
      pairingPollClientAddress(
        new Request("https://knot.example/api/v1/pairing/poll", {
          headers: { "x-forwarded-for": "203.0.113.1" },
        }),
      ),
    ).toBe("unknown-client");
  });

  it("allows 120 attempts per fixed window and returns the store TTL", async () => {
    const counter = { increment: vi.fn() };
    counter.increment.mockResolvedValueOnce([120, 22]);
    counter.increment.mockResolvedValueOnce([121, 21]);
    const request = new Request("https://knot.example/api/v1/pairing/poll", {
      headers: { "x-vercel-forwarded-for": "198.51.100.2" },
    });

    await expect(checkPairingPollRateLimit(request, counter)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 22,
    });
    await expect(checkPairingPollRateLimit(request, counter)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 21,
    });
    expect(counter.increment.mock.calls[0]?.[0]).not.toContain("198.51.100.2");
  });
});
