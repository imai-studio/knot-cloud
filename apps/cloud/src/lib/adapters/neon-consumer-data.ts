import type {
  AnytypeOperation,
  ConsumerApiKeyCreate,
  ConsumerApiKeyMetadata,
  ScopeName,
} from "@imai/knot-cloud-contract";

import {
  ConsumerDataError,
  type ConsumerDataRepository,
  type ConsumerOperationRecord,
  type ResolvedConsumerApiKey,
} from "@/lib/consumer-data";

import { ensureRuntimeDatabaseRole, getSql, withTenant } from "./neon";

interface ApiKeyRow {
  id: string;
  tenant_id?: string;
  name: string;
  key_id: string;
  key_digest?: string;
  digest_version?: number;
  scopes: string[];
  connector_ids: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  requests_per_minute: number;
  requests_per_day: number;
}

function unixSeconds(value: Date | null): number | null {
  return value === null ? null : Math.floor(value.getTime() / 1_000);
}

function mapMetadata(row: ApiKeyRow): ConsumerApiKeyMetadata {
  if (!Array.isArray(row.scopes) || !Array.isArray(row.connector_ids)) {
    throw new TypeError("API key scopes and connectors must be arrays");
  }
  return {
    id: row.id,
    name: row.name,
    keyId: row.key_id,
    scopes: row.scopes as ConsumerApiKeyMetadata["scopes"],
    connectorIds: row.connector_ids,
    expiresAt: unixSeconds(row.expires_at),
    revokedAt: unixSeconds(row.revoked_at),
    createdAt: unixSeconds(row.created_at)!,
    requestsPerMinute: row.requests_per_minute,
    requestsPerDay: row.requests_per_day,
  };
}

export class NeonConsumerDataRepository implements ConsumerDataRepository {
  async resolveApiKey(
    keyId: string,
  ): Promise<ResolvedConsumerApiKey | undefined> {
    if (!/^[A-Za-z0-9_-]{16}$/u.test(keyId)) return undefined;
    await ensureRuntimeDatabaseRole();
    const rows = await getSql().query(
      `SELECT
        id, tenant_id, key_digest, digest_version, scopes::text[] AS scopes,
        expires_at, revoked_at, requests_per_minute, requests_per_day, connector_ids
       FROM resolve_consumer_api_key($1::text)`,
      [keyId],
    );
    const row = rows[0] as ApiKeyRow | undefined;
    if (!row?.tenant_id || !row.key_digest || row.digest_version === undefined)
      return undefined;
    if (!Array.isArray(row.scopes) || !Array.isArray(row.connector_ids)) {
      throw new TypeError("API key scopes and connectors must be arrays");
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      keyId,
      keyDigest: row.key_digest,
      digestVersion: row.digest_version,
      scopes: row.scopes as ScopeName[],
      connectorIds: row.connector_ids,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      requestsPerMinute: row.requests_per_minute,
      requestsPerDay: row.requests_per_day,
    };
  }

  async rehashApiKey(input: {
    tenantId: string;
    apiKeyId: string;
    expectedDigestVersion: number;
    digest: string;
    digestVersion: number;
  }): Promise<void> {
    await withTenant(input.tenantId, (transaction) => [
      transaction`
        UPDATE api_keys
        SET key_digest = ${input.digest}, digest_version = ${input.digestVersion}
        WHERE tenant_id = ${input.tenantId}::uuid
          AND id = ${input.apiKeyId}::uuid
          AND digest_version = ${input.expectedDigestVersion}
          AND revoked_at IS NULL
      `,
    ]);
  }

