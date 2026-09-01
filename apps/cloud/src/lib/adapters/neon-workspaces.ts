import { ensureRuntimeDatabaseRole, getSql } from "./neon";

import type {
  WorkspaceRecord,
  WorkspaceRepository,
} from "@/lib/workspace-auth";

interface WorkspaceRow {
  user_id: string;
  tenant_id: string;
  tenant_name: string;
  member_role: "owner" | "admin" | "member";
  suspended_at: string | null;
}

export class NeonWorkspaceRepository implements WorkspaceRepository {
  async resolveOrBootstrap(input: {
    authSessionId: string;
    authUserId: string;
    emailDigest: string;
    emailDigestVersion: number;
    defaultWorkspaceName: string;
  }): Promise<WorkspaceRecord | undefined> {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql().query(
      `SELECT * FROM resolve_or_bootstrap_workspace(
        $1::text, $2::text, $3::text, $4::smallint, $5::text
      )`,
      [
        input.authSessionId,
        input.authUserId,
        input.emailDigest,
        input.emailDigestVersion,
        input.defaultWorkspaceName,
      ],
    );
    return mapWorkspace(rows[0] as WorkspaceRow | undefined);
  }

  async selectForSession(input: {
    authSessionId: string;
    authUserId: string;
    tenantId: string;
  }): Promise<WorkspaceRecord | undefined> {
    await ensureRuntimeDatabaseRole();
    const rows = await getSql().query(
      `SELECT * FROM select_workspace_for_session(
        $1::text, $2::text, $3::uuid
      )`,
      [input.authSessionId, input.authUserId, input.tenantId],
    );
    return mapWorkspace(rows[0] as WorkspaceRow | undefined);
  }
}

function mapWorkspace(
  row: WorkspaceRow | undefined,
): WorkspaceRecord | undefined {
  if (!row) return undefined;
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    name: row.tenant_name,
    role: row.member_role,
    suspended: row.suspended_at !== null,
  };
}
