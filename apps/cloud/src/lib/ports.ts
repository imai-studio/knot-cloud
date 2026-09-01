export interface StoredObject {
  pathname: string;
  contentType: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

export interface ObjectStore {
  putImmutable(input: {
    pathname: string;
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentLength?: number;
    contentType: string;
  }): Promise<{ pathname: string; size: number }>;
  get(pathname: string): Promise<StoredObject | undefined>;
  delete(pathnames: string[]): Promise<void>;
}

export interface ReplayNonceStore {
  claim(input: {
    connectorId: string;
    nonce: string;
    expiresAt: number;
  }): Promise<"claimed" | "replayed">;
}

export interface ConnectorRateLimitStore {
  consume(input: {
    connectorId: string;
    limit: number;
    windowSeconds: number;
    nowUnixSeconds: number;
  }): Promise<boolean>;
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
    connectorId: string;
    commandId: string;
    attempt: number;
    leaseToken: string;
    leaseSeconds: number;
  }): Promise<Date | undefined>;
  complete(input: {
    tenantId: string;
    connectorId: string;
    commandId: string;
    attempt: number;
    leaseToken: string;
    completion: CommandCompletion;
  }): Promise<{
    status: "accepted" | "duplicate" | "stale" | "unknown-lease";
    state: string;
  }>;
}
