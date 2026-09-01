import type {
  ConnectorRecord,
  ConnectorRepository,
} from "@/lib/security/connector-auth";

import { ensureRuntimeDatabaseRole, getSql } from "./neon";

interface ConnectorRow {
  id: string;
  tenant_id: string;
  public_key: Uint8Array;
  protocol_version: string;
  scopes: string[];
  revoked_at: string | null;
}

export class NeonConnectorRepository implements ConnectorRepository {
  async findActiveConnector(id: string): Promise<ConnectorRecord | undefined> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        id,
      )
    ) {
      return undefined;
    }
    await ensureRuntimeDatabaseRole();
    const rows = await getSql().query(
      `SELECT
        id,
        tenant_id,
        public_key,
        protocol_version,
        scopes::text[] AS scopes,
        revoked_at
       FROM resolve_connector($1::uuid)`,
      [id],
    );
    const row = rows[0] as ConnectorRow | undefined;
    if (!row) return undefined;
    if (!Array.isArray(row.scopes)) {
      throw new TypeError("Connector scopes must be returned as an array");
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicKey: row.public_key,
      protocolVersion: row.protocol_version,
      scopes: row.scopes,
      revoked: row.revoked_at !== null,
    };
  }
}
