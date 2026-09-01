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
const siteA = "10000000-0000-4000-8000-000000000002";
const userA = "10000000-0000-4000-8000-000000000003";
const grantA = "10000000-0000-4000-8000-000000000004";
const sessionA = "10000000-0000-4000-8000-000000000005";
const domainA = "10000000-0000-4000-8000-000000000006";
const assetA = "10000000-0000-4000-8000-000000000007";
const domainB = "10000000-0000-4000-8000-000000000008";

describe("platform extension migration", () => {
  it("isolates tenant state, enforces quotas, and revokes reader sessions", async () => {
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
        .sort()) {
        await database.exec(
          await readFile(path.join(migrations, name), "utf8"),
        );
      }
      await database.exec(`
        RESET ROLE;
        INSERT INTO tenants(id,name) VALUES ('${tenantA}','A'),('${tenantB}','B');
        INSERT INTO sites(id,tenant_id,name,slug) VALUES ('${siteA}','${tenantA}','A','site-a');
        SET ROLE knot_app;
        SELECT set_config('app.tenant_id','${tenantA}',false);
        INSERT INTO tenant_platform_limits(tenant_id,max_custom_domains)
          VALUES ('${tenantA}',1);
        SELECT create_custom_domain(
          '${tenantA}','${userA}','${siteA}','${domainA}',
          'docs.example.com',repeat('a',64),now() + interval '1 day'
        );
        SELECT create_reader_grant(
          '${tenantA}','${userA}','${siteA}','${grantA}','Reviewers',
          repeat('b',64),now() + interval '1 day',1
        );
      `);

      await expect(
        database.query(`SELECT create_custom_domain(
          '${tenantA}','${userA}','${siteA}',gen_random_uuid(),
          'other.example.com',repeat('c',64),now() + interval '1 day'
        )`),
      ).rejects.toThrow(/custom domain quota exceeded/u);

      await database.exec(
        `SELECT set_config('app.tenant_id','${tenantB}',false)`,
      );
      const hidden = await database.query<{ domains: number; grants: number }>(`
        SELECT
          (SELECT count(*)::int FROM custom_domains) AS domains,
          (SELECT count(*)::int FROM reader_grants) AS grants
      `);
      expect(hidden.rows).toEqual([{ domains: 0, grants: 0 }]);

      const redeemed = await database.query<{
        tenant_id: string;
        site_slug: string;
      }>(`SELECT tenant_id,site_slug FROM redeem_reader_grant(
        repeat('b',64),'${sessionA}',repeat('d',64),now() + interval '1 hour'
      )`);
      expect(redeemed.rows).toEqual([
        { tenant_id: tenantA, site_slug: "site-a" },
      ]);
      const authorized = await database.query<{ authorized: boolean }>(
        `SELECT reader_session_authorizes('${siteA}',repeat('d',64)) AS authorized`,
      );
      expect(authorized.rows[0]?.authorized).toBe(true);

      await database.exec(`
        SELECT set_config('app.tenant_id','${tenantA}',false);
        SELECT revoke_reader_grant('${tenantA}','${userA}','${grantA}');
        SELECT disable_custom_domain('${tenantA}','${userA}','${domainA}');
        SELECT create_custom_domain(
          '${tenantA}','${userA}','${siteA}','${domainB}',
          'docs.example.com',repeat('f',64),now() + interval '1 day'
        );
        INSERT INTO assets(id,tenant_id,sha256,pathname,content_type,byte_size)
          VALUES ('${assetA}','${tenantA}',repeat('e',64),'tenant-a/source','image/png',1);
      `);
      const revoked = await database.query<{ authorized: boolean }>(
        `SELECT reader_session_authorizes('${siteA}',repeat('d',64)) AS authorized`,
      );
      expect(revoked.rows[0]?.authorized).toBe(false);

      await expect(
        database.query(`INSERT INTO media_derivative_jobs(
          id,tenant_id,source_asset_id,purpose,output_content_type,max_width,max_height
        ) VALUES (
          gen_random_uuid(),'${tenantA}','${assetA}','thumbnail','image/webp',256,256
        )`),
      ).rejects.toThrow(/media derivatives are not enabled/u);

      await database.exec("RESET ROLE");
      const owners = await database.query<{ owner: string }>(`
        SELECT DISTINCT pg_get_userbyid(proowner) AS owner
        FROM pg_proc
        WHERE proname IN (
          'redeem_reader_grant','reader_session_authorizes','resolve_reader_page',
          'resolve_reader_asset','resolve_custom_domain_reader_page',
          'resolve_custom_domain_site','resolve_reader_site_access'
        )
      `);
      expect(owners.rows).toEqual([{ owner: "knot_resolver" }]);
    } finally {
      await database.close();
    }
  });
});
