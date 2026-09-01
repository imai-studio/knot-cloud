export const privateObjectCacheControl =
  "private, no-store, max-age=0" as const;

export interface ObjectLocator {
  tenantId: string;
  sha256: string;
}

export interface StoredObjectDescriptor extends ObjectLocator {
  key: string;
  contentType: string;
  size: number;
}

export interface StoredObject {
  descriptor: StoredObjectDescriptor;
  cacheControl: typeof privateObjectCacheControl;
  stream: ReadableStream<Uint8Array>;
}

export interface TombstonedObject {
  tenantId: string;
  key: string;
  tombstonedAt: Date;
}

export interface ObjectStore {
  readonly maxObjectBytes: number;
  putImmutable(input: {
    locator: ObjectLocator;
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentLength?: number;
    contentType: string;
  }): Promise<StoredObjectDescriptor>;
  get(locator: ObjectLocator): Promise<StoredObject | undefined>;
  deleteTombstoned(objects: TombstonedObject[]): Promise<void>;
}

export type ObjectVisibility = "active" | "missing" | "tombstoned";

export interface ObjectVisibilityStore {
  getVisibility(locator: ObjectLocator): Promise<ObjectVisibility>;
}

export type PrivateObjectRead =
  | { status: "available"; object: StoredObject }
  | {
      status: "not-found";
      cacheControl: typeof privateObjectCacheControl;
    };

export class RevocableObjectReader {
  constructor(
    private readonly objects: ObjectStore,
    private readonly visibility: ObjectVisibilityStore,
  ) {}

  async get(locator: ObjectLocator): Promise<PrivateObjectRead> {
    if ((await this.visibility.getVisibility(locator)) !== "active") {
      return {
        status: "not-found",
        cacheControl: privateObjectCacheControl,
      };
    }

    const object = await this.objects.get(locator);
    if (!object) {
      return {
        status: "not-found",
        cacheControl: privateObjectCacheControl,
      };
    }
    if ((await this.visibility.getVisibility(locator)) !== "active") {
      await object.stream.cancel("object was tombstoned during the read");
      return {
        status: "not-found",
        cacheControl: privateObjectCacheControl,
      };
    }
    return { status: "available", object };
  }
}

export interface ReplayNonceStore {
  claim(input: {
    connectorId: string;
    nonce: string;
    expiresAt: number;
  }): Promise<"claimed" | "replayed">;
}

export interface JobPublisher {
  publish(input: {
    topic: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<void>;
}

export interface ClaimedCommand {
  commandId: string;
  requiredScope: string;
  payload: unknown;
  createdByKind: string;
  createdAt: Date;
  notBefore: Date;
  expiresAt: Date;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export type CommandCompletion =
  | { outcome: "succeeded"; result: unknown }
  | { outcome: "rejected-by-local-policy"; reasonCode: string }
  | {
      outcome: "failed";
      retryable: boolean;
      errorCode: string;
      retryAfterSeconds?: number;
    };

export interface CommandLedger {
  claim(input: {
    tenantId: string;
    connectorId: string;
    allowedScopes: string[];
    leaseSeconds: number;
  }): Promise<ClaimedCommand | undefined>;
  extend(input: {
    tenantId: string;
    commandId: string;
    attempt: number;
    leaseToken: string;
    leaseSeconds: number;
  }): Promise<Date | undefined>;
  complete(input: {
    tenantId: string;
    commandId: string;
    attempt: number;
    leaseToken: string;
    completion: CommandCompletion;
  }): Promise<{
    status: "accepted" | "duplicate" | "stale" | "unknown-lease";
    state: string;
  }>;
}
