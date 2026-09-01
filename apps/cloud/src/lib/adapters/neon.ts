import {
  neon,
  type NeonQueryFunction,
  type NeonQueryFunctionInTransaction,
  type NeonQueryInTransaction,
} from "@neondatabase/serverless";

import { getCloudEnvironment } from "@/lib/env";

let sql: NeonQueryFunction<false, false> | undefined;
let runtimeRoleAssertion: Promise<void> | undefined;

export function getSql(): NeonQueryFunction<false, false> {
  sql ??= neon(getCloudEnvironment().DATABASE_URL);
  return sql;
}

export async function withTenant(
  tenantId: string,
  buildQueries: (
    transaction: NeonQueryFunctionInTransaction<false, false>,
  ) => NeonQueryInTransaction[],
) {
  await ensureRuntimeDatabaseRole();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      tenantId,
    )
  ) {
    throw new TypeError("tenantId must be a UUID");
  }

  const results = await getSql().transaction((transaction) => [
    transaction`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    ...buildQueries(transaction),
  ]);
  return results.slice(1);
}

export async function assertRuntimeDatabaseRole(): Promise<void> {
  const rows = await getSql()`
    SELECT
      current_user AS role_name,
      current_setting('is_superuser') = 'on' AS is_superuser,
      rolbypassrls AS bypasses_rls,
      rolcreatedb AS can_create_database,
      rolcreaterole AS can_create_role,
      rolinherit AS inherits_roles,
      EXISTS (
        SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid
      ) AS has_role_membership
    FROM pg_roles
    WHERE rolname = current_user
  `;
  const role = rows[0] as
    | {
        role_name: string;
        is_superuser: boolean;
        bypasses_rls: boolean;
        can_create_database: boolean;
        can_create_role: boolean;
        inherits_roles: boolean;
        has_role_membership: boolean;
      }
    | undefined;
  if (
    !role ||
    role.is_superuser ||
    role.bypasses_rls ||
    role.can_create_database ||
    role.can_create_role ||
    role.inherits_roles ||
    role.has_role_membership ||
    role.role_name !== "knot_app"
  ) {
    throw new Error(
      "DATABASE_URL must authenticate directly as the restricted knot_app role",
    );
  }
}

export function ensureRuntimeDatabaseRole(): Promise<void> {
  runtimeRoleAssertion ??= assertRuntimeDatabaseRole().catch((error) => {
    runtimeRoleAssertion = undefined;
    throw error;
  });
  return runtimeRoleAssertion;
}
