import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";
const connectorA = "00000000-0000-4000-8000-000000000011";
const connectorB = "00000000-0000-4000-8000-000000000012";
const connectorSameTenant = "00000000-0000-4000-8000-000000000013";
const apiKeyA = "00000000-0000-4000-8000-000000000021";
const apiKeyB = "00000000-0000-4000-8000-000000000022";
const authUserA = "auth-user-workspace-a";
const authSessionA = "auth-session-workspace-a";
const authSessionB = "auth-session-workspace-b";
const pairingActor = "00000000-0000-4000-8000-000000000081";
const pairingA = "00000000-0000-4000-8000-000000000091";
const pairingB = "00000000-0000-4000-8000-000000000092";
const pairingC = "00000000-0000-4000-8000-000000000093";
const migrationDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

describe("migration inventory", () => {
  it("grandfathers the shipped 0001 pair and keeps later prefixes unique", async () => {
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => /^\d+.*\.sql$/u.test(name))
      .sort();
    expect(
      migrationFiles.every((name) => /^\d{4}[a-z]?_.+\.sql$/u.test(name)),
    ).toBe(true);
    expect(migrationFiles.filter((name) => name.startsWith("0001_"))).toEqual([
      "0001_active_asset_uniqueness.sql",
      "0001_command_ledger.sql",
    ]);
    const laterOrderingKeys = migrationFiles
      .filter((name) => Number(name.slice(0, 4)) >= 2)
      .map((name) => name.slice(0, name.indexOf("_")));
    expect(new Set(laterOrderingKeys).size).toBe(laterOrderingKeys.length);
  });
});

