import type {
  CustomDomainRecord,
  PlatformRepository,
  PlatformUsage,
  ReaderGrantRecord,
} from "@/lib/platform";

import { ensureRuntimeDatabaseRole, getSql, withTenant } from "./neon";

export class NeonPlatformRepository implements PlatformRepository {
  async getSite(input: { tenantId: string; siteId: string }) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT id, slug, reader_access
        FROM sites
        WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.siteId}::uuid
      `,
    ]);
    const row = rows[0] as
      | { id: string; slug: string; reader_access: "public" | "authenticated" }
      | undefined;
    return row
      ? { id: row.id, slug: row.slug, readerAccess: row.reader_access }
      : undefined;
  }

  async setSiteReaderAccess(
    input: Parameters<PlatformRepository["setSiteReaderAccess"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        WITH changed AS (
          UPDATE sites SET reader_access = ${input.readerAccess}
          WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.siteId}::uuid
            AND reader_access IS DISTINCT FROM ${input.readerAccess}
          RETURNING id
        ), audit AS (
          INSERT INTO audit_events (
            tenant_id, principal_kind, principal_id, action, target_kind,
            target_id, outcome, metadata
          )
          SELECT ${input.tenantId}::uuid, 'human-session', ${input.userId}::uuid,
            'site.reader-access.update', 'site', changed.id, 'succeeded',
            jsonb_build_object('readerAccess', ${input.readerAccess})
          FROM changed
        )
        SELECT EXISTS (SELECT 1 FROM changed) AS changed
      `,
    ]);
    return Boolean((rows[0] as { changed?: boolean } | undefined)?.changed);
  }

  async listCustomDomains(input: { tenantId: string; siteId: string }) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT id, site_id, hostname, status, last_error_code, verified_at,
               last_checked_at, challenge_expires_at, created_at
        FROM custom_domains
        WHERE tenant_id = ${input.tenantId}::uuid AND site_id = ${input.siteId}::uuid
        ORDER BY created_at DESC, id DESC
      `,
    ]);
    return rows.map(mapCustomDomain);
  }

  async createCustomDomain(
    input: Parameters<PlatformRepository["createCustomDomain"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM create_custom_domain(
          ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.siteId}::uuid,
          ${input.domainId}::uuid, ${input.hostname}, ${input.challengeDigest},
          ${input.challengeExpiresAt}
        )
      `,
    ]);
    const row = rows[0];
    if (!row) throw new Error("Custom domain creation returned no row");
    return mapCustomDomain(row);
  }

  async recordCustomDomainCheck(
    input: Parameters<PlatformRepository["recordCustomDomainCheck"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM record_custom_domain_check(
          ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.domainId}::uuid,
          ${input.challengeDigest}, ${input.verified}, ${input.errorCode ?? null}
        )
      `,
    ]);
    const row = rows[0];
    if (!row) throw new Error("Custom domain check returned no row");
    return mapCustomDomain(row);
  }

  async disableCustomDomain(
    input: Parameters<PlatformRepository["disableCustomDomain"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT disable_custom_domain(
          ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.domainId}::uuid
        ) AS disabled
      `,
    ]);
    return Boolean((rows[0] as { disabled?: boolean } | undefined)?.disabled);
  }

  async listReaderGrants(input: { tenantId: string; siteId: string }) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT id, site_id, label, expires_at, max_redemptions,
               redemption_count, revoked_at, created_at
        FROM reader_grants
        WHERE tenant_id = ${input.tenantId}::uuid AND site_id = ${input.siteId}::uuid
        ORDER BY created_at DESC, id DESC
      `,
    ]);
    return rows.map(mapReaderGrant);
  }

  async createReaderGrant(
    input: Parameters<PlatformRepository["createReaderGrant"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM create_reader_grant(
          ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.siteId}::uuid,
          ${input.grantId}::uuid, ${input.label}, ${input.tokenDigest},
          ${input.expiresAt}, ${input.maxRedemptions}
        )
      `,
    ]);
    const row = rows[0];
    if (!row) throw new Error("Reader grant creation returned no row");
    return mapReaderGrant(row);
  }

  async revokeReaderGrant(
    input: Parameters<PlatformRepository["revokeReaderGrant"]>[0],
  ) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT revoke_reader_grant(
          ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.grantId}::uuid
        ) AS revoked
      `,
    ]);
    return Boolean((rows[0] as { revoked?: boolean } | undefined)?.revoked);
  }

  async redeemReaderGrant(
    input: Parameters<PlatformRepository["redeemReaderGrant"]>[0],
  ) {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT * FROM redeem_reader_grant(
        ${input.grantDigest}, ${input.sessionId}::uuid, ${input.sessionDigest},
        ${input.sessionExpiresAt}, ${input.expectedSiteSlug}
      )
    `;
    const row = rows[0] as
      | {
          tenant_id: string;
          site_id: string;
          site_slug: string;
          session_expires_at: Date;
        }
      | undefined;
    return row
      ? {
          tenantId: row.tenant_id,
          siteId: row.site_id,
          siteSlug: row.site_slug,
          sessionExpiresAt: row.session_expires_at,
        }
      : undefined;
  }

  async getUsage(tenantId: string): Promise<PlatformUsage> {
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`SELECT * FROM get_platform_usage(${tenantId}::uuid)`,
    ]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("Platform usage returned no row");
    return {
      sites: counter(row.sites_used, row.sites_limit),
      customDomains: counter(row.domains_used, row.domains_limit),
      readerGrants: counter(row.reader_grants_used, row.reader_grants_limit),
      apiKeys: counter(row.api_keys_used, row.api_keys_limit),
      connectors: counter(row.connectors_used, row.connectors_limit),
      storageBytes: counter(row.storage_bytes_used, row.storage_bytes_limit),
      derivativeJobs: counter(
        row.derivative_jobs_used,
        row.derivative_jobs_limit,
      ),
    };
  }
}

function mapCustomDomain(row: Record<string, unknown>): CustomDomainRecord {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    hostname: String(row.hostname),
    status: row.status as CustomDomainRecord["status"],
    lastErrorCode: optionalString(row.last_error_code),
    verifiedAt: optionalDate(row.verified_at),
    lastCheckedAt: optionalDate(row.last_checked_at),
    challengeExpiresAt: new Date(String(row.challenge_expires_at)),
    createdAt: new Date(String(row.created_at)),
  };
}

function mapReaderGrant(row: Record<string, unknown>): ReaderGrantRecord {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    label: String(row.label),
    expiresAt: new Date(String(row.expires_at)),
    maxRedemptions: Number(row.max_redemptions),
    redemptionCount: Number(row.redemption_count),
    revokedAt: optionalDate(row.revoked_at),
    createdAt: new Date(String(row.created_at)),
  };
}

function counter(used: unknown, limit: unknown) {
  return { used: Number(used), limit: Number(limit) };
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function optionalDate(value: unknown) {
  return value ? new Date(String(value)) : undefined;
}
