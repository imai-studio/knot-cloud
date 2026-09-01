import {
  parsePublicPageRecord,
  type PublicAssetRecord,
  type PublicReaderRepository,
} from "@/lib/public-reader";

import { ensureRuntimeDatabaseRole, getSql } from "./neon";

export class NeonPublicReaderRepository implements PublicReaderRepository {
  async resolveSiteAccess(siteSlug: string) {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT resolve_reader_site_access(${siteSlug}) AS reader_access
    `;
    const access = rows[0]?.reader_access;
    return access === "public" || access === "authenticated"
      ? access
      : undefined;
  }

  async resolveCustomDomainSite(hostname: string) {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT * FROM resolve_custom_domain_site(${hostname})
    `;
    const row = rows[0] as
      | { site_slug: string; reader_access: "public" | "authenticated" }
      | undefined;
    return row
      ? { siteSlug: row.site_slug, readerAccess: row.reader_access }
      : undefined;
  }

  async resolvePage(input: {
    siteSlug: string;
    publicationSlug: string;
    sessionDigest?: string;
  }) {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT * FROM resolve_reader_page(
        ${input.siteSlug}, ${input.publicationSlug}, ${input.sessionDigest ?? ""}
      )
    `;
    const row = rows[0] as
      | {
          tenant_id: string;
          site_id: string;
          publication_id: string;
          version_id: string;
          document: unknown;
          content_sha256: string;
          updated_at: Date;
        }
      | undefined;
    if (!row) return undefined;
    return parsePublicPageRecord({
      tenantId: row.tenant_id,
      siteId: row.site_id,
      publicationId: row.publication_id,
      versionId: row.version_id,
      document: row.document,
      contentSha256: row.content_sha256,
      updatedAt: row.updated_at,
    });
  }

  async resolveAsset(input: {
    siteSlug: string;
    publicationId: string;
    sha256: string;
    sessionDigest?: string;
  }): Promise<PublicAssetRecord | undefined> {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT * FROM resolve_reader_asset(
        ${input.siteSlug}, ${input.publicationId}::uuid, ${input.sha256},
        ${input.sessionDigest ?? ""}
      )
    `;
    const row = rows[0] as
      | {
          tenant_id: string;
          publication_id: string;
          version_id: string;
          sha256: string;
          content_type: string;
          byte_size: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      versionId: row.version_id,
      sha256: row.sha256,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
    };
  }
}
