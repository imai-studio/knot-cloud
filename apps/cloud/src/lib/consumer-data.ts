import type {
  AnytypeOperation,
  ConsumerApiKeyCreate,
  ConsumerApiKeyMetadata,
  ScopeName,
} from "@imai/knot-cloud-contract";

export interface ResolvedConsumerApiKey {
  id: string;
  tenantId: string;
  keyId: string;
  keyDigest: string;
  digestVersion: number;
  scopes: ScopeName[];
  connectorIds: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  requestsPerMinute: number;
  requestsPerDay: number;
}

export interface ConsumerOperationRecord {
  id: string;
  connectorId: string;
  operation: AnytypeOperation;
  state:
    | "pending"
    | "leased"
    | "succeeded"
    | "rejected-by-local-policy"
    | "failed"
    | "expired"
    | "cancelled"
    | "dead-lettered";
  attemptCount: number;
  result: unknown;
  errorCode: string | null;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
}

export class ConsumerDataError extends Error {
  constructor(
    readonly code:
      | "authentication-required"
      | "connector-denied"
      | "scope-denied"
      | "quota-exceeded"
      | "idempotency-conflict"
      | "invalid-request",
    message: string,
  ) {
    super(message);
    this.name = "ConsumerDataError";
  }
}

export interface ConsumerDataRepository {
  resolveApiKey(keyId: string): Promise<ResolvedConsumerApiKey | undefined>;
  rehashApiKey(input: {
    tenantId: string;
    apiKeyId: string;
    expectedDigestVersion: number;
    digest: string;
    digestVersion: number;
  }): Promise<void>;
  listApiKeys(tenantId: string): Promise<ConsumerApiKeyMetadata[]>;
  getApiKey(
    tenantId: string,
    apiKeyId: string,
  ): Promise<ConsumerApiKeyMetadata | undefined>;
  createApiKey(input: {
    tenantId: string;
    userId: string;
    values: ConsumerApiKeyCreate;
    keyId: string;
    keyDigest: string;
    digestVersion: number;
  }): Promise<ConsumerApiKeyMetadata>;
  rotateApiKey(input: {
    tenantId: string;
    userId: string;
    apiKeyId: string;
    keyId: string;
    keyDigest: string;
    digestVersion: number;
  }): Promise<ConsumerApiKeyMetadata | undefined>;
  revokeApiKey(input: {
    tenantId: string;
    userId: string;
    apiKeyId: string;
  }): Promise<boolean>;
  enqueueOperation(input: {
    tenantId: string;
    apiKeyId: string;
    connectorId: string;
    requiredScope: ScopeName;
    operation: AnytypeOperation;
    idempotencyKey: string;
    requestSha256: string;
    createdAt: Date;
    expiresAt: Date;
    actorDigest: string;
    actorDigestVersion: number;
  }): Promise<{ commandId: string; state: string; created: boolean }>;
  getOperation(input: {
    tenantId: string;
    apiKeyId: string;
    commandId: string;
  }): Promise<ConsumerOperationRecord | undefined>;
}
