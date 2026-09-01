import {
  parsePublicPageRecord,
  type PublicAssetRecord,
  type PublicReaderRepository,
} from "@/lib/public-reader";

import { ensureRuntimeDatabaseRole, getSql } from "./neon";

export class NeonPublicReaderRepository implements PublicReaderRepository {
  async resolvePage(input: { siteSlug: string; publicationSlug: string }) {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT * FROM resolve_public_reader_page(
        ${input.siteSlug}, ${input.publicationSlug}
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
  }): Promise<PublicAssetRecord | undefined> {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql()`
      SELECT * FROM resolve_public_reader_asset(
        ${input.siteSlug}, ${input.publicationId}::uuid, ${input.sha256}
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
