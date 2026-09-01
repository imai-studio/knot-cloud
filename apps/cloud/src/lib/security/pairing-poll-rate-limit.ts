import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";

import { getUpstashEnvironment } from "@/lib/env";

const limit = 30;
const windowSeconds = 60;

const fixedWindowScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return { count, ttl }
`;

export interface PairingPollRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface PairingPollCounter {
  increment(key: string, ttlSeconds: number): Promise<[number, number]>;
}

export async function checkPairingPollRateLimit(
  request: Request,
  counter: PairingPollCounter = getCounter(),
): Promise<PairingPollRateLimitResult> {
  const addressDigest = createHash("sha256")
    .update(pairingPollClientAddress(request), "utf8")
    .digest("hex");
  const bucket = Math.floor(Date.now() / (windowSeconds * 1_000));
  const [count, ttl] = await counter.increment(
    `pairing-poll:v1:${addressDigest}:${bucket}`,
    windowSeconds,
  );
  return {
    allowed: count <= limit,
    retryAfterSeconds: Math.max(1, ttl),
  };
}

export function pairingPollClientAddress(request: Request): string {
  const forwarded = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",", 1)[0]
    ?.trim();
  return forwarded && forwarded.length <= 128 ? forwarded : "unknown-client";
}

class UpstashPairingPollCounter implements PairingPollCounter {
  private readonly script;

  constructor(redis: Redis) {
    this.script = redis.createScript<[number, number]>(fixedWindowScript);
  }

  increment(key: string, ttlSeconds: number): Promise<[number, number]> {
    return this.script.eval([key], [String(ttlSeconds)]);
  }
}

let counter: PairingPollCounter | undefined;

function getCounter(): PairingPollCounter {
  const environment = getUpstashEnvironment();
  counter ??= new UpstashPairingPollCounter(
    new Redis({
      url: environment.UPSTASH_REDIS_REST_URL,
      token: environment.UPSTASH_REDIS_REST_TOKEN,
    }),
  );
  return counter;
}
