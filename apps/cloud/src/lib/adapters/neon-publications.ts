import type {
  DeletionOutboxItem,
  DeletionOutboxRepository,
  PreparedAssetUpload,
  PreparedPublicationVersion,
  ConnectorPublicationStatus,
  PublicationRecord,
  PublicationRepository,
  SiteRecord,
} from "@/lib/publications";

import { ensureRuntimeDatabaseRole, getSql, withTenant } from "./neon";

export class NeonPublicationRepository implements PublicationRepository {
  async listSites(tenantId: string): Promise<SiteRecord[]> {
    const [rows = []] = await withTenant(tenantId, (transaction) => [
      transaction`
        SELECT id, name, slug, created_at
        FROM sites WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at, id
      `,
    ]);
    return rows.map(mapSite);
  }

  async createSite(input: {
    tenantId: string;
    name: string;
    slug: string;
  }): Promise<SiteRecord> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        INSERT INTO sites (tenant_id, name, slug)
        VALUES (${input.tenantId}::uuid, ${input.name}, ${input.slug})
        RETURNING id, name, slug, created_at
      `,
    ]);
    const row = rows[0];
    if (!row) throw new Error("Site creation returned no row");
    return mapSite(row);
  }

  async listPublications(input: {
    tenantId: string;
    siteId: string;
  }): Promise<PublicationRecord[]> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT id, site_id, slug, current_version_id, disabled_at,
               unpublished_at, updated_at
        FROM publications
        WHERE tenant_id = ${input.tenantId}::uuid
          AND site_id = ${input.siteId}::uuid
        ORDER BY updated_at DESC, id
      `,
    ]);
    return rows.map(mapPublication);
  }

  async prepareAssetUpload(input: {
    tenantId: string;
    connectorId: string;
    siteId: string;
    uploadId: string;
    assetId: string;
    sha256: string;
    pathname: string;
    contentType: string;
    byteSize: number;
    fileName: string;
    idempotencyKey: string;
    expiresAt: Date;
  }): Promise<PreparedAssetUpload> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM prepare_asset_upload(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.siteId}::uuid,
          ${input.uploadId}::uuid,
          ${input.assetId}::uuid,
          ${input.sha256},
          ${input.pathname},
          ${input.contentType},
          ${input.byteSize},
          ${input.fileName},
          ${input.idempotencyKey},
          ${input.expiresAt}
        )
      `,
    ]);
    const row = rows[0] as
      | {
          upload_id: string;
          asset_id: string;
          expires_at: Date;
          duplicate: boolean;
        }
      | undefined;
    if (!row) throw new Error("Asset preparation returned no row");
    return {
      uploadId: row.upload_id,
      assetId: row.asset_id,
      expiresAt: row.expires_at,
      duplicate: row.duplicate,
    };
  }

  async commitAssetUpload(input: {
    tenantId: string;
    connectorId: string;
    uploadId: string;
    assetId: string;
    observedSha256: string;
    observedByteSize: number;
    observedContentType: string;
  }) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM commit_asset_upload(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.uploadId}::uuid,
          ${input.assetId}::uuid,
          ${input.observedSha256},
          ${input.observedByteSize},
          ${input.observedContentType}
        )
      `,
    ]);
    const row = rows[0] as
      | {
          asset_id: string;
          sha256: string;
          byte_size: number;
          verified_at: Date;
        }
      | undefined;
    if (!row) throw new Error("Asset commit returned no row");
    return {
      assetId: row.asset_id,
      sha256: row.sha256,
      byteSize: Number(row.byte_size),
      verifiedAt: row.verified_at,
    };
  }

  async preparePublicationVersion(
    input: Parameters<PublicationRepository["preparePublicationVersion"]>[0],
  ): Promise<PreparedPublicationVersion> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM prepare_publication_version_authorized(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.siteId}::uuid,
          ${input.publicationId}::uuid,
          ${input.versionId}::uuid,
          ${input.slug},
          ${input.operation},
          ${input.schemaVersion},
          ${input.contentSha256},
          ${input.bundlePath},
          ${JSON.stringify(input.document)}::jsonb,
          ${JSON.stringify(input.sourceProvenance ?? {})}::jsonb,
          ${input.idempotencyKey}
        )
      `,
    ]);
    const row = rows[0] as
      | {
          publication_id: string;
          version_id: string;
          bundle_path: string;
          version_state: PreparedPublicationVersion["state"];
          duplicate: boolean;
        }
      | undefined;
    if (!row) throw new Error("Publication preparation returned no row");
    return {
      publicationId: row.publication_id,
      versionId: row.version_id,
      bundlePath: row.bundle_path,
      state: row.version_state,
      duplicate: row.duplicate,
    };
  }

  async commitPublicationVersion(
    input: Parameters<PublicationRepository["commitPublicationVersion"]>[0],
  ): Promise<"ready"> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT commit_publication_version(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.publicationId}::uuid,
          ${input.versionId}::uuid,
          ${input.assetDigests}::text[]
        ) AS state
      `,
    ]);
    const row = rows[0] as { state: "ready" } | undefined;
    if (row?.state !== "ready") {
      throw new Error("Publication commit returned an invalid state");
    }
    return row.state;
  }

  async disable(input: { tenantId: string; publicationId: string }) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT disable_publication(
          ${input.tenantId}::uuid, ${input.publicationId}::uuid
        ) AS at
      `,
    ]);
    const row = rows[0] as { at: Date } | undefined;
    if (!row) throw new Error("Publication disable returned no state");
    return row.at;
  }

  async rollback(input: {
    tenantId: string;
    publicationId: string;
    versionId: string;
  }) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT rollback_publication(
          ${input.tenantId}::uuid,
          ${input.publicationId}::uuid,
          ${input.versionId}::uuid
        ) AS version_id
      `,
    ]);
    const row = rows[0] as { version_id: string } | undefined;
    if (!row) throw new Error("Publication rollback returned no state");
    return row.version_id;
  }

  async unpublish(input: { tenantId: string; publicationId: string }) {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT unpublish_publication(
          ${input.tenantId}::uuid, ${input.publicationId}::uuid
        ) AS at
      `,
    ]);
    const row = rows[0] as { at: Date } | undefined;
    if (!row) throw new Error("Publication unpublish returned no state");
    return row.at;
  }

  async getConnectorStatus(input: {
    tenantId: string;
    connectorId: string;
    publicationId: string;
  }): Promise<ConnectorPublicationStatus> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM get_connector_publication_status(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.publicationId}::uuid
        )
      `,
    ]);
    const row = rows[0] as
      | {
          publication_id: string;
          site_id: string;
          slug: string;
          publication_status: ConnectorPublicationStatus["state"];
          current_version_id: string | null;
          updated_at: Date;
        }
      | undefined;
    if (!row)
      throw Object.assign(new Error("Publication not found"), {
        code: "P0002",
      });
    return {
      publicationId: row.publication_id,
      siteId: row.site_id,
      slug: row.slug,
      state: row.publication_status,
      currentVersionId: row.current_version_id ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  async controlAsConnector(
    input: Parameters<PublicationRepository["controlAsConnector"]>[0],
  ) {
    const versionId =
      input.operation.type === "publication.rollback"
        ? input.operation.versionId
        : null;
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT control_publication_as_connector(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.operation.publicationId}::uuid,
          ${input.operation.type},
          ${versionId}::uuid,
          ${input.idempotencyKey},
          ${input.requestSha256}
        ) AS result
      `,
    ]);
    const row = rows[0] as { result: unknown } | undefined;
    if (!row) throw new Error("Publication control returned no state");
    return row.result as Awaited<
      ReturnType<PublicationRepository["controlAsConnector"]>
    >;
  }
}

export class NeonDeletionOutboxRepository implements DeletionOutboxRepository {
  async listMaintenanceTenants(input: {
    now: Date;
    graceSeconds: number;
    limit: number;
  }): Promise<string[]> {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT tenant_id FROM list_publication_maintenance_tenants(
        ${input.now}, ${input.graceSeconds}, ${input.limit}
      )
    `;
    return rows.map((row) => String(row.tenant_id));
  }

  async sweepOrphans(input: {
    tenantId: string;
    now: Date;
    graceSeconds: number;
    limit: number;
  }): Promise<number> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT enqueue_publication_orphan_deletions(
          ${input.tenantId}::uuid,
          ${input.now},
          ${input.graceSeconds},
          ${input.limit}
        ) AS enqueued
      `,
    ]);
    return Number((rows[0] as { enqueued: number } | undefined)?.enqueued ?? 0);
  }

  async countDeadLetters(input: { tenantId: string }): Promise<number> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT count(*)::integer AS count
        FROM deletion_outbox
        WHERE tenant_id = ${input.tenantId}::uuid
          AND completed_at IS NULL
          AND dead_lettered_at IS NOT NULL
      `,
    ]);
    return Number((rows[0] as { count: number } | undefined)?.count ?? 0);
  }

  async claim(input: {
    tenantId: string;
    now: Date;
    leaseTokenDigest: string;
    leaseSeconds: number;
    limit: number;
  }): Promise<DeletionOutboxItem[]> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT * FROM claim_deletion_outbox(
          ${input.tenantId}::uuid,
          ${input.now},
          ${input.leaseTokenDigest},
          ${input.leaseSeconds},
          ${input.limit}
        )
      `,
    ]);
    return rows.map((value) => {
      const row = value as {
        outbox_id: string;
        publication_id: string | null;
        asset_id: string | null;
        pathname: string;
        tombstoned_at: Date;
        attempt: number;
      };
      return {
        id: row.outbox_id,
        publicationId: row.publication_id ?? undefined,
        assetId: row.asset_id ?? undefined,
        pathname: row.pathname,
        tombstonedAt: row.tombstoned_at,
        attempt: row.attempt,
      };
    });
  }

  async complete(input: {
    tenantId: string;
    itemId: string;
    leaseTokenDigest: string;
    now: Date;
  }): Promise<boolean> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT complete_deletion_outbox(
          ${input.tenantId}::uuid,
          ${input.itemId}::uuid,
          ${input.leaseTokenDigest},
          ${input.now}
        ) AS completed
      `,
    ]);
    return (rows[0] as { completed: boolean } | undefined)?.completed ?? false;
  }

  async retry(input: {
    tenantId: string;
    itemId: string;
    leaseTokenDigest: string;
    now: Date;
    delaySeconds: number;
    errorCode: string;
  }): Promise<boolean> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT retry_deletion_outbox(
          ${input.tenantId}::uuid,
          ${input.itemId}::uuid,
          ${input.leaseTokenDigest},
          ${input.now},
          ${input.delaySeconds},
          ${input.errorCode}
        ) AS retried
      `,
    ]);
    return (rows[0] as { retried: boolean } | undefined)?.retried ?? false;
  }

  async finalize(input: {
    tenantId: string;
    publicationId: string;
  }): Promise<boolean> {
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT finalize_unpublished_publication(
          ${input.tenantId}::uuid, ${input.publicationId}::uuid
        ) AS finalized
      `,
    ]);
    return (rows[0] as { finalized: boolean } | undefined)?.finalized ?? false;
  }
}

function mapSite(value: unknown): SiteRecord {
  const row = value as {
    id: string;
    name: string;
    slug: string;
    created_at: Date;
  };
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
  };
}

function mapPublication(value: unknown): PublicationRecord {
  const row = value as {
    id: string;
    site_id: string;
    slug: string;
    current_version_id: string | null;
    disabled_at: Date | null;
    unpublished_at: Date | null;
    updated_at: Date;
  };
  return {
    id: row.id,
    siteId: row.site_id,
    slug: row.slug,
    currentVersionId: row.current_version_id ?? undefined,
    disabledAt: row.disabled_at ?? undefined,
    unpublishedAt: row.unpublished_at ?? undefined,
    updatedAt: row.updated_at,
  };
}
