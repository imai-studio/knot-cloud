import {
  pairingSessionStatusSchema,
  protocolVersion,
  type PairingGrant,
  type PairingSessionCreate,
} from "@imai/knot-cloud-contract";

import type {
  ManagedConnector,
  PairingDecisionOutcome,
  PairingRepository,
  PairingReview,
} from "@/lib/pairing";

import { ensureRuntimeDatabaseRole, getSql, withTenant } from "./neon";

interface ReviewRow {
  id: string;
  connector_name: string;
  public_key: Uint8Array;
  protocol_version: string;
  requested_scopes: string[];
  requested_site_ids: string[];
  requested_slug_grants: string[];
  status: PairingReview["status"];
  expires_at: Date;
  created_at: Date;
  approved_at: Date | null;
  denied_at: Date | null;
  poll_consumed_at: Date | null;
  granted_scopes: string[] | null;
  granted_site_ids: string[] | null;
  granted_slug_grants: string[] | null;
}

interface SiteRow {
  id: string;
  name: string;
  slug: string;
}

interface ConnectorRow {
  id: string;
  name: string;
  public_key: Uint8Array;
  protocol_version: string;
  scopes: string[];
  site_ids: string[];
  slug_grants: string[];
  revoked_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
}

interface PollRow {
  pairing_id: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  expires_at: Date;
  connector_id: string | null;
  tenant_id: string | null;
  granted_scopes: string[] | null;
  granted_site_ids: string[] | null;
  granted_slug_grants: string[] | null;
  approved_at: Date | null;
}

