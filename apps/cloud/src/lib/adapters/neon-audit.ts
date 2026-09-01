import {
  decodeAuditCursor,
  encodeAuditCursor,
  publicAuditMetadata,
  type AuditEvent,
  type AuditEventFilters,
  type AuditEventPage,
  type AuditPrincipalKind,
  type AuditRepository,
} from "@/lib/audit";

import { withTenant } from "./neon";

interface AuditRow {
  id: string;
  principal_kind: AuditPrincipalKind;
  principal_id: string | null;
  action: string;
  target_kind: string;
  target_id: string | null;
  outcome: string;
  metadata: unknown;
  created_at: Date;
}

export class NeonAuditRepository implements AuditRepository {
  async list(
    tenantId: string,
    filters: AuditEventFilters,
  ): Promise<AuditEventPage> {
    const cursor = filters.cursor
      ? decodeAuditCursor(filters.cursor)
      : undefined;
    if (filters.cursor && !cursor) throw new TypeError("Invalid audit cursor");
    const queryLimit = filters.limit + 1;
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`
        SELECT id, principal_kind::text, principal_id, action, target_kind,
               target_id, outcome, metadata, created_at
        FROM audit_events
        WHERE tenant_id = ${tenantId}::uuid
          AND (${filters.action ?? null}::text IS NULL OR action = ${filters.action ?? null})
          AND (${filters.outcome ?? null}::text IS NULL OR outcome = ${filters.outcome ?? null})
          AND (${filters.principalKind ?? null}::text IS NULL
            OR principal_kind::text = ${filters.principalKind ?? null})
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT ${queryLimit}
      `,
    ]);
    const pageRows = (rows as AuditRow[]).slice(0, filters.limit);
    const events = pageRows.map(mapAuditEvent);
    const last = pageRows.at(-1);
    return {
      events,
      nextCursor:
        rows.length > filters.limit && last
          ? encodeAuditCursor({ createdAt: last.created_at, id: last.id })
          : null,
    };
  }
}

function mapAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    outcome: row.outcome,
    metadata: publicAuditMetadata(row.metadata),
    createdAt: row.created_at,
  };
}
