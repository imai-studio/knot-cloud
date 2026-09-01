import { UpstashReplayNonceStore } from "./upstash-replay";
import { R2PrivateObjectStore } from "./r2";

import type {
  ConnectorRateLimitStore,
  ObjectStore,
  ReplayNonceStore,
} from "@/lib/ports";
import type { PublicAssetStore } from "@/lib/public-reader";

let objectStore: ObjectStore | undefined;

export function createObjectStore(): ObjectStore {
  const driver = process.env.OBJECT_STORE_DRIVER ?? "r2";
  if (driver === "r2") return (objectStore ??= new R2PrivateObjectStore());
  throw new Error(`Unsupported OBJECT_STORE_DRIVER: ${driver}`);
}

export function createPublicAssetStore(): PublicAssetStore {
  const store = createObjectStore();
  return { get: (locator) => store.get(locator) };
}

export function createReplayNonceStore(): ReplayNonceStore &
  ConnectorRateLimitStore {
  const driver = process.env.REPLAY_STORE_DRIVER ?? "upstash";
  if (driver === "upstash") return new UpstashReplayNonceStore();
  throw new Error(`Unsupported REPLAY_STORE_DRIVER: ${driver}`);
}