export class NeonPairingRepository implements PairingRepository {
  async create(input: {
    tenantId: string;
    actorUserId: string;
    request: PairingSessionCreate;
    pollTokenDigest: string;
    expiresAt: Date;
  }): Promise<string> {
    const publicKey = Buffer.from(input.request.publicKey, "base64url");
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        WITH created_pairing AS (
          INSERT INTO pairing_sessions (
            tenant_id, created_by_user_id, connector_name, protocol_version,
            public_key, requested_scopes, requested_site_ids,
            requested_slug_grants,
            poll_token_digest, expires_at
          ) VALUES (
            ${input.tenantId}::uuid, ${input.actorUserId}::uuid,
            ${input.request.connectorName}, ${input.request.protocolVersion},
            ${publicKey}, ${input.request.requestedScopes}::scope_name[],
            ${input.request.requestedSiteIds}::uuid[],
            ${input.request.requestedSlugGrants}::text[],
            ${input.pollTokenDigest}, ${input.expiresAt}
          ) RETURNING id
        ), recorded_audit AS (
          INSERT INTO audit_events (
            tenant_id, principal_kind, principal_id, action,
            target_kind, target_id, outcome
          )
          SELECT ${input.tenantId}::uuid, 'human-session',
            ${input.actorUserId}::uuid, 'connector.pair.create',
            'pairing-session', id, 'succeeded'
          FROM created_pairing
        )
        SELECT id FROM created_pairing
      `,
    ]);
    const row = rows[0] as { id: string } | undefined;
    if (!row) throw new Error("Pairing creation returned no ID");
    return row.id;
  }

  async listReviews(tenantId: string): Promise<PairingReview[]> {
    const now = new Date();
    const [, rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`
        DELETE FROM pairing_sessions
        WHERE tenant_id = ${tenantId}::uuid
          AND expires_at < ${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)}
      `,
      transaction`
        SELECT id, connector_name, public_key, protocol_version,
          requested_scopes, requested_site_ids, requested_slug_grants,
          CASE
            WHEN state = 'pending' AND expires_at <= ${now} THEN 'expired'
            ELSE state::text
          END AS status,
          expires_at, created_at, approved_at, denied_at, poll_consumed_at,
          granted_scopes, granted_site_ids, granted_slug_grants
        FROM pairing_sessions
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at DESC
        LIMIT 50
      `,
    ]);
    return (rows as ReviewRow[]).map((row) => ({
      id: row.id,
      connectorName: row.connector_name,
      publicKey: Buffer.from(row.public_key).toString("base64url"),
      protocolVersion: row.protocol_version,
      requestedScopes: row.requested_scopes,
      requestedSiteIds: row.requested_site_ids,
      requestedSlugGrants: row.requested_slug_grants,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
      deniedAt: row.denied_at,
      pollConsumedAt: row.poll_consumed_at,
      grantedScopes: row.granted_scopes ?? [],
      grantedSiteIds: row.granted_site_ids ?? [],
      grantedSlugGrants: row.granted_slug_grants ?? [],
    }));
  }

  async listSites(tenantId: string) {
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`
        SELECT id, name, slug
        FROM sites
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY lower(name), id
        LIMIT 100
      `,
    ]);
    return (rows as SiteRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
    }));
  }

  async approve(input: {
    tenantId: string;
    actorUserId: string;
    pairingId: string;
    grant: PairingGrant;
    now: Date;
  }): Promise<{ outcome: PairingDecisionOutcome; connectorId?: string }> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM approve_pairing_session(
          ${input.tenantId}::uuid, ${input.pairingId}::uuid,
          ${input.actorUserId}::uuid, ${input.grant.scopes}::scope_name[],
          ${input.grant.siteIds}::uuid[], ${input.grant.slugGrants}::text[],
          ${input.now}
        )
      `,
    ]);
    const row = rows[0] as
      | { outcome: PairingDecisionOutcome; connector_id: string | null }
      | undefined;
    if (!row) throw new Error("Pairing approval returned no outcome");
    return {
      outcome: row.outcome,
      ...(row.connector_id ? { connectorId: row.connector_id } : {}),
    };
  }

  async deny(input: {
    tenantId: string;
    actorUserId: string;
    pairingId: string;
    now: Date;
  }): Promise<PairingDecisionOutcome> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT deny_pairing_session(
          ${input.tenantId}::uuid, ${input.pairingId}::uuid,
          ${input.actorUserId}::uuid, ${input.now}
        ) AS outcome
      `,
    ]);
    const row = rows[0] as { outcome: PairingDecisionOutcome } | undefined;
    if (!row) throw new Error("Pairing denial returned no outcome");
    return row.outcome;
  }

  async poll(input: { pairingId: string; pollTokenDigest: string; now: Date }) {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql().query(
      `SELECT * FROM poll_pairing_session($1::uuid, $2::text, $3::timestamptz)`,
      [input.pairingId, input.pollTokenDigest, input.now],
    );
    const row = rows[0] as PollRow | undefined;
    if (!row) return undefined;
    const common = {
      protocolVersion,
      pairingId: row.pairing_id,
      status: row.status,
    };
    if (row.status === "pending") {
      return pairingSessionStatusSchema.parse({
        ...common,
        expiresAt: Math.floor(row.expires_at.getTime() / 1_000),
      });
    }
    if (row.status === "approved") {
      return pairingSessionStatusSchema.parse({
        ...common,
        connectorId: row.connector_id,
        tenantId: row.tenant_id,
        grant: {
          scopes: row.granted_scopes,
          siteIds: row.granted_site_ids,
          slugGrants: row.granted_slug_grants,
        },
        approvedAt: Math.floor((row.approved_at as Date).getTime() / 1_000),
      });
    }
    return pairingSessionStatusSchema.parse(common);
  }

  async listConnectors(tenantId: string): Promise<ManagedConnector[]> {
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`
        SELECT connector.id, connector.name, connector.public_key,
          connector.protocol_version, connector.scopes,
          connector.revoked_at, connector.last_seen_at, connector.created_at,
          ARRAY(
            SELECT site_id::text FROM connector_site_grants
            WHERE tenant_id = connector.tenant_id AND connector_id = connector.id
            ORDER BY site_id
          ) AS site_ids,
          ARRAY(
            SELECT slug_grant FROM connector_slug_grants
            WHERE tenant_id = connector.tenant_id AND connector_id = connector.id
            ORDER BY slug_grant
          ) AS slug_grants
        FROM connectors AS connector
        WHERE connector.tenant_id = ${tenantId}::uuid
        ORDER BY connector.created_at DESC
      `,
    ]);
    return (rows as ConnectorRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      publicKey: Buffer.from(row.public_key).toString("base64url"),
      protocolVersion: row.protocol_version,
      scopes: row.scopes,
      siteIds: row.site_ids,
      slugGrants: row.slug_grants,
      revokedAt: row.revoked_at,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    }));
  }

  async rename(input: {
    tenantId: string;
    actorUserId: string;
    connectorId: string;
    name: string;
  }): Promise<boolean> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT rename_connector(
          ${input.tenantId}::uuid, ${input.connectorId}::uuid,
          ${input.actorUserId}::uuid, ${input.name}
        ) AS changed
      `,
    ]);
    return (rows[0] as { changed: boolean } | undefined)?.changed ?? false;
  }

  async revoke(input: {
    tenantId: string;
    actorUserId: string;
    connectorId: string;
    now: Date;
  }): Promise<boolean> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT revoke_connector(
          ${input.tenantId}::uuid, ${input.connectorId}::uuid,
          ${input.actorUserId}::uuid, ${input.now}
        ) AS changed
      `,
    ]);
    return (rows[0] as { changed: boolean } | undefined)?.changed ?? false;
  }
}
