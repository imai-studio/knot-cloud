import { UpstashReplayNonceStore } from "./upstash-replay";
import { R2PrivateObjectStore } from "./r2";

import type { ObjectStore, ReplayNonceStore } from "@/lib/ports";

export function createObjectStore(): ObjectStore {
  const driver = process.env.OBJECT_STORE_DRIVER ?? "r2";
  if (driver === "r2") return new R2PrivateObjectStore();
  throw new Error(`Unsupported OBJECT_STORE_DRIVER: ${driver}`);
}

export function createReplayNonceStore(): ReplayNonceStore {
  const driver = process.env.REPLAY_STORE_DRIVER ?? "upstash";
  if (driver === "upstash") return new UpstashReplayNonceStore();
  throw new Error(`Unsupported REPLAY_STORE_DRIVER: ${driver}`);
}
