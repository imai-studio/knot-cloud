import { createHash, randomBytes } from "node:crypto";

import type {
  ClaimedCommand,
  CommandCompletion,
  CommandLedger,
} from "@/lib/ports";

import { withTenant } from "./neon";

interface ClaimedCommandRow {
  command_id: string;
  required_scope: string;
  payload: unknown;
  created_by_kind: string;
  created_at: Date;
  not_before: Date;
  expires_at: Date;
  attempt: number;
  lease_expires_at: Date;
}

interface CompletionRow {
  completion_status: "accepted" | "duplicate" | "stale" | "unknown-lease";
  command_state: string;
}

function digestLeaseToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validateLeaseSeconds(value: number): void {
  if (!Number.isInteger(value) || value < 5 || value > 300) {
    throw new TypeError("leaseSeconds must be an integer between 5 and 300");
  }
}

function completionValues(completion: CommandCompletion): {
  outcome: CommandCompletion["outcome"];
  result: unknown;
  errorCode: string | null;
  retryable: boolean;
  retryAfterSeconds: number;
} {
  switch (completion.outcome) {
    case "succeeded":
      return {
        outcome: completion.outcome,
        result: completion.result,
        errorCode: null,
        retryable: false,
        retryAfterSeconds: 0,
      };
    case "rejected-by-local-policy":
      return {
        outcome: completion.outcome,
        result: null,
        errorCode: completion.reasonCode,
        retryable: false,
        retryAfterSeconds: 0,
      };
    case "failed":
      return {
        outcome: completion.outcome,
        result: null,
        errorCode: completion.errorCode,
        retryable: completion.retryable,
        retryAfterSeconds: completion.retryAfterSeconds ?? 0,
      };
  }
}

export function serializeCommandResult(result: unknown): string | null {
  if (result === null) return null;
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new TypeError(
      "A successful command result must be JSON serializable",
    );
  }
  return serialized;
}

export class NeonCommandLedger implements CommandLedger {
  async claim(input: {
    tenantId: string;
    connectorId: string;
    allowedScopes: string[];
    leaseSeconds: number;
  }): Promise<ClaimedCommand | undefined> {
    validateLeaseSeconds(input.leaseSeconds);
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseTokenDigest = digestLeaseToken(leaseToken);
    const now = new Date();
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT *
        FROM claim_command(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.allowedScopes}::scope_name[],
          ${now},
          ${leaseTokenDigest},
          ${input.leaseSeconds}
        )
      `,
    ]);
    const row = rows[0] as ClaimedCommandRow | undefined;
    if (!row) return undefined;
    return {
      commandId: row.command_id,
      requiredScope: row.required_scope,
      payload: row.payload,
      createdByKind: row.created_by_kind,
      createdAt: row.created_at,
      notBefore: row.not_before,
      expiresAt: row.expires_at,
      attempt: row.attempt,
      leaseToken,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  async extend(input: {
    tenantId: string;
    connectorId: string;
    commandId: string;
    attempt: number;
    leaseToken: string;
    leaseSeconds: number;
  }): Promise<Date | undefined> {
    validateLeaseSeconds(input.leaseSeconds);
    const now = new Date();
    const digest = digestLeaseToken(input.leaseToken);
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT extend_command_lease(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.commandId}::uuid,
          ${input.attempt},
          ${now},
          ${digest},
          ${input.leaseSeconds}
        ) AS lease_expires_at
      `,
    ]);
    const row = rows[0] as { lease_expires_at: Date | null } | undefined;
    return row?.lease_expires_at ?? undefined;
  }

  async complete(input: {
    tenantId: string;
    connectorId: string;
    commandId: string;
    attempt: number;
    leaseToken: string;
    completion: CommandCompletion;
  }): Promise<{
    status: "accepted" | "duplicate" | "stale" | "unknown-lease";
    state: string;
  }> {
    const values = completionValues(input.completion);
    const now = new Date();
    const digest = digestLeaseToken(input.leaseToken);
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT *
        FROM complete_command(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.commandId}::uuid,
          ${input.attempt},
          ${now},
          ${digest},
          ${values.outcome}::command_state,
          ${serializeCommandResult(values.result)}::jsonb,
          ${values.errorCode},
          ${values.retryable},
          ${values.retryAfterSeconds}
        )
      `,
    ]);
    const row = rows[0] as CompletionRow | undefined;
    if (!row) return { status: "unknown-lease", state: "expired" };
    return { status: row.completion_status, state: row.command_state };
  }
}