  async listApiKeys(tenantId: string): Promise<ConsumerApiKeyMetadata[]> {
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`
        SELECT
          key.id, key.name, key.key_id, key.scopes::text[] AS scopes,
          COALESCE(array_agg(binding.connector_id ORDER BY binding.connector_id)
            FILTER (WHERE binding.connector_id IS NOT NULL), '{}'::uuid[]) AS connector_ids,
          key.expires_at, key.revoked_at, key.created_at,
          key.requests_per_minute, key.requests_per_day
        FROM api_keys AS key
        LEFT JOIN api_key_connectors AS binding
          ON binding.tenant_id = key.tenant_id AND binding.api_key_id = key.id
        WHERE key.tenant_id = ${tenantId}::uuid
        GROUP BY key.id
        ORDER BY key.created_at DESC, key.id
      `,
    ]);
    return (rows as ApiKeyRow[]).map(mapMetadata);
  }

  async getApiKey(
    tenantId: string,
    apiKeyId: string,
  ): Promise<ConsumerApiKeyMetadata | undefined> {
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`
        SELECT
          key.id, key.name, key.key_id, key.scopes::text[] AS scopes,
          COALESCE(array_agg(binding.connector_id ORDER BY binding.connector_id)
            FILTER (WHERE binding.connector_id IS NOT NULL), '{}'::uuid[]) AS connector_ids,
          key.expires_at, key.revoked_at, key.created_at,
          key.requests_per_minute, key.requests_per_day
        FROM api_keys AS key
        LEFT JOIN api_key_connectors AS binding
          ON binding.tenant_id = key.tenant_id AND binding.api_key_id = key.id
        WHERE key.tenant_id = ${tenantId}::uuid AND key.id = ${apiKeyId}::uuid
        GROUP BY key.id
      `,
    ]);
    const row = (rows as ApiKeyRow[])[0];
    return row ? mapMetadata(row) : undefined;
  }

  async createApiKey(input: {
    tenantId: string;
    userId: string;
    values: ConsumerApiKeyCreate;
    keyId: string;
    keyDigest: string;
    digestVersion: number;
  }): Promise<ConsumerApiKeyMetadata> {
    const expiresAt = input.values.expiresAt
      ? new Date(input.values.expiresAt * 1_000)
      : null;
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT create_consumer_api_key(
          ${input.tenantId}::uuid,
          ${input.userId}::uuid,
          ${input.values.name},
          ${input.keyId},
          ${input.keyDigest},
          ${input.digestVersion}::smallint,
          ${input.values.scopes}::scope_name[],
          ${input.values.connectorIds}::uuid[],
          ${expiresAt},
          ${input.values.requestsPerMinute},
          ${input.values.requestsPerDay}
        ) AS id
      `,
    ]);
    const id = (rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new Error("API key creation returned no identifier");
    const created = await this.getApiKey(input.tenantId, id);
    if (!created) throw new Error("Created API key could not be read");
    return created;
  }

  async rotateApiKey(input: {
    tenantId: string;
    userId: string;
    apiKeyId: string;
    keyId: string;
    keyDigest: string;
    digestVersion: number;
  }): Promise<ConsumerApiKeyMetadata | undefined> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT rotate_consumer_api_key(
          ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.apiKeyId}::uuid,
          ${input.keyId}, ${input.keyDigest}, ${input.digestVersion}::smallint
        ) AS rotated
      `,
    ]);
    if (!(rows[0] as { rotated: boolean } | undefined)?.rotated)
      return undefined;
    return this.getApiKey(input.tenantId, input.apiKeyId);
  }

  async revokeApiKey(input: {
    tenantId: string;
    userId: string;
    apiKeyId: string;
  }): Promise<boolean> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT revoke_consumer_api_key(
          ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.apiKeyId}::uuid
        ) AS revoked
      `,
    ]);
    return Boolean((rows[0] as { revoked: boolean } | undefined)?.revoked);
  }

  async enqueueOperation(input: {
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
  }): Promise<{ commandId: string; state: string; created: boolean }> {
    try {
      const [rows = []] = await withTenant(input.tenantId, (transaction) => [
        transaction`
          SELECT * FROM enqueue_consumer_operation(
            ${input.tenantId}::uuid, ${input.apiKeyId}::uuid,
            ${input.connectorId}::uuid, ${input.requiredScope}::scope_name,
            ${JSON.stringify(input.operation)}::jsonb, ${input.idempotencyKey},
            ${input.requestSha256}, ${input.createdAt}, ${input.expiresAt},
            ${input.actorDigest}, ${input.actorDigestVersion}::smallint
          )
        `,
      ]);
      const row = rows[0] as
        | { command_id: string; command_state: string; was_created: boolean }
        | undefined;
      if (!row) throw new Error("Operation enqueue returned no command");
      return {
        commandId: row.command_id,
        state: row.command_state,
        created: row.was_created,
      };
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async getOperation(input: {
    tenantId: string;
    apiKeyId: string;
    commandId: string;
  }): Promise<ConsumerOperationRecord | undefined> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT
          id, connector_id, payload -> 'operation' AS operation, state,
          attempt_count, result, error_code, created_at, expires_at, updated_at
        FROM commands
        WHERE tenant_id = ${input.tenantId}::uuid
          AND id = ${input.commandId}::uuid
          AND created_by_kind = 'consumer-api-key'
          AND created_by_id = ${input.apiKeyId}::uuid
      `,
    ]);
    const row = rows[0] as
      | {
          id: string;
          connector_id: string;
          operation: AnytypeOperation;
          state: ConsumerOperationRecord["state"];
          attempt_count: number;
          result: unknown;
          error_code: string | null;
          created_at: Date;
          expires_at: Date;
          updated_at: Date;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      connectorId: row.connector_id,
      operation: row.operation,
      state: row.state,
      attemptCount: row.attempt_count,
      result: row.result,
      errorCode: row.error_code,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    };
  }
}

function mapDatabaseError(error: unknown): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "P0001" && message.includes("quota exceeded")) {
    return new ConsumerDataError("quota-exceeded", "API key quota exceeded");
  }
  if (code === "23505" && message.includes("Idempotency")) {
    return new ConsumerDataError(
      "idempotency-conflict",
      "The idempotency key was used for another request",
    );
  }
  if (code === "42501" && message.includes("scope")) {
    return new ConsumerDataError("scope-denied", "API key scope denied");
  }
  if (code === "42501" && message.includes("Connector")) {
    return new ConsumerDataError(
      "connector-denied",
      "Connector binding denied",
    );
  }
  if (code === "28000") {
    return new ConsumerDataError(
      "authentication-required",
      "The consumer API key is inactive",
    );
  }
  if (code === "22023") {
    return new ConsumerDataError("invalid-request", "The operation is invalid");
  }
  return error instanceof Error
    ? error
    : new Error("Database operation failed");
}
