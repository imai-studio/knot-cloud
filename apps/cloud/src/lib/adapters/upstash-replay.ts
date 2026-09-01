import { Redis } from "@upstash/redis";

import { getUpstashEnvironment } from "@/lib/env";
import type { ReplayNonceStore } from "@/lib/ports";

export class UpstashReplayNonceStore implements ReplayNonceStore {
  async claim(input: {
    connectorId: string;
    nonce: string;
    expiresAt: number;
  }): Promise<"claimed" | "replayed"> {
    const redis = getRedis();
    const ttlSeconds = Math.max(
      1,
      input.expiresAt - Math.floor(Date.now() / 1_000),
    );
    const result = await redis.set(
      `connector-nonce:${input.connectorId}:${input.nonce}`,
      "1",
      {
        ex: ttlSeconds,
        nx: true,
      },
    );

    return result === "OK" ? "claimed" : "replayed";
  }
}

let redis: Redis | undefined;

function getRedis(): Redis {
  const environment = getUpstashEnvironment();
  redis ??= new Redis({
    url: environment.UPSTASH_REDIS_REST_URL,
    token: environment.UPSTASH_REDIS_REST_TOKEN,
  });
  return redis;
}
