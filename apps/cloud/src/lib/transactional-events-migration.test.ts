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
        INSERT INTO api_key_connectors(tenant_id,api_key_id,connector_id)
        VALUES('${tenantA}','${apiKeyA}','${connectorA}');
        UPDATE api_keys SET requests_per_minute=2,requests_per_day=2
        WHERE id='${apiKeyA}';
        SET ROLE knot_app;
        SELECT set_config('app.tenant_id','${tenantA}',false);
      `);
      const createdSubscription = await database.query<{
        status: string;
        subscription_id: string;
      }>(`
        SELECT status,subscription_id FROM create_webhook_subscription(
          '${tenantA}','00000000-0000-4000-8000-000000000099','automation',
          'automation','{channel.message.available}',ARRAY['${connectorA}']::uuid[],1
        )
      `);
      expect(createdSubscription.rows).toEqual([
        {
          status: "created",
          subscription_id: expect.any(String) as string,
        },
      ]);
      const duplicateSubscription = await database.query<{ status: string }>(`
        SELECT status FROM create_webhook_subscription(
          '${tenantA}','00000000-0000-4000-8000-000000000099','same-route',
          'automation','{channel.message.available}',ARRAY['${connectorA}']::uuid[],10
        )
      `);
      expect(duplicateSubscription.rows).toEqual([
        { status: "duplicate-subscription" },
      ]);
      const nameConflict = await database.query<{ status: string }>(`
        SELECT status FROM create_webhook_subscription(
          '${tenantA}','00000000-0000-4000-8000-000000000099','automation',
          'another-destination','{channel.message.available}',ARRAY['${connectorA}']::uuid[],10
        )
      `);
      expect(nameConflict.rows).toEqual([
        { status: "subscription-name-conflict" },
      ]);
      const capped = await database.query<{ status: string }>(`
        SELECT status FROM create_webhook_subscription(
          '${tenantA}','00000000-0000-4000-8000-000000000099','second',
          'another-destination','{channel.message.available}',ARRAY['${connectorA}']::uuid[],1
        )
      `);
      expect(capped.rows).toEqual([{ status: "subscription-limit-exceeded" }]);
      const denied = await database.query<{ status: string }>(`
        SELECT status FROM create_webhook_subscription(
          '${tenantA}','00000000-0000-4000-8000-000000000099','denied',
          'another-destination','{channel.message.available}',
          ARRAY['00000000-0000-4000-8000-000000000099']::uuid[],10
        )
      `);
      expect(denied.rows).toEqual([{ status: "connector-denied" }]);
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

      const claimAt = new Date(Date.now() + 60_000);
      const firstClaim = await database.query<{
        delivery_id: string;
        attempt: number;
      }>(
        `SELECT delivery_id,attempt FROM claim_webhook_delivery(
          $1::uuid,$2::timestamptz,repeat('1',64),15
        )`,
        [tenantA, claimAt],
      );
      expect(firstClaim.rows).toHaveLength(1);
      expect(firstClaim.rows[0]?.attempt).toBe(1);
      await expect(
        database.query(
          `SELECT complete_webhook_delivery(
            $1::uuid,$2::uuid,1,repeat('9',64),$3::timestamptz,
            false,true,503,repeat('a',64),'http-503'
          )`,
          [
            tenantA,
            firstClaim.rows[0]!.delivery_id,
            new Date(claimAt.getTime() + 1_000),
          ],
        ),
      ).rejects.toThrow(/stale delivery fence/u);

      const reclaimed = await database.query<{
        delivery_id: string;
        attempt: number;
      }>(
        `SELECT delivery_id,attempt FROM claim_webhook_delivery(
          $1::uuid,$2::timestamptz,repeat('2',64),15
        )`,
        [tenantA, new Date(claimAt.getTime() + 16_000)],
      );
      expect(reclaimed.rows).toEqual([
        { delivery_id: firstClaim.rows[0]!.delivery_id, attempt: 2 },
      ]);
      const retry = await database.query<{ state: string }>(
        `SELECT complete_webhook_delivery(
          $1::uuid,$2::uuid,2,repeat('2',64),$3::timestamptz,
          false,true,503,repeat('b',64),'http-503'
        )::text AS state`,
        [
          tenantA,
          firstClaim.rows[0]!.delivery_id,
          new Date(claimAt.getTime() + 17_000),
        ],
      );
      expect(retry.rows).toEqual([{ state: "retrying" }]);
      const finalClaim = await database.query<{
        delivery_id: string;
        attempt: number;
      }>(
        `SELECT delivery_id,attempt FROM claim_webhook_delivery(
          $1::uuid,$2::timestamptz,repeat('3',64),15
        )`,
        [tenantA, new Date(claimAt.getTime() + 22_000)],
      );
      expect(finalClaim.rows).toEqual([
        { delivery_id: firstClaim.rows[0]!.delivery_id, attempt: 3 },
      ]);
      const failed = await database.query<{ state: string }>(
        `SELECT complete_webhook_delivery(
          $1::uuid,$2::uuid,3,repeat('3',64),$3::timestamptz,
          false,false,400,repeat('c',64),'http-400'
        )::text AS state`,
        [
          tenantA,
          firstClaim.rows[0]!.delivery_id,
          new Date(claimAt.getTime() + 23_000),
        ],
      );
      expect(failed.rows).toEqual([{ state: "dead-lettered" }]);

      const second = await database.query<{
        event_id: string;
        was_created: boolean;
      }>(`
        SELECT * FROM enqueue_transactional_event(
          '${tenantA}','${apiKeyA}','${connectorA}','event-key-00000002',repeat('d',64),
          'channel.message.available','space','chat','message-2',now()
        )
      `);
      expect(second.rows[0]?.was_created).toBe(true);
      const exhaustedClaim = await database.query<{ delivery_id: string }>(
        `SELECT delivery_id FROM claim_webhook_delivery(
          $1::uuid,$2::timestamptz,repeat('4',64),15
        )`,
        [tenantA, new Date(claimAt.getTime() + 24_000)],
      );
      expect(exhaustedClaim.rows).toHaveLength(1);
      await database.query(
        `UPDATE webhook_deliveries SET attempt_count=10,
          lease_expires_at=$3::timestamptz
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [
          tenantA,
          exhaustedClaim.rows[0]!.delivery_id,
          new Date(claimAt.getTime() + 25_000),
        ],
      );
      const noReclaim = await database.query<{ delivery_id: string }>(
        `SELECT delivery_id FROM claim_webhook_delivery(
          $1::uuid,$2::timestamptz,repeat('5',64),15
        )`,
        [tenantA, new Date(claimAt.getTime() + 26_000)],
      );
      expect(noReclaim.rows).toEqual([]);
      const deliveryAudits = await database.query<{
        principal_id: string | null;
        action: string;
        outcome: string;
      }>(
        `SELECT principal_id,action,outcome FROM audit_events
         WHERE tenant_id=$1::uuid AND action='webhook.delivery'
         ORDER BY created_at,id`,
        [tenantA],
      );
      expect(deliveryAudits.rows).toEqual([
        {
          principal_id: null,
          action: "webhook.delivery",
          outcome: "dead-lettered",
        },
        {
          principal_id: null,
          action: "webhook.delivery",
          outcome: "dead-lettered",
        },
      ]);

      await expect(
        database.query(`SELECT * FROM enqueue_transactional_event(
          '${tenantA}','${apiKeyA}','${connectorA}','event-key-00000003',repeat('e',64),
          'channel.message.available','space','chat','message-3',now()
        )`),
      ).rejects.toThrow(/quota exceeded/u);
      const usage = await database.query<{ request_count: number }>(
        `SELECT request_count::int AS request_count FROM api_key_usage_windows
         WHERE tenant_id=$1::uuid AND api_key_id=$2::uuid AND window_kind='day'`,
        [tenantA, apiKeyA],
      );
      expect(usage.rows).toEqual([{ request_count: 2 }]);

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

      await database.exec(`
        INSERT INTO transactional_events(
          tenant_id,connector_id,api_key_id,idempotency_key,request_sha256,event_type,
          origin_space_id,origin_chat_id,origin_message_id,occurred_at
        ) VALUES
          ('${tenantA}','${connectorA}','${apiKeyA}','event-key-disabled-01',repeat('6',64),
           'channel.message.available','space','chat','disabled-1',now()),
          ('${tenantA}','${connectorA}','${apiKeyA}','event-key-disabled-02',repeat('7',64),
           'channel.message.available','space','chat','disabled-2',now());
        INSERT INTO webhook_deliveries(tenant_id,subscription_id,event_id,state)
        SELECT '${tenantA}', '${createdSubscription.rows[0]!.subscription_id}', id,
          CASE WHEN origin_message_id='disabled-1'
            THEN 'leased'::webhook_delivery_state
            ELSE 'retrying'::webhook_delivery_state END
        FROM transactional_events WHERE origin_message_id IN ('disabled-1','disabled-2');
        UPDATE webhook_deliveries SET attempt_count=1,
          lease_token_digest=repeat('8',64),lease_expires_at=now()+interval '1 minute'
        WHERE state='leased';
      `);
      const disabled = await database.query<{ disabled: boolean }>(
        `SELECT disable_webhook_subscription($1::uuid,$2::uuid,$3::uuid) AS disabled`,
        [
          tenantA,
          "00000000-0000-4000-8000-000000000099",
          createdSubscription.rows[0]!.subscription_id,
        ],
      );
      expect(disabled.rows).toEqual([{ disabled: true }]);
      const swept = await database.query<{
        state: string;
        last_error_code: string;
        lease_token_digest: string | null;
      }>(`
        SELECT state::text,last_error_code,lease_token_digest
        FROM webhook_deliveries
        WHERE event_id IN (
          SELECT id FROM transactional_events
          WHERE origin_message_id IN ('disabled-1','disabled-2')
        ) ORDER BY event_id
      `);
      expect(swept.rows).toEqual([
        {
          state: "dead-lettered",
          last_error_code: "subscription-disabled",
          lease_token_digest: null,
        },
        {
          state: "dead-lettered",
          last_error_code: "subscription-disabled",
          lease_token_digest: null,
        },
      ]);
    } finally {
      await database.close();
    }
  });
});
