import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";
const connectorA = "00000000-0000-4000-8000-000000000011";
const connectorB = "00000000-0000-4000-8000-000000000012";
const apiKeyA = "00000000-0000-4000-8000-000000000021";
const authUserA = "auth-user-workspace-a";
const authSessionA = "auth-session-workspace-a";
const authSessionB = "auth-session-workspace-b";

describe("P0 database isolation", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE knot_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS;
      GRANT CREATE ON DATABASE postgres TO knot_migrator;
      ALTER SCHEMA public OWNER TO knot_migrator;
      GRANT knot_migrator TO CURRENT_USER;
      SET ROLE knot_migrator;
    `);
    await database.exec(`
      CREATE TABLE schema_migrations (
        name text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrationDirectory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "migrations",
    );
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => /^\d+.*\.sql$/u.test(name))
      .sort();
    for (const migrationFile of migrationFiles) {
      await database.exec(
        await readFile(path.join(migrationDirectory, migrationFile), "utf8"),
      );
    }
    await database.exec("RESET ROLE");
    await database.exec(`
      INSERT INTO tenants (id, name) VALUES
        ('${tenantA}', 'Tenant A'),
        ('${tenantB}', 'Tenant B');
      INSERT INTO connectors (
        id, tenant_id, name, protocol_version, public_key, scopes
      ) VALUES
        ('${connectorA}', '${tenantA}', 'A', '1.0', decode(repeat('00', 32), 'hex'), '{}'),
        ('${connectorB}', '${tenantB}', 'B', '1.0', decode(repeat('00', 32), 'hex'), '{}');
      INSERT INTO api_keys (
        id, tenant_id, name, key_id, key_digest, scopes
      ) VALUES (
        '${apiKeyA}', '${tenantA}', 'A key', 'abcdefghijklmnop', repeat('0', 64), '{}'
      );
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  it("fails closed without a tenant and reveals only the selected tenant", async () => {
    await database.exec("SET ROLE knot_app");
    const withoutTenant = await database.query<{ id: string }>(
      "SELECT id FROM tenants",
    );
    expect(withoutTenant.rows).toEqual([]);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [
      tenantA,
    ]);
    const result = await database.query<{ id: string }>(
      "SELECT id FROM tenants ORDER BY id",
    );
    expect(result.rows).toEqual([{ id: tenantA }]);
  });

  it("rejects cross-tenant references and runtime DDL", async () => {
    await database.exec("SET ROLE knot_app");
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [
      tenantA,
    ]);
    await expect(
      database.query(
        `INSERT INTO api_key_connectors (tenant_id, api_key_id, connector_id)
         VALUES ($1, $2, $3)`,
        [tenantA, apiKeyA, connectorB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database.exec("ALTER TABLE connectors DISABLE ROW LEVEL SECURITY"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("resolves credentials without exposing tenant tables", async () => {
    await database.exec("SET ROLE knot_app");
    const plain = await database.query<{ id: string }>(
      "SELECT id FROM connectors WHERE id = $1",
      [connectorA],
    );
    expect(plain.rows).toEqual([]);
    const resolved = await database.query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM resolve_connector($1)",
      [connectorA],
    );
    expect(resolved.rows).toEqual([{ id: connectorA, tenant_id: tenantA }]);
    const apiKey = await database.query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM resolve_api_key($1)",
      ["abcdefghijklmnop"],
    );
    expect(apiKey.rows).toEqual([{ id: apiKeyA, tenant_id: tenantA }]);
  });

  it("keeps the migration ledger private and permits cleanup after unpublish", async () => {
    const runtimeRole = await database.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      has_membership: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit,
              EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid)
                AS has_membership
       FROM pg_roles WHERE rolname = 'knot_app'`,
    );
    expect(runtimeRole.rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        has_membership: false,
      },
    ]);

    const privileges = await database.query<{ can_read: boolean }>(
      "SELECT has_table_privilege('knot_app', 'schema_migrations', 'SELECT') AS can_read",
    );
    expect(privileges.rows).toEqual([{ can_read: false }]);

    const site = "00000000-0000-4000-8000-000000000031";
    const publication = "00000000-0000-4000-8000-000000000041";
    await database.exec(`
      INSERT INTO sites (id, tenant_id, name, slug)
      VALUES ('${site}', '${tenantA}', 'Site A', 'tenant-a');
      INSERT INTO publications (id, tenant_id, site_id, slug, unpublished_at)
      VALUES ('${publication}', '${tenantA}', '${site}', 'page', now());
      INSERT INTO deletion_outbox (tenant_id, publication_id, pathname)
      VALUES ('${tenantA}', '${publication}', 'bundles/page-1');
      DELETE FROM publications WHERE id = '${publication}';
      UPDATE deletion_outbox SET completed_at = now()
      WHERE tenant_id = '${tenantA}' AND pathname = 'bundles/page-1';
      INSERT INTO deletion_outbox (tenant_id, pathname)
      VALUES ('${tenantA}', 'bundles/page-1');
    `);
    const outbox = await database.query<{ publication_id: string | null }>(
      "SELECT publication_id FROM deletion_outbox ORDER BY created_at",
    );
    expect(outbox.rows).toEqual([
      { publication_id: null },
      { publication_id: null },
    ]);
  });

  it("does not grant the runtime role access to future tables", async () => {
    await database.exec(`
      SET ROLE knot_migrator;
      CREATE TABLE future_private_table (id uuid PRIMARY KEY);
      RESET ROLE;
      SET ROLE knot_app;
    `);
    await expect(
      database.query("SELECT id FROM future_private_table"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("limits the runtime role to data access in the auth schema", async () => {
    await database.exec("SET ROLE knot_app");
    await database.exec(`
      INSERT INTO auth."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        'auth-user-1', 'Raj', 'raj@example.test', true, now(), now()
      )
    `);
    const result = await database.query<{ email: string }>(
      `SELECT email FROM auth."user" WHERE id = 'auth-user-1'`,
    );
    expect(result.rows).toEqual([{ email: "raj@example.test" }]);
    await database.exec(`
      INSERT INTO auth."rateLimit" (id, key, count, "lastRequest")
      VALUES ('test-rate-limit', '127.0.0.1:/sign-in/magic-link', 1, 1)
    `);
    await expect(
      database.exec("CREATE TABLE auth.runtime_escape (id text)"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("allows an asset key to be recreated only after the old row is deleted", async () => {
    const digest = "1".repeat(64);
    await database.exec(`
      INSERT INTO assets (
        tenant_id, sha256, pathname, content_type, byte_size, deleted_at
      ) VALUES (
        '${tenantA}', '${digest}', 'assets/reusable', 'image/png', 1, now()
      );
      INSERT INTO assets (
        tenant_id, sha256, pathname, content_type, byte_size
      ) VALUES (
        '${tenantA}', '${digest}', 'assets/reusable', 'image/png', 1
      );
    `);
    await expect(
      database.exec(`
        INSERT INTO assets (
          tenant_id, sha256, pathname, content_type, byte_size
        ) VALUES (
          '${tenantA}', '${digest}', 'assets/reusable', 'image/png', 1
        )
      `),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("uses the frozen least-privilege scope vocabulary", async () => {
    const labels = await database.query<{ enumlabel: string }>(
      `SELECT enumlabel
       FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'scope_name'
       ORDER BY enumlabel`,
    );
    expect(labels.rows.map((row) => row.enumlabel)).toContain(
      "anytype.chats.send",
    );
    expect(labels.rows.map((row) => row.enumlabel)).not.toContain(
      "anytype.chats.write",
    );
    expect(labels.rows.map((row) => row.enumlabel)).toEqual(
      expect.arrayContaining([
        "anytype.collections.read",
        "anytype.files.read",
        "publications.read",
      ]),
    );
  });

  it("rejects a command whose required scope does not match its operation", async () => {
    await expect(
      database.exec(`
        INSERT INTO commands (
          tenant_id,
          connector_id,
          required_scope,
          payload,
          not_before,
          expires_at,
          idempotency_key,
          created_by_kind,
          created_by_id
        ) VALUES (
          '${tenantA}',
          '${connectorA}',
          'anytype.objects.read',
          '{"domain":"anytype","operation":{"type":"object.update"}}',
          now(),
          now() + interval '1 hour',
          'scope-mismatch-command',
          'consumer-api-key',
          '${apiKeyA}'
        )
      `),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("completes failed and rejected attempts with SQL NULL results", async () => {
    const failedCommand = "00000000-0000-4000-8000-000000000052";
    const rejectedCommand = "00000000-0000-4000-8000-000000000053";
    const invalidDelayCommand = "00000000-0000-4000-8000-000000000054";
    await database.exec(`
      INSERT INTO commands (
        id, tenant_id, connector_id, required_scope, payload,
        not_before, expires_at, idempotency_key, created_by_kind, created_by_id,
        created_at, updated_at
      ) VALUES
        (
          '${failedCommand}', '${tenantA}', '${connectorA}', 'anytype.objects.read',
          '{"domain":"anytype","operation":{"type":"object.read"}}',
          '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z',
          'failed-completion-command', 'consumer-api-key', '${apiKeyA}',
          '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
        ),
        (
          '${rejectedCommand}', '${tenantA}', '${connectorA}', 'anytype.objects.read',
          '{"domain":"anytype","operation":{"type":"object.read"}}',
          '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z',
          'rejected-completion-command', 'consumer-api-key', '${apiKeyA}',
          '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
        ),
        (
          '${invalidDelayCommand}', '${tenantA}', '${connectorA}', 'anytype.objects.read',
          '{"domain":"anytype","operation":{"type":"object.read"}}',
          '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z',
          'invalid-delay-command', 'consumer-api-key', '${apiKeyA}',
          '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
        );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);

    const failedDigest = "d".repeat(64);
    const rejectedDigest = "e".repeat(64);
    const invalidDelayDigest = "f".repeat(64);
    await database.query(
      "SELECT * FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.read}",
        "2026-09-01T00:00:03Z",
        failedDigest,
        30,
      ],
    );
    const failed = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, 1, $4, $5, 'failed', NULL, 'temporary-read-failure', true, 30
      )`,
      [
        tenantA,
        connectorA,
        failedCommand,
        "2026-09-01T00:00:04Z",
        failedDigest,
      ],
    );
    expect(failed.rows).toEqual([
      { completion_status: "accepted", command_state: "pending" },
    ]);

    await database.query(
      "SELECT * FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.read}",
        "2026-09-01T00:00:05Z",
        rejectedDigest,
        30,
      ],
    );
    const rejected = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, 1, $4, $5,
        'rejected-by-local-policy', NULL, 'operator-approval-required', false, 0
      )`,
      [
        tenantA,
        connectorA,
        rejectedCommand,
        "2026-09-01T00:00:06Z",
        rejectedDigest,
      ],
    );
    expect(rejected.rows).toEqual([
      {
        completion_status: "accepted",
        command_state: "rejected-by-local-policy",
      },
    ]);

    await database.query(
      "SELECT * FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.read}",
        "2026-09-01T00:00:07Z",
        invalidDelayDigest,
        30,
      ],
    );
    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, 1, $4, $5, 'failed', NULL, 'temporary-read-failure', true, NULL
        )`,
        [
          tenantA,
          connectorA,
          invalidDelayCommand,
          "2026-09-01T00:00:08Z",
          invalidDelayDigest,
        ],
      ),
    ).rejects.toThrow("Retry delay is out of range");

    const persisted = await database.query<{
      id: string;
      state: string;
      result: unknown;
      error_code: string | null;
    }>(
      `SELECT id, state, result, error_code
       FROM commands
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [failedCommand, rejectedCommand],
    );
    expect(persisted.rows).toEqual([
      {
        id: failedCommand,
        state: "pending",
        result: null,
        error_code: "temporary-read-failure",
      },
      {
        id: rejectedCommand,
        state: "rejected-by-local-policy",
        result: null,
        error_code: "operator-approval-required",
      },
    ]);
  });

  it("fences stale command results and records every claimed attempt", async () => {
    const command = "00000000-0000-4000-8000-000000000051";
    const firstDigest = "a".repeat(64);
    const secondDigest = "b".repeat(64);
    await database.exec(`
      INSERT INTO commands (
        id,
        tenant_id,
        connector_id,
        required_scope,
        payload,
        not_before,
        expires_at,
        idempotency_key,
        created_by_kind,
        created_by_id,
        created_at,
        updated_at
      ) VALUES (
        '${command}',
        '${tenantA}',
        '${connectorA}',
        'anytype.objects.read',
        '{"domain":"anytype","operation":{"type":"object.read"}}',
        '2026-09-01T00:00:00Z',
        '2026-09-01T01:00:00Z',
        'command-idempotency-key',
        'consumer-api-key',
        '${apiKeyA}',
        '2026-09-01T00:00:00Z',
        '2026-09-01T00:00:00Z'
      );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);

    const deniedScope = await database.query(
      "SELECT * FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.write}",
        "2026-09-01T00:00:01Z",
        "c".repeat(64),
        30,
      ],
    );
    expect(deniedScope.rows).toEqual([]);

    const firstClaim = await database.query<{
      attempt: number;
      lease_expires_at: Date;
    }>(
      "SELECT attempt, lease_expires_at FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.read}",
        "2026-09-01T00:00:01Z",
        firstDigest,
        30,
      ],
    );
    expect(firstClaim.rows).toHaveLength(1);
    expect(firstClaim.rows[0]?.attempt).toBe(1);

    const whileLeased = await database.query(
      "SELECT * FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.read}",
        "2026-09-01T00:00:02Z",
        secondDigest,
        30,
      ],
    );
    expect(whileLeased.rows).toEqual([]);

    const wrongExtension = await database.query<{ expires_at: Date | null }>(
      "SELECT extend_command_lease($1, $2, $3, $4, $5, $6, $7) AS expires_at",
      [
        tenantA,
        connectorA,
        command,
        1,
        "2026-09-01T00:00:03Z",
        secondDigest,
        60,
      ],
    );
    expect(wrongExtension.rows).toEqual([{ expires_at: null }]);

    const shorterExtension = await database.query<{ expires_at: Date | null }>(
      "SELECT extend_command_lease($1, $2, $3, $4, $5, $6, $7) AS expires_at",
      [
        tenantA,
        connectorA,
        command,
        1,
        "2026-09-01T00:00:03Z",
        firstDigest,
        15,
      ],
    );
    expect(shorterExtension.rows[0]?.expires_at).toEqual(
      new Date("2026-09-01T00:00:31.000Z"),
    );

    const secondClaim = await database.query<{ attempt: number }>(
      "SELECT attempt FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.read}",
        "2026-09-01T00:00:32Z",
        secondDigest,
        30,
      ],
    );
    expect(secondClaim.rows).toEqual([{ attempt: 2 }]);

    const staleResult = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, $4, $5, $6, 'succeeded',
        '{"type":"object.read","stale":true}', NULL, false, 0
      )`,
      [tenantA, connectorA, command, 1, "2026-09-01T00:00:33Z", firstDigest],
    );
    expect(staleResult.rows).toEqual([
      { completion_status: "stale", command_state: "leased" },
    ]);

    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, $4, $5, $6, 'succeeded',
          '{"type":"object.read","crossTenant":true}', NULL, false, 0
        )`,
        [tenantB, connectorA, command, 2, "2026-09-01T00:00:33Z", secondDigest],
      ),
    ).rejects.toThrow(
      "Command completion tenant does not match the active tenant",
    );

    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, $4, $5, $6, 'succeeded',
          jsonb_build_object('type', 'object.read', 'data', repeat('x', 1048576)),
          NULL, false, 0
        )`,
        [tenantA, connectorA, command, 2, "2026-09-01T00:00:33Z", secondDigest],
      ),
    ).rejects.toMatchObject({
      code: "22023",
      message: expect.stringContaining("Command result exceeds the size limit"),
    });

    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, $4, $5, $6, 'succeeded',
          '{"type":"object.update"}', NULL, false, 0
        )`,
        [tenantA, connectorA, command, 2, "2026-09-01T00:00:33Z", secondDigest],
      ),
    ).rejects.toMatchObject({
      code: "22023",
      message: expect.stringContaining(
        "Command result type does not match the leased operation",
      ),
    });

    const acceptedResult = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, $4, $5, $6, 'succeeded',
        '{"type":"object.read","ok":true}', NULL, false, 0
      )`,
      [tenantA, connectorA, command, 2, "2026-09-01T00:00:34Z", secondDigest],
    );
    expect(acceptedResult.rows).toEqual([
      { completion_status: "accepted", command_state: "succeeded" },
    ]);

    const duplicateResult = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, $4, $5, $6, 'succeeded',
        '{"type":"object.read","ok":true}', NULL, false, 0
      )`,
      [tenantA, connectorA, command, 2, "2026-09-01T00:00:35Z", secondDigest],
    );
    expect(duplicateResult.rows).toEqual([
      { completion_status: "duplicate", command_state: "succeeded" },
    ]);

    const attempts = await database.query<{
      attempt: number;
      outcome: string | null;
    }>(
      `SELECT attempt, outcome
       FROM command_attempts
       WHERE tenant_id = $1 AND command_id = $2
       ORDER BY attempt`,
      [tenantA, command],
    );
    expect(attempts.rows).toEqual([
      { attempt: 1, outcome: null },
      { attempt: 2, outcome: "succeeded" },
    ]);
  });

  it("creates one default owner workspace for repeated first requests", async () => {
    await database.exec(`
      INSERT INTO auth."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        '${authUserA}', 'Workspace owner', 'owner@example.test', true, now(), now()
      );
      INSERT INTO auth.session (
        id, "expiresAt", token, "createdAt", "updatedAt", "userId"
      ) VALUES
        ('${authSessionA}', now() + interval '1 hour', 'workspace-token-a', now(), now(), '${authUserA}'),
        ('${authSessionB}', now() + interval '1 hour', 'workspace-token-b', now(), now(), '${authUserA}');
      SET ROLE knot_app;
    `);

    const [first, repeated, secondSession] = await Promise.all([
      resolveWorkspace(database, authSessionA),
      resolveWorkspace(database, authSessionA),
      resolveWorkspace(database, authSessionB),
    ]);

    expect(first.rows).toHaveLength(1);
    expect(repeated.rows).toEqual(first.rows);
    expect(secondSession.rows).toEqual(first.rows);
    expect(first.rows[0]).toMatchObject({
      member_role: "owner",
      tenant_name: "Personal workspace",
    });

    await database.exec("RESET ROLE");
    const counts = await database.query<{
      projected_users: number;
      owned_workspaces: number;
      defaults: number;
      selections: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM users WHERE auth_user_id = '${authUserA}') AS projected_users,
        (SELECT count(*)::int FROM tenant_members
         WHERE user_id = '${first.rows[0]?.user_id}' AND role = 'owner') AS owned_workspaces,
        (SELECT count(*)::int FROM tenant_members
         WHERE user_id = '${first.rows[0]?.user_id}' AND is_default) AS defaults,
        (SELECT count(*)::int FROM session_tenant_selections
         WHERE auth_user_id = '${authUserA}') AS selections
    `);
    expect(counts.rows).toEqual([
      {
        projected_users: 1,
        owned_workspaces: 1,
        defaults: 1,
        selections: 2,
      },
    ]);

    const functionBody = await database.query<{ source: string }>(`
      SELECT prosrc AS source FROM pg_proc
      WHERE oid = 'resolve_or_bootstrap_workspace(text,text,text,smallint,text)'::regprocedure
    `);
    expect(functionBody.rows[0]?.source).toContain("pg_advisory_xact_lock");
  });

  it("binds workspace selection to the verified session and membership", async () => {
    await database.exec(`
      INSERT INTO auth."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        '${authUserA}', 'Workspace owner', 'owner@example.test', true, now(), now()
      );
      INSERT INTO auth.session (
        id, "expiresAt", token, "createdAt", "updatedAt", "userId"
      ) VALUES
        ('${authSessionA}', now() + interval '1 hour', 'workspace-token-a', now(), now(), '${authUserA}'),
        ('${authSessionB}', now() + interval '1 hour', 'workspace-token-b', now(), now(), '${authUserA}');
      SET ROLE knot_app;
    `);
    const defaultWorkspace = await resolveWorkspace(database, authSessionA);
    await resolveWorkspace(database, authSessionB);
    const projectedUserId = defaultWorkspace.rows[0]?.user_id;

    await database.exec(`
      RESET ROLE;
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES ('${tenantA}', '${projectedUserId}', 'member');
      SET ROLE knot_app;
    `);
    const selected = await database.query<WorkspaceRow>(
      `SELECT * FROM select_workspace_for_session($1, $2, $3)`,
      [authSessionA, authUserA, tenantA],
    );
    expect(selected.rows).toEqual([
      {
        member_role: "member",
        suspended_at: null,
        tenant_id: tenantA,
        tenant_name: "Tenant A",
        user_id: projectedUserId,
      },
    ]);

    const wrongUser = await database.query<WorkspaceRow>(
      `SELECT * FROM select_workspace_for_session($1, $2, $3)`,
      [authSessionA, "different-auth-user", tenantA],
    );
    expect(wrongUser.rows).toEqual([]);

    await database.exec(`
      RESET ROLE;
      UPDATE auth."user" SET "emailVerified" = false WHERE id = '${authUserA}';
      SET ROLE knot_app;
    `);
    const unverified = await database.query<WorkspaceRow>(
      `SELECT * FROM select_workspace_for_session($1, $2, $3)`,
      [authSessionA, authUserA, tenantA],
    );
    expect(unverified.rows).toEqual([]);

    await database.exec("RESET ROLE");
    const selections = await database.query<{
      auth_session_id: string;
      tenant_id: string;
    }>(`
      SELECT auth_session_id, tenant_id
      FROM session_tenant_selections
      WHERE auth_user_id = '${authUserA}'
      ORDER BY auth_session_id
    `);
    expect(selections.rows).toEqual([
      { auth_session_id: authSessionA, tenant_id: tenantA },
      {
        auth_session_id: authSessionB,
        tenant_id: defaultWorkspace.rows[0]?.tenant_id,
      },
    ]);
  });

  it("promotes an existing membership to the default workspace", async () => {
    const projectedUser = "00000000-0000-4000-8000-000000000072";
    await database.exec(`
      INSERT INTO auth."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        '${authUserA}', 'Workspace owner', 'owner@example.test', true, now(), now()
      );
      INSERT INTO auth.session (
        id, "expiresAt", token, "createdAt", "updatedAt", "userId"
      ) VALUES (
        '${authSessionA}', now() + interval '1 hour', 'workspace-token-a',
        now(), now(), '${authUserA}'
      );
      INSERT INTO users (
        id, auth_user_id, email_digest, email_digest_version
      ) VALUES (
        '${projectedUser}', '${authUserA}', '${"2".repeat(64)}', 1
      );
      INSERT INTO tenant_members (tenant_id, user_id, role, is_default)
      VALUES ('${tenantA}', '${projectedUser}', 'member', false);
      SET ROLE knot_app;
    `);

    const workspace = await resolveWorkspace(database, authSessionA);
    expect(workspace.rows).toEqual([
      {
        member_role: "member",
        suspended_at: null,
        tenant_id: tenantA,
        tenant_name: "Tenant A",
        user_id: projectedUser,
      },
    ]);

    await database.exec("RESET ROLE");
    const membership = await database.query<{ is_default: boolean }>(`
      SELECT is_default FROM tenant_members
      WHERE tenant_id = '${tenantA}' AND user_id = '${projectedUser}'
    `);
    expect(membership.rows).toEqual([{ is_default: true }]);
  });

  it("skips suspended selections and memberships during workspace resolution", async () => {
    const projectedUser = "00000000-0000-4000-8000-000000000073";
    await database.exec(`
      INSERT INTO auth."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        '${authUserA}', 'Workspace owner', 'owner@example.test', true, now(), now()
      );
      INSERT INTO auth.session (
        id, "expiresAt", token, "createdAt", "updatedAt", "userId"
      ) VALUES (
        '${authSessionA}', now() + interval '1 hour', 'workspace-token-a',
        now(), now(), '${authUserA}'
      );
      INSERT INTO users (id, auth_user_id, email_digest, email_digest_version)
      VALUES ('${projectedUser}', '${authUserA}', '${"2".repeat(64)}', 1);
      UPDATE tenants SET suspended_at = now() WHERE id = '${tenantA}';
      INSERT INTO tenant_members (tenant_id, user_id, role, is_default)
      VALUES ('${tenantA}', '${projectedUser}', 'owner', true);
      INSERT INTO session_tenant_selections (
        auth_session_id, auth_user_id, user_id, tenant_id
      ) VALUES (
        '${authSessionA}', '${authUserA}', '${projectedUser}', '${tenantA}'
      );
      SET ROLE knot_app;
    `);

    const workspace = await resolveWorkspace(database, authSessionA);
    expect(workspace.rows).toHaveLength(1);
    expect(workspace.rows[0]).toMatchObject({
      member_role: "owner",
      suspended_at: null,
      tenant_name: "Personal workspace",
      user_id: projectedUser,
    });
    expect(workspace.rows[0]?.tenant_id).not.toBe(tenantA);
  });

  it("enforces case-insensitive uniqueness for Better Auth email addresses", async () => {
    await database.exec(`
      INSERT INTO auth."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        'auth-case-a', 'Case A', 'raj@example.test', true, now(), now()
      )
    `);
    await expect(
      database.exec(`
        INSERT INTO auth."user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          'auth-case-b', 'Case B', 'RAJ@EXAMPLE.TEST', true, now(), now()
        )
      `),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("claims an existing keyed identity projection instead of creating a second user", async () => {
    const projectedUser = "00000000-0000-4000-8000-000000000071";
    await database.exec(`
      INSERT INTO users (id, email_digest, email_digest_version)
      VALUES ('${projectedUser}', '${"2".repeat(64)}', 1);
      INSERT INTO auth."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) VALUES (
        '${authUserA}', 'Workspace owner', 'owner@example.test', true, now(), now()
      );
      INSERT INTO auth.session (
        id, "expiresAt", token, "createdAt", "updatedAt", "userId"
      ) VALUES (
        '${authSessionA}', now() + interval '1 hour', 'workspace-token-a',
        now(), now(), '${authUserA}'
      );
      SET ROLE knot_app;
    `);

    const workspace = await resolveWorkspace(database, authSessionA, 7);
    expect(workspace.rows[0]?.user_id).toBe(projectedUser);

    await database.exec("RESET ROLE");
    const projection = await database.query<{
      auth_user_id: string;
      claimed: boolean;
      digest_version: number;
      user_count: number;
    }>(`
      SELECT max(auth_user_id) AS auth_user_id,
        bool_and(claimed_at IS NOT NULL) AS claimed,
        max(email_digest_version)::int AS digest_version,
        count(*)::int AS user_count
      FROM users WHERE email_digest = '${"2".repeat(64)}'
    `);
    expect(projection.rows).toEqual([
      {
        auth_user_id: authUserA,
        claimed: true,
        digest_version: 7,
        user_count: 1,
      },
    ]);
    const audit = await database.query<{
      actor_digest: string;
      actor_digest_version: number;
      count: number;
    }>(`
      SELECT max(actor_digest) AS actor_digest,
        max(actor_digest_version)::int AS actor_digest_version,
        count(*)::int AS count FROM audit_events
      WHERE tenant_id = '${workspace.rows[0]?.tenant_id}'
        AND action = 'identity.legacy-claim'
        AND target_id = '${projectedUser}'
        AND metadata = '{"digestVersion": 7}'::jsonb
    `);
    expect(audit.rows).toEqual([
      {
        actor_digest: "2".repeat(64),
        actor_digest_version: 7,
        count: 1,
      },
    ]);
  });

  it("removes the duplicate session authority and protects workspace projections", async () => {
    const schema = await database.query<{
      legacy_sessions: string | null;
      legacy_resolver: string | null;
      legacy_tenant_lookup: string | null;
      app_reads_users: boolean;
      app_reads_selections: boolean;
      bootstrap_creates_schema_objects: boolean;
      bootstrap_has_membership: boolean;
    }>(`
      SELECT
        to_regclass('public.sessions')::text AS legacy_sessions,
        to_regprocedure('resolve_session(text)')::text AS legacy_resolver,
        to_regprocedure('tenant_ids_for_user(uuid)')::text AS legacy_tenant_lookup,
        has_table_privilege('knot_app', 'users', 'SELECT') AS app_reads_users,
        has_table_privilege('knot_app', 'session_tenant_selections', 'SELECT') AS app_reads_selections,
        has_schema_privilege('knot_bootstrap', 'public', 'CREATE') AS bootstrap_creates_schema_objects,
        EXISTS (
          SELECT 1 FROM pg_auth_members
          JOIN pg_roles ON pg_roles.oid = pg_auth_members.member
          WHERE pg_roles.rolname = 'knot_bootstrap'
        ) AS bootstrap_has_membership
    `);
    expect(schema.rows).toEqual([
      {
        app_reads_selections: false,
        app_reads_users: false,
        bootstrap_creates_schema_objects: false,
        bootstrap_has_membership: false,
        legacy_resolver: null,
        legacy_sessions: null,
        legacy_tenant_lookup: null,
      },
    ]);
  });
});

interface WorkspaceRow {
  user_id: string;
  tenant_id: string;
  tenant_name: string;
  member_role: string;
  suspended_at: string | null;
}

function resolveWorkspace(database: PGlite, sessionId: string, version = 1) {
  return database.query<WorkspaceRow>(
    `SELECT * FROM resolve_or_bootstrap_workspace($1, $2, $3, $4::smallint, $5)`,
    [sessionId, authUserA, "2".repeat(64), version, "Personal workspace"],
  );
}
