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
      "SELECT extend_command_lease($1, $2, $3, $4, $5, $6) AS expires_at",
      [tenantA, command, 1, "2026-09-01T00:00:03Z", secondDigest, 60],
    );
    expect(wrongExtension.rows).toEqual([{ expires_at: null }]);

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
        $1, $2, $3, $4, $5, 'succeeded',
        '{"type":"object.read","stale":true}', NULL, false, 0
      )`,
      [tenantA, command, 1, "2026-09-01T00:00:33Z", firstDigest],
    );
    expect(staleResult.rows).toEqual([
      { completion_status: "stale", command_state: "leased" },
    ]);

    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, $4, $5, 'succeeded',
          '{"type":"object.read","crossTenant":true}', NULL, false, 0
        )`,
        [tenantB, command, 2, "2026-09-01T00:00:33Z", secondDigest],
      ),
    ).rejects.toThrow(
      "Command completion tenant does not match the active tenant",
    );

    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, $4, $5, 'succeeded',
          '{"type":"object.update"}', NULL, false, 0
        )`,
        [tenantA, command, 2, "2026-09-01T00:00:33Z", secondDigest],
      ),
    ).rejects.toThrow(
      "Command result type does not match the leased operation",
    );

    const acceptedResult = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, $4, $5, 'succeeded',
        '{"type":"object.read","ok":true}', NULL, false, 0
      )`,
      [tenantA, command, 2, "2026-09-01T00:00:34Z", secondDigest],
    );
    expect(acceptedResult.rows).toEqual([
      { completion_status: "accepted", command_state: "succeeded" },
    ]);

    const duplicateResult = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, $4, $5, 'succeeded',
        '{"type":"object.read","ok":true}', NULL, false, 0
      )`,
      [tenantA, command, 2, "2026-09-01T00:00:35Z", secondDigest],
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
      { attempt: 1, outcome: "succeeded" },
      { attempt: 2, outcome: "succeeded" },
    ]);
  });
});