describe("migration plan", () => {
  it("orders the public reader after 0009 and before the future 0010 migration", async () => {
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => /^\d+.*\.sql$/u.test(name))
      .sort();

    expect(migrationFiles).toContain("0009_publication_lifecycle.sql");
    expect(migrationFiles).toContain("0009a_public_reader.sql");
    expect(
      [
        "0010_scoped_data_api.sql",
        "0009a_public_reader.sql",
        "0009_publication_lifecycle.sql",
      ].sort(),
    ).toEqual([
      "0009_publication_lifecycle.sql",
      "0009a_public_reader.sql",
      "0010_scoped_data_api.sql",
    ]);
  });

  it("backfills a non-authorizing actor sentinel for pre-0010 commands", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE ROLE knot_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS;
        GRANT CREATE ON DATABASE postgres TO knot_migrator;
        ALTER SCHEMA public OWNER TO knot_migrator;
        GRANT knot_migrator TO CURRENT_USER;
        SET ROLE knot_migrator;
        CREATE TABLE schema_migrations (
          name text PRIMARY KEY,
          sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const migrationFiles = (await readdir(migrationDirectory))
        .filter((name) => /^\d+.*\.sql$/u.test(name))
        .sort();
      for (const migrationFile of migrationFiles.filter(
        (name) => name < "0010_scoped_data_api.sql",
      )) {
        await database.exec(
          await readFile(path.join(migrationDirectory, migrationFile), "utf8"),
        );
      }
      await database.exec(`
        RESET ROLE;
        INSERT INTO tenants (id, name) VALUES ('${tenantA}', 'Tenant A');
        INSERT INTO connectors (
          id, tenant_id, name, protocol_version, public_key, scopes
        ) VALUES (
          '${connectorA}', '${tenantA}', 'A', '1.0',
          decode(repeat('00', 32), 'hex'), '{anytype.objects.read}'
        );
        INSERT INTO commands (
          tenant_id, connector_id, required_scope, payload, not_before,
          expires_at, idempotency_key, created_by_kind, created_by_id
        ) VALUES (
          '${tenantA}', '${connectorA}', 'anytype.objects.read',
          '{"domain":"anytype","operation":{"type":"object.read"}}',
          now(), now() + interval '1 hour', 'pre-0010-command',
          'first-party-service', '00000000-0000-4000-8000-000000000099'
        );
        SET ROLE knot_migrator;
      `);
      await database.exec(
        await readFile(
          path.join(migrationDirectory, "0010_scoped_data_api.sql"),
          "utf8",
        ),
      );
      await database.exec("RESET ROLE");
      const actor = await database.query<{
        actor_digest: string;
        actor_digest_version: number;
        actor_provenance: string;
      }>(`
        SELECT actor_digest, actor_digest_version::int AS actor_digest_version,
          actor_provenance
        FROM commands WHERE idempotency_key = 'pre-0010-command'
      `);
      expect(actor.rows).toEqual([
        {
          actor_digest: "0".repeat(64),
          actor_digest_version: 1,
          actor_provenance: "unverified-legacy",
        },
      ]);
    } finally {
      await database.close();
    }
  });
});

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
        ('${connectorB}', '${tenantB}', 'B', '1.0', decode(repeat('00', 32), 'hex'), '{}'),
        ('${connectorSameTenant}', '${tenantA}', 'A2', '1.0', decode(repeat('02', 32), 'hex'), '{}');
      INSERT INTO api_keys (
        id, tenant_id, name, key_id, key_digest, scopes
      ) VALUES
        ('${apiKeyA}', '${tenantA}', 'A key', 'abcdefghijklmnop', repeat('0', 64), '{}'),
        ('${apiKeyB}', '${tenantB}', 'B key', 'bcdefghijklmnopq', repeat('1', 64), '{}');
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  it("preserves the shipped command migration and upgrades signatures additively", async () => {
    const migrationDirectory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "migrations",
    );
    const shippedCommandMigration = await readFile(
      path.join(migrationDirectory, "0001_command_ledger.sql"),
    );
    expect(
      createHash("sha256").update(shippedCommandMigration).digest("hex"),
    ).toBe("5f2d4b00df78c17bdf7e0115eb111c9b6f076f871dbd6f2ed7ae91c4f1a44546");

    const signatures = await database.query<{
      old_extend: string | null;
      new_extend: string | null;
      old_complete: string | null;
      new_complete: string | null;
      scope_constraint: string | null;
    }>(`
      SELECT
        to_regprocedure(
          'extend_command_lease(uuid,uuid,integer,timestamptz,text,integer)'
        )::text AS old_extend,
        to_regprocedure(
          'extend_command_lease(uuid,uuid,uuid,integer,timestamptz,text,integer)'
        )::text AS new_extend,
        to_regprocedure(
          'complete_command(uuid,uuid,integer,timestamptz,text,command_state,jsonb,text,boolean,integer)'
        )::text AS old_complete,
        to_regprocedure(
          'complete_command(uuid,uuid,uuid,integer,timestamptz,text,command_state,jsonb,text,boolean,integer)'
        )::text AS new_complete,
        (
          SELECT constraint_name
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'commands'
            AND constraint_name = 'commands_required_scope_matches_payload'
        ) AS scope_constraint
    `);
    expect(signatures.rows).toEqual([
      {
        old_extend: null,
        new_extend:
          "extend_command_lease(uuid,uuid,uuid,integer,timestamp with time zone,text,integer)",
        old_complete: null,
        new_complete:
          "complete_command(uuid,uuid,uuid,integer,timestamp with time zone,text,command_state,jsonb,text,boolean,integer)",
        scope_constraint: "commands_required_scope_matches_payload",
      },
    ]);
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

  it("keeps audit pagination tenant-isolated and indexed", async () => {
    await database.exec(`
      INSERT INTO audit_events (
        tenant_id, principal_kind, action, target_kind, outcome, created_at
      ) VALUES
        ('${tenantA}', 'human-session', 'connector.rename', 'connector', 'succeeded', '2026-09-02T12:00:00Z'),
        ('${tenantB}', 'human-session', 'api-key.create', 'api-key', 'succeeded', '2026-09-02T12:01:00Z');
      SET ROLE knot_app;
    `);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [
      tenantA,
    ]);
    const visible = await database.query<{ action: string }>(
      "SELECT action FROM audit_events ORDER BY created_at DESC, id DESC",
    );
    expect(visible.rows).toEqual([{ action: "connector.rename" }]);

    await database.exec("RESET ROLE");
    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'audit_events'
        AND indexname IN (
          'audit_events_tenant_cursor_idx',
          'audit_events_tenant_action_created_idx',
          'audit_events_tenant_outcome_created_idx'
        )
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "audit_events_tenant_action_created_idx",
      "audit_events_tenant_cursor_idx",
      "audit_events_tenant_outcome_created_idx",
    ]);
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

  it("revokes resolver DDL and enforces command-attempt tenant policies", async () => {
    const privileges = await database.query<{
      can_create: boolean;
      row_security: boolean;
      forced_row_security: boolean;
      policies: string[];
    }>(`
      SELECT
        has_schema_privilege('knot_resolver', 'public', 'CREATE') AS can_create,
        relation.relrowsecurity AS row_security,
        relation.relforcerowsecurity AS forced_row_security,
        ARRAY(
          SELECT policy.polname
          FROM pg_policy AS policy
          WHERE policy.polrelid = relation.oid
          ORDER BY policy.polname
        ) AS policies
      FROM pg_class AS relation
      WHERE relation.oid = 'command_attempts'::regclass
    `);
    expect(privileges.rows).toEqual([
      {
        can_create: false,
        row_security: true,
        forced_row_security: true,
        policies: ["tenant_insert", "tenant_select", "tenant_update"],
      },
    ]);

    const commandA = "00000000-0000-4000-8000-000000000061";
    const commandB = "00000000-0000-4000-8000-000000000062";
    await database.exec(`
      INSERT INTO commands (
        id, tenant_id, connector_id, required_scope, payload, not_before,
        expires_at, idempotency_key, created_by_kind, created_by_id
      ) VALUES
        (
          '${commandA}', '${tenantA}', '${connectorA}', 'anytype.objects.read',
          '{"domain":"anytype","operation":{"type":"object.read"}}', now(),
          now() + interval '1 hour', 'resolver-attempt-a', 'consumer-api-key', '${apiKeyA}'
        ),
        (
          '${commandB}', '${tenantB}', '${connectorB}', 'anytype.objects.read',
          '{"domain":"anytype","operation":{"type":"object.read"}}', now(),
          now() + interval '1 hour', 'resolver-attempt-b', 'consumer-api-key', '${apiKeyB}'
        );
      INSERT INTO command_attempts (
        tenant_id, command_id, attempt, lease_token_digest, claimed_at
      ) VALUES
        ('${tenantA}', '${commandA}', 1, '${"a".repeat(64)}', now()),
        ('${tenantB}', '${commandB}', 1, '${"b".repeat(64)}', now());
      SET ROLE knot_resolver;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    const visible = await database.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM command_attempts ORDER BY tenant_id",
    );
    expect(visible.rows).toEqual([{ tenant_id: tenantA }]);
    const crossTenantUpdate = await database.query(
      `UPDATE command_attempts SET error_code = 'escape'
       WHERE tenant_id = $1 RETURNING tenant_id`,
      [tenantB],
    );
    expect(crossTenantUpdate.rows).toEqual([]);
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

  it("makes actor provenance non-null and binds the legacy sentinel", async () => {
    const command = "00000000-0000-4000-8000-000000000063";
    await database.exec(`
      INSERT INTO commands (
        id, tenant_id, connector_id, required_scope, payload, not_before,
        expires_at, idempotency_key, created_by_kind, created_by_id
      ) VALUES (
        '${command}', '${tenantA}', '${connectorA}', 'anytype.objects.read',
        '{"domain":"anytype","operation":{"type":"object.read"}}', now(),
        now() + interval '1 hour', 'legacy-default-command',
        'first-party-service', '00000000-0000-4000-8000-000000000099'
      )
    `);
    const actor = await database.query<{
      actor_digest: string;
      actor_digest_version: number;
      actor_provenance: string;
    }>(`
      SELECT actor_digest, actor_digest_version::int AS actor_digest_version,
        actor_provenance FROM commands WHERE id = '${command}'
    `);
    expect(actor.rows).toEqual([
      {
        actor_digest: "0".repeat(64),
        actor_digest_version: 1,
        actor_provenance: "unverified-legacy",
      },
    ]);
    await expect(
      database.exec(`
        UPDATE commands SET actor_provenance = 'first-party-service'
        WHERE id = '${command}'
      `),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.exec(`
        UPDATE commands SET actor_digest = NULL, actor_digest_version = NULL,
          actor_provenance = NULL WHERE id = '${command}'
      `),
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("enqueues consumer operations with tenant, scope, connector, idempotency, and quota fences", async () => {
    await database.exec(`
      UPDATE connectors
      SET scopes = '{anytype.objects.read}'
      WHERE id = '${connectorA}';
      UPDATE api_keys
      SET scopes = '{anytype.objects.read}', requests_per_minute = 2, requests_per_day = 10
      WHERE id = '${apiKeyA}';
      INSERT INTO api_key_connectors (tenant_id, api_key_id, connector_id)
      VALUES ('${tenantA}', '${apiKeyA}', '${connectorA}');
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    const operation = JSON.stringify({
      type: "object.read",
      spaceId: "space-1",
      objectId: "object-1",
    });
    const enqueue = (
      key: string,
      requestDigest: string,
      scope = "anytype.objects.read",
    ) =>
      database.query<{
        command_id: string;
        command_state: string;
        was_created: boolean;
      }>(
        `SELECT * FROM enqueue_consumer_operation(
          $1::uuid, $2::uuid, $3::uuid, $4::scope_name, $5::jsonb, $6::text, $7::text,
          clock_timestamp(), clock_timestamp() + interval '10 minutes', $8::text, 1::smallint
        )`,
        [
          tenantA,
          apiKeyA,
          connectorA,
          scope,
          operation,
          key,
          requestDigest,
          "a".repeat(64),
        ],
      );

    const first = await enqueue("consumer-operation-0001", "b".repeat(64));
    expect(first.rows).toEqual([
      expect.objectContaining({ command_state: "pending", was_created: true }),
    ]);
    const repeated = await enqueue("consumer-operation-0001", "b".repeat(64));
    expect(repeated.rows).toEqual([
      {
        command_id: first.rows[0]!.command_id,
        command_state: "pending",
        was_created: false,
      },
    ]);
    await expect(
      enqueue("consumer-operation-0001", "c".repeat(64)),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      enqueue("consumer-operation-0002", "d".repeat(64)),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ was_created: true })],
    });
    await expect(
      enqueue("consumer-operation-0004", "f".repeat(64)),
    ).rejects.toThrow("API key quota exceeded");
    await expect(
      enqueue(
        "consumer-operation-0003",
        "e".repeat(64),
        "anytype.objects.write",
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const audit = await database.query<{
      actor_digest: string;
      metadata: { connectorId: string; scope: string };
    }>(
      `SELECT actor_digest, metadata
       FROM audit_events
       WHERE tenant_id = $1 AND target_id = $2`,
      [tenantA, first.rows[0]!.command_id],
    );
    expect(audit.rows).toEqual([
      {
        actor_digest: "a".repeat(64),
        metadata: {
          connectorId: connectorA,
          scope: "anytype.objects.read",
        },
      },
    ]);

    const commandActor = await database.query<{
      actor_digest: string;
      actor_digest_version: number;
      actor_provenance: string;
    }>(
      `SELECT actor_digest, actor_digest_version::int AS actor_digest_version,
        actor_provenance
       FROM commands WHERE tenant_id = $1 AND id = $2`,
      [tenantA, first.rows[0]!.command_id],
    );
    expect(commandActor.rows).toEqual([
      {
        actor_digest: "a".repeat(64),
        actor_digest_version: 1,
        actor_provenance: "consumer-api-key",
      },
    ]);

    const usage = await database.query<{ request_count: number }>(
      `SELECT request_count::int AS request_count
       FROM api_key_usage_windows
       WHERE tenant_id = $1 AND api_key_id = $2 AND window_kind = 'minute'`,
      [tenantA, apiKeyA],
    );
    expect(usage.rows).toEqual([{ request_count: 2 }]);

    await database.query("SELECT set_config('app.tenant_id', $1, false)", [
      tenantB,
    ]);
    const hidden = await database.query<{ id: string }>(
      "SELECT id FROM commands WHERE id = $1",
      [first.rows[0]!.command_id],
    );
    expect(hidden.rows).toEqual([]);
  });

  it("creates, rotates, resolves, and revokes a connector-bound API key", async () => {
    await database.exec(`
      UPDATE connectors
      SET scopes = '{anytype.objects.read}'
      WHERE id = '${connectorA}';
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    const resolverAcl = await database.query<{
      app_executes: boolean;
      public_executes: boolean;
    }>(`
      SELECT
        has_function_privilege(
          'knot_app', 'resolve_consumer_api_key(text)', 'EXECUTE'
        ) AS app_executes,
        EXISTS (
          SELECT 1
          FROM pg_proc AS function
          CROSS JOIN LATERAL aclexplode(
            coalesce(function.proacl, acldefault('f', function.proowner))
          ) AS privilege
          WHERE function.oid = 'resolve_consumer_api_key(text)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS public_executes
    `);
    expect(resolverAcl.rows).toEqual([
      { app_executes: true, public_executes: false },
    ]);

    const created = await database.query<{ id: string }>(
      `SELECT create_consumer_api_key(
        $1::uuid, $2::uuid, 'Read integration', 'qrstuvwxyzABCDEF', $3::text,
        1::smallint, '{anytype.objects.read}'::scope_name[], $4::uuid[], NULL,
        30, 1000
      ) AS id`,
      [
        tenantA,
        "00000000-0000-4000-8000-000000000099",
        "1".repeat(64),
        `{${connectorA}}`,
      ],
    );
    const createdId = created.rows[0]!.id;
    await database.query("SELECT set_config('app.tenant_id', '', false)");
    const resolved = await database.query<{
      id: string;
      connector_ids: string[];
      requests_per_minute: number;
    }>(
      "SELECT id, connector_ids, requests_per_minute FROM resolve_consumer_api_key($1)",
      ["qrstuvwxyzABCDEF"],
    );
    expect(resolved.rows).toEqual([
      { id: createdId, connector_ids: [connectorA], requests_per_minute: 30 },
    ]);
    await database.query("SELECT set_config('app.tenant_id', $1, false)", [
      tenantA,
    ]);
    await database.query(
      "DELETE FROM api_key_connectors WHERE tenant_id = $1 AND api_key_id = $2",
      [tenantA, createdId],
    );
    const resolvedWithoutBindings = await database.query<{
      connector_ids: string[];
    }>("SELECT connector_ids FROM resolve_consumer_api_key($1)", [
      "qrstuvwxyzABCDEF",
    ]);
    expect(resolvedWithoutBindings.rows).toEqual([{ connector_ids: [] }]);
    await database.query(
      `INSERT INTO api_key_connectors (tenant_id, api_key_id, connector_id)
       VALUES ($1, $2, $3)`,
      [tenantA, createdId, connectorA],
    );

    await expect(
      database.query(
        `SELECT create_consumer_api_key(
          $1::uuid, $2::uuid, 'Cross tenant', 'ghijklmnopQRSTUV', $3::text,
          1::smallint, '{anytype.objects.read}'::scope_name[], $4::uuid[], NULL,
          30, 1000
        )`,
        [
          tenantA,
          "00000000-0000-4000-8000-000000000099",
          "2".repeat(64),
          `{${connectorB}}`,
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const rotated = await database.query<{ rotated: boolean }>(
      `SELECT rotate_consumer_api_key(
        $1::uuid, $2::uuid, $3::uuid, 'WXYZabcdefghijkl', $4::text, 2::smallint
      ) AS rotated`,
      [
        tenantA,
        "00000000-0000-4000-8000-000000000099",
        createdId,
        "3".repeat(64),
      ],
    );
    expect(rotated.rows).toEqual([{ rotated: true }]);
    expect(
      (
        await database.query<{ id: string }>(
          "SELECT id FROM resolve_consumer_api_key($1)",
          ["qrstuvwxyzABCDEF"],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await database.query<{ id: string }>(
          "SELECT id FROM resolve_consumer_api_key($1)",
          ["WXYZabcdefghijkl"],
        )
      ).rows,
    ).toEqual([{ id: createdId }]);

    const revoked = await database.query<{ revoked: boolean }>(
      "SELECT revoke_consumer_api_key($1::uuid, $2::uuid, $3::uuid) AS revoked",
      [tenantA, "00000000-0000-4000-8000-000000000099", createdId],
    );
    expect(revoked.rows).toEqual([{ revoked: true }]);
    expect(
      (
        await database.query<{ revoked_at: Date | null }>(
          "SELECT revoked_at FROM resolve_consumer_api_key($1)",
          ["WXYZabcdefghijkl"],
        )
      ).rows[0]!.revoked_at,
    ).toBeInstanceOf(Date);
  });

  it("completes failed and rejected attempts with SQL NULL results", async () => {
    const failedCommand = "00000000-0000-4000-8000-000000000052";
    const rejectedCommand = "00000000-0000-4000-8000-000000000053";
    const invalidDelayCommand = "00000000-0000-4000-8000-000000000054";
    const deadLetterCommand = "00000000-0000-4000-8000-000000000055";
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
    await database.exec(`
      INSERT INTO commands (
        id, tenant_id, connector_id, required_scope, payload,
        not_before, expires_at, max_attempts, idempotency_key,
        created_by_kind, created_by_id, created_at, updated_at
      ) VALUES (
        '${deadLetterCommand}', '${tenantA}', '${connectorA}', 'anytype.objects.read',
        '{"domain":"anytype","operation":{"type":"object.read"}}',
        '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z', 1,
        'dead-letter-completion-command', 'consumer-api-key', '${apiKeyA}',
        '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
      )
    `);

    const failedDigest = "d".repeat(64);
    const rejectedDigest = "e".repeat(64);
    const invalidDelayDigest = "f".repeat(64);
    const deadLetterDigest = "9".repeat(64);
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
    ).rejects.toMatchObject({
      code: "22023",
      message: expect.stringContaining("Retry delay is out of range"),
    });

    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, 1, $4, $5, NULL, NULL, NULL, false, 0
        )`,
        [
          tenantA,
          connectorA,
          invalidDelayCommand,
          "2026-09-01T00:00:08Z",
          invalidDelayDigest,
        ],
      ),
    ).rejects.toMatchObject({
      code: "22023",
      message: expect.stringContaining("Unsupported command outcome"),
    });

    await expect(
      database.query(
        `SELECT * FROM complete_command(
          $1, $2, $3, 1, $4, $5, 'failed', NULL,
          'temporary-read-failure', NULL, 30
        )`,
        [
          tenantA,
          connectorA,
          invalidDelayCommand,
          "2026-09-01T00:00:08Z",
          invalidDelayDigest,
        ],
      ),
    ).rejects.toMatchObject({
      code: "22023",
      message: expect.stringContaining("Retryable must be specified"),
    });

    await database.query(
      "SELECT * FROM claim_command($1, $2, $3, $4, $5, $6)",
      [
        tenantA,
        connectorA,
        "{anytype.objects.read}",
        "2026-09-01T00:00:09Z",
        deadLetterDigest,
        30,
      ],
    );
    const deadLettered = await database.query<{
      completion_status: string;
      command_state: string;
    }>(
      `SELECT * FROM complete_command(
        $1, $2, $3, 1, $4, $5, 'failed', NULL,
        'temporary-read-failure', true, 30
      )`,
      [
        tenantA,
        connectorA,
        deadLetterCommand,
        "2026-09-01T00:00:10Z",
        deadLetterDigest,
      ],
    );
    expect(deadLettered.rows).toEqual([
      { completion_status: "accepted", command_state: "dead-lettered" },
    ]);

    const persisted = await database.query<{
      id: string;
      state: string;
      result: unknown;
      error_code: string | null;
    }>(
      `SELECT id, state, result, error_code
       FROM commands
       WHERE id IN ($1, $2, $3)
       ORDER BY id`,
      [failedCommand, rejectedCommand, deadLetterCommand],
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
      {
        id: deadLetterCommand,
        state: "dead-lettered",
        result: null,
        error_code: "temporary-read-failure",
      },
    ]);
  });

  it("fences stale command results and records every claimed attempt", async () => {
    const commandLedger = await database.query<{ installed: boolean }>(`
      SELECT to_regprocedure(
        'claim_command(uuid,uuid,scope_name[],timestamptz,text,integer)'
      ) IS NOT NULL AS installed
    `);
    if (!commandLedger.rows[0]?.installed) return;
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

    const wrongConnectorResult = await database.query(
      `SELECT * FROM complete_command(
        $1, $2, $3, $4, $5, $6, 'succeeded',
        '{"type":"object.read","wrongConnector":true}', NULL, false, 0
      )`,
      [
        tenantA,
        connectorSameTenant,
        command,
        2,
        "2026-09-01T00:00:33Z",
        secondDigest,
      ],
    );
    expect(wrongConnectorResult.rows).toEqual([]);
    const fencedAttempt = await database.query<{
      state: string;
      completed_at: Date | null;
    }>(
      `SELECT command.state, attempt.completed_at
       FROM commands AS command
       JOIN command_attempts AS attempt
         ON attempt.tenant_id = command.tenant_id
        AND attempt.command_id = command.id
        AND attempt.attempt = 2
       WHERE command.tenant_id = $1 AND command.id = $2`,
      [tenantA, command],
    );
    expect(fencedAttempt.rows).toEqual([
      { state: "leased", completed_at: null },
    ]);

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

  it("approves pairing requests idempotently and reuses a connector public key", async () => {
    await seedPairingActor(database);
    await database.exec(`
      INSERT INTO sites (id, tenant_id, name, slug)
      VALUES ('00000000-0000-4000-8000-0000000000a1', '${tenantA}', 'Site A', 'pairing-site-a');
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, requested_site_ids,
        requested_slug_grants,
        poll_token_digest, expires_at
      ) VALUES
        (
          '${pairingA}', '${tenantA}', '${pairingActor}', 'Laptop connector', '1.0',
          decode(repeat('11', 32), 'hex'),
          ARRAY['anytype.objects.read', 'publications.write']::scope_name[],
          ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[],
          ARRAY['notes/project/*', 'public'], repeat('a', 64), now() + interval '10 minutes'
        ),
        (
          '${pairingB}', '${tenantA}', '${pairingActor}', 'Renamed laptop', '1.0',
          decode(repeat('11', 32), 'hex'),
          ARRAY['anytype.objects.read']::scope_name[],
          ARRAY[]::uuid[],
          ARRAY[]::text[], repeat('b', 64), now() + interval '10 minutes'
        );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);

    const [approved, retried] = await Promise.all([
      database.query<PairingOutcomeRow>(
        `SELECT * FROM approve_pairing_session(
          $1, $2, $3, $4::scope_name[], $5::uuid[], $6::text[], now()
        )`,
        [
          tenantA,
          pairingA,
          pairingActor,
          pgArray(["anytype.objects.read", "publications.write"]),
          pgArray(["00000000-0000-4000-8000-0000000000a1"]),
          pgArray(["notes/project/*", "public"]),
        ],
      ),
      database.query<PairingOutcomeRow>(
        `SELECT * FROM approve_pairing_session(
          $1, $2, $3, $4::scope_name[], $5::uuid[], $6::text[], now()
        )`,
        [
          tenantA,
          pairingA,
          pairingActor,
          pgArray(["publications.write", "anytype.objects.read"]),
          pgArray(["00000000-0000-4000-8000-0000000000a1"]),
          pgArray(["public", "notes/project/*"]),
        ],
      ),
    ]);
    expect(approved.rows[0]?.outcome).toBe("approved");
    expect(retried.rows[0]).toMatchObject({
      outcome: "approved",
      connector_id: approved.rows[0]?.connector_id,
    });

    const reused = await database.query<PairingOutcomeRow>(
      `SELECT * FROM approve_pairing_session(
        $1, $2, $3, $4::scope_name[], $5::uuid[], $6::text[], now()
      )`,
      [
        tenantA,
        pairingB,
        pairingActor,
        pgArray(["anytype.objects.read"]),
        pgArray([]),
        pgArray([]),
      ],
    );
    expect(reused.rows[0]?.connector_id).toBe(approved.rows[0]?.connector_id);

    await database.exec("RESET ROLE");
    const connectorCount = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM connectors
      WHERE tenant_id = '${tenantA}' AND public_key = decode(repeat('11', 32), 'hex')
    `);
    expect(connectorCount.rows).toEqual([{ count: 1 }]);
    const approvalAudit = await database.query<{ metadata: unknown }>(`
      SELECT metadata FROM audit_events
      WHERE tenant_id = '${tenantA}' AND action = 'connector.pair.approve'
        AND metadata->>'pairingId' = '${pairingA}'
    `);
    expect(approvalAudit.rows).toEqual([
      {
        metadata: {
          pairingId: pairingA,
          scopes: ["anytype.objects.read", "publications.write"],
          siteIds: ["00000000-0000-4000-8000-0000000000a1"],
          slugGrants: ["notes/project/*", "public"],
        },
      },
    ]);
  });

  it("fails closed on scope escalation, foreign sites, expiry, and tenant mismatch", async () => {
    await seedPairingActor(database);
    await database.exec(`
      INSERT INTO sites (id, tenant_id, name, slug)
      VALUES ('00000000-0000-4000-8000-0000000000b1', '${tenantB}', 'Site B', 'pairing-site-b');
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, requested_site_ids,
        requested_slug_grants,
        poll_token_digest, expires_at
      ) VALUES (
        '${pairingA}', '${tenantA}', '${pairingActor}', 'Laptop connector', '1.0',
        decode(repeat('22', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
        ARRAY['00000000-0000-4000-8000-0000000000b1']::uuid[],
        ARRAY[]::text[], repeat('c', 64), now() + interval '10 minutes'
      );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);

    const escalation = await approvePairing(database, pairingA, {
      scopes: ["anytype.objects.write"],
      siteIds: [],
      slugGrants: [],
    });
    expect(escalation.rows[0]?.outcome).toBe("scope-escalation");
    const foreignSite = await approvePairing(database, pairingA, {
      scopes: ["anytype.objects.read"],
      siteIds: ["00000000-0000-4000-8000-0000000000b1"],
      slugGrants: [],
    });
    expect(foreignSite.rows[0]?.outcome).toBe("unknown-site");
    await expect(
      database.query(
        `SELECT * FROM approve_pairing_session(
          $1, $2, $3, NULL::scope_name[], $4::uuid[], $5::text[], now()
        )`,
        [tenantA, pairingA, pairingActor, pgArray([]), pgArray([])],
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      database.query(
        `SELECT * FROM approve_pairing_session(
          $1, $2, $3, $4::scope_name[], $5::uuid[], $6::text[], now()
        )`,
        [
          tenantB,
          pairingA,
          pairingActor,
          pgArray(["anytype.objects.read"]),
          pgArray([]),
          pgArray([]),
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await database.exec("RESET ROLE");
    await database.exec(`
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, poll_token_digest, created_at, expires_at
      ) VALUES (
        '${pairingB}', '${tenantA}', '${pairingActor}', 'Expired connector', '1.0',
        decode(repeat('23', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
        repeat('d', 64), now() - interval '2 hours', now() - interval '1 hour'
      );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    const expired = await approvePairing(database, pairingB, {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    });
    expect(expired.rows[0]?.outcome).toBe("expired");
  });

  it("returns a terminal pairing result once and rejects replayed poll tokens", async () => {
    await seedPairingActor(database);
    await database.exec(`
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, poll_token_digest, expires_at
      ) VALUES
        (
          '${pairingA}', '${tenantA}', '${pairingActor}', 'Approved connector', '1.0',
          decode(repeat('31', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
          repeat('e', 64), now() + interval '10 minutes'
        ),
        (
          '${pairingB}', '${tenantA}', '${pairingActor}', 'Denied connector', '1.0',
          decode(repeat('32', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
          repeat('f', 64), now() + interval '10 minutes'
        );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    await approvePairing(database, pairingA, {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    });
    const denied = await database.query<{ outcome: string }>(
      "SELECT deny_pairing_session($1, $2, $3, now()) AS outcome",
      [tenantA, pairingB, pairingActor],
    );
    expect(denied.rows).toEqual([{ outcome: "denied" }]);
    const mismatchedDecision = await approvePairing(database, pairingB, {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    });
    expect(mismatchedDecision.rows[0]?.outcome).toBe("conflict");

    const approvedPoll = await pollPairing(database, pairingA, "e".repeat(64));
    expect(approvedPoll.rows[0]).toMatchObject({
      pairing_id: pairingA,
      status: "approved",
      tenant_id: tenantA,
    });
    const approvedReplay = await pollPairing(
      database,
      pairingA,
      "e".repeat(64),
    );
    expect(approvedReplay.rows[0]?.status).toBe("consumed");
    const deniedPoll = await pollPairing(database, pairingB, "f".repeat(64));
    expect(deniedPoll.rows[0]?.status).toBe("denied");
    const wrongToken = await pollPairing(database, pairingB, "0".repeat(64));
    expect(wrongToken.rows).toEqual([]);
  });

  it("expires an approved result that was not retrieved within ten minutes", async () => {
    await seedPairingActor(database);
    await database.exec(`
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, poll_token_digest, expires_at
      ) VALUES (
        '${pairingA}', '${tenantA}', '${pairingActor}', 'Late poll connector', '1.0',
        decode(repeat('35', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
        repeat('7', 64), now() + interval '10 minutes'
      );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    await approvePairing(database, pairingA, {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    });
    const expired = await database.query<{ status: string }>(
      "SELECT status FROM poll_pairing_session($1, $2, now() + interval '11 minutes')",
      [pairingA, "7".repeat(64)],
    );
    expect(expired.rows).toEqual([{ status: "expired" }]);
  });

  it("preserves pairing history when the creating member is removed", async () => {
    await seedPairingActor(database);
    await database.exec(`
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, poll_token_digest, expires_at
      ) VALUES (
        '${pairingA}', '${tenantA}', '${pairingActor}', 'Historical connector', '1.0',
        decode(repeat('36', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
        repeat('8', 64), now() + interval '10 minutes'
      );
      DELETE FROM tenant_members
      WHERE tenant_id = '${tenantA}' AND user_id = '${pairingActor}';
    `);
    const row = await database.query<{ created_by_user_id: string | null }>(`
      SELECT created_by_user_id FROM pairing_sessions WHERE id = '${pairingA}'
    `);
    expect(row.rows).toEqual([{ created_by_user_id: null }]);
  });

  it("allows a tenant cascade to remove an approved pairing and connector", async () => {
    await seedPairingActor(database);
    await database.exec(`
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, poll_token_digest, expires_at
      ) VALUES (
        '${pairingA}', '${tenantA}', '${pairingActor}', 'Tenant cleanup', '1.0',
        decode(repeat('39', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
        repeat('3', 64), now() + interval '10 minutes'
      );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    await approvePairing(database, pairingA, {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    });
    await database.exec("RESET ROLE");
    await database.exec(`DELETE FROM tenants WHERE id = '${tenantA}'`);
    const tenant = await database.query<{ id: string }>(
      `SELECT id FROM tenants WHERE id = '${tenantA}'`,
    );
    expect(tenant.rows).toEqual([]);
  });

  it("derives scope capacity from the enum and rejects duplicate arrays", async () => {
    await seedPairingActor(database);
    const allScopes = await database.query<{ value: string }>(`
      SELECT enumlabel AS value
      FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'scope_name'
      ORDER BY enumsortorder
    `);
    await database.query(
      `INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, poll_token_digest, expires_at
      ) VALUES ($1, $2, $3, 'All scopes', '1.0', decode(repeat('37', 32), 'hex'),
        $4::scope_name[], $5, now() + interval '10 minutes')`,
      [
        pairingA,
        tenantA,
        pairingActor,
        pgArray(allScopes.rows.map((row) => row.value)),
        "9".repeat(64),
      ],
    );
    await expect(
      database.query(
        `INSERT INTO pairing_sessions (
          id, tenant_id, created_by_user_id, connector_name, protocol_version,
          public_key, requested_scopes, poll_token_digest, expires_at
        ) VALUES ($1, $2, $3, 'Duplicate scopes', '1.0', decode(repeat('38', 32), 'hex'),
          ARRAY['anytype.objects.read', 'anytype.objects.read']::scope_name[],
          $4, now() + interval '10 minutes')`,
        [pairingB, tenantA, pairingActor, "0".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("revokes a connector once and refuses to re-pair the revoked public key", async () => {
    await seedPairingActor(database);
    await database.exec(`
      INSERT INTO pairing_sessions (
        id, tenant_id, created_by_user_id, connector_name, protocol_version,
        public_key, requested_scopes, poll_token_digest, expires_at
      ) VALUES
        (
          '${pairingA}', '${tenantA}', '${pairingActor}', 'Revoked connector', '1.0',
          decode(repeat('41', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
          repeat('1', 64), now() + interval '10 minutes'
        ),
        (
          '${pairingC}', '${tenantA}', '${pairingActor}', 'Replay connector', '1.0',
          decode(repeat('41', 32), 'hex'), ARRAY['anytype.objects.read']::scope_name[],
          repeat('2', 64), now() + interval '10 minutes'
        );
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
    const approved = await approvePairing(database, pairingA, {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    });
    const connectorId = approved.rows[0]?.connector_id;
    expect(connectorId).toBeTruthy();
    const renamed = await database.query<{ changed: boolean }>(
      "SELECT rename_connector($1, $2, $3, $4) AS changed",
      [tenantA, connectorId, pairingActor, "Renamed connector"],
    );
    expect(renamed.rows).toEqual([{ changed: true }]);
    await expect(
      database.query("SELECT rename_connector($1, $2, $3, NULL) AS changed", [
        tenantA,
        connectorId,
        pairingActor,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    const first = await database.query<{ revoked: boolean }>(
      "SELECT revoke_connector($1, $2, $3, now()) AS revoked",
      [tenantA, connectorId, pairingActor],
    );
    const retry = await database.query<{ revoked: boolean }>(
      "SELECT revoke_connector($1, $2, $3, now()) AS revoked",
      [tenantA, connectorId, pairingActor],
    );
    expect(first.rows).toEqual([{ revoked: true }]);
    expect(retry.rows).toEqual([{ revoked: true }]);
    const repaired = await approvePairing(database, pairingC, {
      scopes: ["anytype.objects.read"],
      siteIds: [],
      slugGrants: [],
    });
    expect(repaired.rows[0]?.outcome).toBe("revoked-key");

    await database.exec("RESET ROLE");
    const audit = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM audit_events
      WHERE tenant_id = '${tenantA}' AND action = 'connector.revoke'
    `);
    expect(audit.rows).toEqual([{ count: 1 }]);
    const renameAudit = await database.query<{ metadata: unknown }>(`
      SELECT metadata FROM audit_events
      WHERE tenant_id = '${tenantA}' AND action = 'connector.rename'
    `);
    expect(renameAudit.rows).toEqual([
      {
        metadata: {
          oldName: "Revoked connector",
          newName: "Renamed connector",
        },
      },
    ]);
  });

  it("keeps the pairing role isolated from tenant authority", async () => {
    const role = await database.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      can_create: boolean;
      has_membership: boolean;
    }>(`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit,
        has_schema_privilege('knot_pairing', 'public', 'CREATE') AS can_create,
        EXISTS (
          SELECT 1 FROM pg_auth_members
          WHERE member = pg_roles.oid
        ) AS has_membership
      FROM pg_roles WHERE rolname = 'knot_pairing'
    `);
    expect(role.rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        can_create: false,
        has_membership: false,
      },
    ]);
    const privileges = await database.query<{
      reads_members: boolean;
      executes_approval: boolean;
      executes_poll: boolean;
    }>(`
      SELECT
        has_table_privilege('knot_pairing', 'tenant_members', 'SELECT') AS reads_members,
        has_function_privilege(
          'knot_pairing',
          'approve_pairing_session(uuid,uuid,uuid,scope_name[],uuid[],text[],timestamptz)',
          'EXECUTE'
        ) AS executes_approval,
        has_function_privilege(
          'knot_pairing', 'poll_pairing_session(uuid,text,timestamptz)', 'EXECUTE'
        ) AS executes_poll
    `);
    expect(privileges.rows).toEqual([
      { reads_members: false, executes_approval: false, executes_poll: true },
    ]);

    const pollAcl = await database.query<{
      app_executes: boolean;
      public_executes: boolean;
    }>(`
      SELECT
        has_function_privilege(
          'knot_app', 'poll_pairing_session(uuid,text,timestamptz)', 'EXECUTE'
        ) AS app_executes,
        EXISTS (
          SELECT 1
          FROM pg_proc AS function
          CROSS JOIN LATERAL aclexplode(
            coalesce(function.proacl, acldefault('f', function.proowner))
          ) AS privilege
          WHERE function.oid = 'poll_pairing_session(uuid,text,timestamptz)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS public_executes
    `);
    expect(pollAcl.rows).toEqual([
      { app_executes: true, public_executes: false },
    ]);
  });

  it("repairs SECURITY DEFINER ACLs from an applied 0008 state", async () => {
    await database.exec(`
      GRANT knot_resolver TO CURRENT_USER;
      SET ROLE knot_resolver;
      GRANT EXECUTE ON FUNCTION public.resolve_connector(uuid) TO PUBLIC;
      GRANT EXECUTE ON FUNCTION public.resolve_api_key(text) TO PUBLIC;
      GRANT EXECUTE ON FUNCTION public.resolve_invitation(text) TO PUBLIC;
      GRANT EXECUTE ON FUNCTION public.complete_command(
        uuid, uuid, uuid, integer, timestamptz, text, public.command_state,
        jsonb, text, boolean, integer
      ) TO PUBLIC;
      REVOKE ALL ON FUNCTION public.resolve_connector(uuid) FROM knot_app;
      REVOKE ALL ON FUNCTION public.resolve_api_key(text) FROM knot_app;
      REVOKE ALL ON FUNCTION public.resolve_invitation(text) FROM knot_app;
      REVOKE ALL ON FUNCTION public.complete_command(
        uuid, uuid, uuid, integer, timestamptz, text, public.command_state,
        jsonb, text, boolean, integer
      ) FROM knot_app;
      RESET ROLE;
      REVOKE knot_resolver FROM CURRENT_USER GRANTED BY CURRENT_USER;

      GRANT knot_bootstrap TO CURRENT_USER;
      SET ROLE knot_bootstrap;
      GRANT EXECUTE ON FUNCTION public.resolve_or_bootstrap_workspace(
        text, text, text, smallint, text
      ) TO PUBLIC;
      GRANT EXECUTE ON FUNCTION
        public.select_workspace_for_session(text, text, uuid)
      TO PUBLIC;
      REVOKE ALL ON FUNCTION public.resolve_or_bootstrap_workspace(
        text, text, text, smallint, text
      ) FROM knot_app;
      REVOKE ALL ON FUNCTION
        public.select_workspace_for_session(text, text, uuid)
      FROM knot_app;
      RESET ROLE;
      REVOKE knot_bootstrap FROM CURRENT_USER GRANTED BY CURRENT_USER;

      GRANT knot_pairing TO CURRENT_USER;
      SET ROLE knot_pairing;
      GRANT EXECUTE ON FUNCTION
        public.poll_pairing_session(uuid, text, timestamptz)
      TO PUBLIC;
      REVOKE ALL ON FUNCTION
        public.poll_pairing_session(uuid, text, timestamptz)
      FROM knot_app;
      RESET ROLE;
      REVOKE knot_pairing FROM CURRENT_USER;
    `);

    await database.exec("SET SESSION AUTHORIZATION knot_migrator");

    const migrationDirectory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "migrations",
    );
    const repair = await readFile(
      path.join(migrationDirectory, "0008a_security_definer_acl.sql"),
      "utf8",
    );
    await database.exec(repair);
    await database.exec(repair);

    const repaired = await database.query<{
      app_executes: boolean;
      public_executes: boolean;
      self_granted_memberships: number;
    }>(`
      SELECT
        has_function_privilege(
          'knot_app', 'poll_pairing_session(uuid,text,timestamptz)', 'EXECUTE'
        ) AS app_executes,
        EXISTS (
          SELECT 1
          FROM pg_proc AS function
          CROSS JOIN LATERAL aclexplode(
            coalesce(function.proacl, acldefault('f', function.proowner))
          ) AS privilege
          WHERE function.oid = 'poll_pairing_session(uuid,text,timestamptz)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS public_executes,
        (
          SELECT count(*)::int
          FROM pg_auth_members AS membership
          WHERE membership.roleid = 'knot_pairing'::regrole
            AND membership.member = current_user::regrole
            AND membership.grantor = current_user::regrole
        ) AS self_granted_memberships
    `);
    expect(repaired.rows).toEqual([
      {
        app_executes: true,
        public_executes: false,
        self_granted_memberships: 0,
      },
    ]);

    const exposedDefiners = await database.query<{
      signature: string;
      owner: string;
      public_executes: boolean;
      app_executes: boolean;
    }>(`
      SELECT
        function.oid::regprocedure::text AS signature,
        owner.rolname AS owner,
        EXISTS (
          SELECT 1
          FROM aclexplode(
            coalesce(function.proacl, acldefault('f', function.proowner))
          ) AS privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS public_executes,
        has_function_privilege('knot_app', function.oid, 'EXECUTE') AS app_executes
      FROM pg_proc AS function
      JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
      JOIN pg_roles AS owner ON owner.oid = function.proowner
      WHERE namespace.nspname = 'public'
        AND function.prosecdef
        AND (
          EXISTS (
            SELECT 1
            FROM aclexplode(
              coalesce(function.proacl, acldefault('f', function.proowner))
            ) AS privilege
            WHERE privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
          )
          OR NOT has_function_privilege('knot_app', function.oid, 'EXECUTE')
        )
      ORDER BY signature
    `);
    expect(exposedDefiners.rows).toEqual([]);
    await database.exec("RESET SESSION AUTHORIZATION");
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

interface PairingOutcomeRow {
  outcome: string;
  connector_id: string | null;
  approved_at: string | null;
}

async function seedPairingActor(database: PGlite) {
  await database.exec(`
    INSERT INTO users (id, email_digest, email_digest_version)
    VALUES ('${pairingActor}', '${"8".repeat(64)}', 1);
    INSERT INTO tenant_members (tenant_id, user_id, role)
    VALUES ('${tenantA}', '${pairingActor}', 'owner');
  `);
}

function approvePairing(
  database: PGlite,
  pairingId: string,
  grant: { scopes: string[]; siteIds: string[]; slugGrants: string[] },
) {
  return database.query<PairingOutcomeRow>(
    `SELECT * FROM approve_pairing_session(
      $1, $2, $3, $4::scope_name[], $5::uuid[], $6::text[], now()
    )`,
    [
      tenantA,
      pairingId,
      pairingActor,
      pgArray(grant.scopes),
      pgArray(grant.siteIds),
      pgArray(grant.slugGrants),
    ],
  );
}

function pollPairing(database: PGlite, pairingId: string, digest: string) {
  return database.query<{
    pairing_id: string;
    status: string;
    tenant_id: string | null;
  }>("SELECT * FROM poll_pairing_session($1, $2, now())", [pairingId, digest]);
}

function pgArray(values: string[]): string {
  return `{${values.join(",")}}`;
}
