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

export interface JobPublisher {
  publish(input: {
    topic: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<void>;
}
