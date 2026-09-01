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
const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";
const connectorA = "00000000-0000-4000-8000-000000000011";
const apiKeyA = "00000000-0000-4000-8000-000000000021";

describe("transactional event migration", () => {
  it("atomically fans out once, isolates tenants, and rejects changed replay", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE ROLE knot_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS;
        GRANT CREATE ON DATABASE postgres TO knot_migrator;
        ALTER SCHEMA public OWNER TO knot_migrator;
        GRANT knot_migrator TO CURRENT_USER;
        SET ROLE knot_migrator;
        CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz DEFAULT now());
      `);
      for (const name of (await readdir(migrations))
        .filter((entry) => /^\d+.*\.sql$/u.test(entry))
        .sort())
        await database.exec(
          await readFile(path.join(migrations, name), "utf8"),
        );
      await database.exec(`
        RESET ROLE;
        INSERT INTO tenants(id,name) VALUES ('${tenantA}','A'),('${tenantB}','B');
        INSERT INTO connectors(id,tenant_id,name,protocol_version,public_key,scopes) VALUES
          ('${connectorA}','${tenantA}','A','1.0',decode(repeat('00',32),'hex'),'{anytype.chats.read}');
        INSERT INTO api_keys(id,tenant_id,name,key_id,key_digest,scopes) VALUES
          ('${apiKeyA}','${tenantA}','events','abcdefghijklmnop',repeat('0',64),'{anytype.chats.read}');
        INSERT INTO webhook_subscriptions(
          tenant_id,name,destination_name,event_types,connector_ids,created_by
        ) VALUES(
          '${tenantA}','automation','automation','{channel.message.available}',
          ARRAY['${connectorA}']::uuid[],'00000000-0000-4000-8000-000000000099'
        );
        SET ROLE knot_app;
        SELECT set_config('app.tenant_id','${tenantA}',false);
      `);
      const first = await database.query<{
        event_id: string;
        was_created: boolean;
      }>(`
        SELECT * FROM enqueue_transactional_event(
          '${tenantA}','${apiKeyA}','${connectorA}','event-key-00000001',repeat('a',64),
          'channel.message.available','space','chat','message',now()
        )
      `);
      const duplicate = await database.query<{
        event_id: string;
        was_created: boolean;
      }>(`
        SELECT * FROM enqueue_transactional_event(
          '${tenantA}','${apiKeyA}','${connectorA}','event-key-00000001',repeat('a',64),
          'channel.message.available','space','chat','message',now()
        )
      `);
      expect(first.rows[0]?.was_created).toBe(true);
      expect(duplicate.rows).toEqual([
        { event_id: first.rows[0]?.event_id, was_created: false },
      ]);
      const deliveryCount = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM webhook_deliveries",
      );
      expect(deliveryCount.rows[0]?.count).toBe(1);
      const dueTenants = await database.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM list_webhook_delivery_tenants(now(),10)",
      );
      expect(dueTenants.rows).toEqual([{ tenant_id: tenantA }]);

      await database.exec(
        `SELECT set_config('app.tenant_id','${tenantB}',false)`,
      );
      const invisible = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM transactional_events",
      );
      expect(invisible.rows[0]?.count).toBe(0);

      await database.exec(
        `SELECT set_config('app.tenant_id','${tenantA}',false)`,
      );
      await expect(
        database.query(`SELECT * FROM enqueue_transactional_event(
          '${tenantA}','${apiKeyA}','${connectorA}','event-key-00000001',repeat('b',64),
          'channel.message.available','space','chat','message',now()
        )`),
      ).rejects.toThrow(/idempotency conflict/u);
    } finally {
      await database.close();
    }
  });
});
