export const auditPrincipalKinds = [
  "human-session",
  "connector-key",
  "consumer-api-key",
  "first-party-service",
] as const;

export type AuditPrincipalKind = (typeof auditPrincipalKinds)[number];

export interface AuditEvent {
  id: string;
  principalKind: AuditPrincipalKind;
  principalId: string | null;
  action: string;
  targetKind: string;
  targetId: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditEventPage {
  events: AuditEvent[];
  nextCursor: string | null;
}

export interface AuditEventFilters {
  action?: string;
  outcome?: string;
  principalKind?: AuditPrincipalKind;
  cursor?: string;
  limit: number;
}

export interface AuditRepository {
  list(tenantId: string, filters: AuditEventFilters): Promise<AuditEventPage>;
}

export interface AuditCursor {
  createdAt: Date;
  id: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

export function decodeAuditCursor(value: string): AuditCursor | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      return undefined;
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !uuidPattern.test(parsed.id)) {
      return undefined;
    }
    return { createdAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

const safeMetadataKeys = new Set([
  "connectors",
  "connectorId",
  "newName",
  "oldName",
  "priorScopes",
  "requestSha256",
  "scope",
  "scopes",
  "siteIds",
  "slugGrants",
]);

export function publicAuditMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => {
      if (!safeMetadataKeys.has(key)) return false;
      if (
        item === null ||
        ["string", "number", "boolean"].includes(typeof item)
      ) {
        return true;
      }
      return (
        Array.isArray(item) && item.every((entry) => typeof entry === "string")
      );
    }),
  );
}
