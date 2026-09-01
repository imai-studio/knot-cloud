import { Redis } from "@upstash/redis";

import { getUpstashEnvironment } from "@/lib/env";
import type { ConnectorRateLimitStore, ReplayNonceStore } from "@/lib/ports";

const incrementWindowScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

export class UpstashReplayNonceStore
  implements ReplayNonceStore, ConnectorRateLimitStore
{
  readonly #redis: Redis;

  constructor() {
    const environment = getUpstashEnvironment();
    this.#redis = new Redis({
      url: environment.UPSTASH_REDIS_REST_URL,
      token: environment.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  async claim(input: {
    connectorId: string;
    nonce: string;
    expiresAt: number;
  }): Promise<"claimed" | "replayed"> {
    const ttlSeconds = Math.max(
      1,
      input.expiresAt - Math.floor(Date.now() / 1_000),
    );
    const result = await this.#redis.set(
      `connector-nonce:${input.connectorId}:${input.nonce}`,
      "1",
      {
        ex: ttlSeconds,
        nx: true,
      },
    );

    return result === "OK" ? "claimed" : "replayed";
  }

  async consume(input: {
    connectorId: string;
    limit: number;
    windowSeconds: number;
    nowUnixSeconds: number;
  }): Promise<boolean> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      !Number.isInteger(input.windowSeconds) ||
      input.windowSeconds < 1
    ) {
      throw new TypeError("Rate limit and window must be positive integers");
    }
    const window = Math.floor(input.nowUnixSeconds / input.windowSeconds);
    const count = await this.#redis.eval<unknown[], number>(
      incrementWindowScript,
      [`connector-rate:${input.connectorId}:${window}`],
      [String(input.windowSeconds + 1)],
    );
    return count <= input.limit;
  }
}
