import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrations = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);
const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "20000000-0000-4000-8000-000000000001";
const connectorA = "10000000-0000-4000-8000-000000000002";
const connectorB = "20000000-0000-4000-8000-000000000002";
const isolatedTables = [
  "webhook_subscriptions",
  "transactional_events",
  "webhook_deliveries",
  "tenant_platform_limits",
  "custom_domains",
  "reader_grants",
  "reader_sessions",
  "media_derivative_jobs",
  "connector_request_nonces",
] as const;

describe("cross-cutting release security gates", () => {
  it("claims connector nonces durably under a unique tenant fence", async () => {
    const database = await migratedDatabase();
    try {
      await database.exec(`
        RESET ROLE;
        INSERT INTO tenants(id,name) VALUES ('${tenantA}','A'),('${tenantB}','B');
        INSERT INTO connectors(id,tenant_id,name,protocol_version,public_key,scopes) VALUES
          ('${connectorA}','${tenantA}','A','1.0',decode(repeat('00',32),'hex'),'{anytype.objects.read}'),
          ('${connectorB}','${tenantB}','B','1.0',decode(repeat('11',32),'hex'),'{anytype.objects.read}');
        SET ROLE knot_app;
        SELECT set_config('app.tenant_id','${tenantA}',false);
      `);

      const first = await claim(
        database,
        tenantA,
        connectorA,
        "nonce_1234567890abcdef",
      );
      const replay = await claim(
        database,
        tenantA,
        connectorA,
        "nonce_1234567890abcdef",
      );
      expect(first).toBe(true);
      expect(replay).toBe(false);

      await database.exec(`
        RESET ROLE;
        INSERT INTO connector_request_nonces(
          tenant_id,connector_id,nonce,claimed_at,expires_at
        ) VALUES (
          '${tenantA}','${connectorA}','nonce_expired_123456',
          now() - interval '2 days',now() - interval '1 day'
        );
        SET ROLE knot_app;
        SELECT set_config('app.tenant_id','${tenantA}',false);
      `);
      expect(
        await claim(database, tenantA, connectorA, "nonce_expired_123456"),
      ).toBe(true);

      await database.exec(
        `SELECT set_config('app.tenant_id','${tenantB}',false)`,
      );
      await expect(
        claim(database, tenantA, connectorA, "nonce_wrong_tenant1"),
      ).rejects.toThrow(/tenant context mismatch/u);
      expect(
        await claim(database, tenantB, connectorB, "nonce_1234567890abcdef"),
      ).toBe(true);
    } finally {
      await database.close();
    }
  });

  it("forces RLS on every table added by the candidate stack", async () => {
    const database = await migratedDatabase();
    try {
      await database.exec(`
        RESET ROLE;
        INSERT INTO users(id,email_digest,email_digest_version)
          VALUES ('10000000-0000-4000-8000-000000000010',repeat('1',64),1);
        INSERT INTO tenants(id,name) VALUES ('${tenantA}','A');
        INSERT INTO sites(id,tenant_id,name,slug)
          VALUES ('10000000-0000-4000-8000-000000000011','${tenantA}','A','site-a');
        INSERT INTO connectors(id,tenant_id,name,protocol_version,public_key,scopes) VALUES
          ('${connectorA}','${tenantA}','A','1.0',decode(repeat('00',32),'hex'),'{anytype.chats.read}');
        INSERT INTO api_keys(id,tenant_id,name,key_id,key_digest,scopes)
          VALUES ('10000000-0000-4000-8000-000000000012','${tenantA}','events',
                  'abcdefghijklmnop',repeat('2',64),'{anytype.chats.read}');
        INSERT INTO assets(id,tenant_id,sha256,pathname,content_type,byte_size)
          VALUES ('10000000-0000-4000-8000-000000000013','${tenantA}',repeat('3',64),
                  'tenants/a/source','image/png',1);
        INSERT INTO tenant_platform_limits(
          tenant_id,media_derivatives_enabled,max_derivative_jobs_per_month
        ) VALUES ('${tenantA}',true,10);
        INSERT INTO custom_domains(
          id,tenant_id,site_id,hostname,challenge_digest,challenge_expires_at,created_by
        ) VALUES (
          '10000000-0000-4000-8000-000000000014','${tenantA}',
          '10000000-0000-4000-8000-000000000011','docs.example.com',repeat('4',64),
          now() + interval '1 day','10000000-0000-4000-8000-000000000010'
        );
        INSERT INTO reader_grants(
          id,tenant_id,site_id,label,token_digest,expires_at,created_by
        ) VALUES (
          '10000000-0000-4000-8000-000000000015','${tenantA}',
          '10000000-0000-4000-8000-000000000011','Reviewers',repeat('5',64),
          now() + interval '1 day','10000000-0000-4000-8000-000000000010'
        );
        INSERT INTO reader_sessions(
          id,tenant_id,site_id,grant_id,token_digest,expires_at
        ) VALUES (
          '10000000-0000-4000-8000-000000000016','${tenantA}',
          '10000000-0000-4000-8000-000000000011',
          '10000000-0000-4000-8000-000000000015',repeat('6',64),
          now() + interval '1 hour'
        );
        INSERT INTO media_derivative_jobs(
          id,tenant_id,source_asset_id,purpose,output_content_type,max_width,max_height
        ) VALUES (
          '10000000-0000-4000-8000-000000000017','${tenantA}',
          '10000000-0000-4000-8000-000000000013','thumbnail','image/webp',256,256
        );
        INSERT INTO webhook_subscriptions(
          id,tenant_id,name,destination_name,event_types,connector_ids,created_by
        ) VALUES (
          '10000000-0000-4000-8000-000000000018','${tenantA}','automation',
          'automation','{channel.message.available}',ARRAY['${connectorA}']::uuid[],
          '10000000-0000-4000-8000-000000000010'
        );
        INSERT INTO transactional_events(
          id,tenant_id,connector_id,api_key_id,idempotency_key,request_sha256,
          event_type,origin_space_id,origin_chat_id,origin_message_id,occurred_at
        ) VALUES (
          '10000000-0000-4000-8000-000000000019','${tenantA}','${connectorA}',
          '10000000-0000-4000-8000-000000000012','event-key-00000001',repeat('7',64),
          'channel.message.available','space','chat','message',now()
        );
        INSERT INTO webhook_deliveries(
          id,tenant_id,subscription_id,event_id
        ) VALUES (
          '10000000-0000-4000-8000-000000000020','${tenantA}',
          '10000000-0000-4000-8000-000000000018',
          '10000000-0000-4000-8000-000000000019'
        );
        INSERT INTO connector_request_nonces(
          tenant_id,connector_id,nonce,expires_at
        ) VALUES ('${tenantA}','${connectorA}','nonce_rls_123456789',now() + interval '10 minutes');
      `);
      const relations = await database.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(`
        SELECT relname,relrowsecurity,relforcerowsecurity
        FROM pg_class
        WHERE relname = ANY(ARRAY[${isolatedTables.map((name) => `'${name}'`).join(",")}])
        ORDER BY relname
      `);
      expect(relations.rows).toHaveLength(isolatedTables.length);
      expect(relations.rows).toEqual(
        relations.rows.map((relation) => ({
          ...relation,
          relrowsecurity: true,
          relforcerowsecurity: true,
        })),
      );

      await database.exec(`
        SET ROLE knot_app;
        SELECT set_config('app.tenant_id','',false);
      `);
      for (const table of isolatedTables) {
        try {
          const result = await database.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM ${table}`,
          );
          expect(result.rows, table).toEqual([{ count: 0 }]);
        } catch (error) {
          expect(String(error), table).toMatch(/permission denied/u);
        }
        try {
          const removed = await database.query<{ count: number }>(
            `WITH deleted AS (DELETE FROM ${table} RETURNING 1)
             SELECT count(*)::int AS count FROM deleted`,
          );
          expect(removed.rows, table).toEqual([{ count: 0 }]);
        } catch (error) {
          expect(String(error), table).toMatch(/permission denied/u);
        }
      }
    } finally {
      await database.close();
    }
  });
});

async function migratedDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE ROLE knot_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS;
    GRANT CREATE ON DATABASE postgres TO knot_migrator;
    ALTER SCHEMA public OWNER TO knot_migrator;
    GRANT knot_migrator TO CURRENT_USER;
    SET ROLE knot_migrator;
    CREATE TABLE schema_migrations(
      name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz DEFAULT now()
    );
  `);
  for (const name of (await readdir(migrations))
    .filter((entry) => /^\d+.*\.sql$/u.test(entry))
    .sort()) {
    await database.exec(await readFile(path.join(migrations, name), "utf8"));
  }
  return database;
}

async function claim(
  database: PGlite,
  tenantId: string,
  connectorId: string,
  nonce: string,
): Promise<boolean> {
  const result = await database.query<{ claimed: boolean }>(`
    SELECT claim_connector_request_nonce(
      '${tenantId}','${connectorId}','${nonce}',now() + interval '10 minutes'
    ) AS claimed
  `);
  return result.rows[0]?.claimed ?? false;
}
