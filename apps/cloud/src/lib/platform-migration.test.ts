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
const connectorA = "10000000-0000-4000-8000-000000000009";
const publicationA = "10000000-0000-4000-8000-000000000010";
const versionA = "10000000-0000-4000-8000-000000000011";

describe("platform extension migration", () => {
  it("isolates tenant state, enforces quotas, and revokes reader sessions", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE ROLE knot_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE knot_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        GRANT knot_app TO knot_migrator;
        GRANT CREATE ON DATABASE postgres TO knot_migrator;
        ALTER SCHEMA public OWNER TO knot_migrator;
        SET SESSION AUTHORIZATION knot_migrator;
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
        SET ROLE knot_app;
        SELECT set_config('app.tenant_id','${tenantA}',false);
        INSERT INTO tenants(id,name) VALUES ('${tenantA}','A');
        INSERT INTO sites(id,tenant_id,name,slug) VALUES ('${siteA}','${tenantA}','A','site-a');
        SELECT set_config('app.tenant_id','${tenantB}',false);
        INSERT INTO tenants(id,name) VALUES ('${tenantB}','B');
        SELECT set_config('app.tenant_id','${tenantA}',false);
        INSERT INTO tenant_platform_limits(tenant_id,max_custom_domains)
          VALUES ('${tenantA}',1);
      `);

      await expect(
        database.query(`SELECT create_custom_domain(
          '${tenantA}','${userA}','${siteA}',gen_random_uuid(),
          'too-long.example.com',repeat('0',64),clock_timestamp() + interval '7 days 6 minutes'
        )`),
      ).rejects.toThrow(/invalid domain challenge expiry/u);

      await database.exec(`
        SELECT create_custom_domain(
          '${tenantA}','${userA}','${siteA}','${domainA}',
          'docs.example.com',repeat('a',64),clock_timestamp() + interval '7 days 2 minutes'
        );
        SELECT create_reader_grant(
          '${tenantA}','${userA}','${siteA}','${grantA}','Reviewers',
          repeat('b',64),now() + interval '1 day',1
        );
        INSERT INTO connectors(
          id,tenant_id,name,protocol_version,public_key,scopes
        ) VALUES (
          '${connectorA}','${tenantA}','Reader fixture','1.0',
          decode(repeat('ab',32),'hex'),'{}'
        );
        INSERT INTO publications(id,tenant_id,site_id,slug)
          VALUES ('${publicationA}','${tenantA}','${siteA}','guide');
        INSERT INTO publication_versions(
          id,tenant_id,publication_id,state,schema_version,content_sha256,
          created_by_connector_id,document,committed_at
        ) VALUES (
          '${versionA}','${tenantA}','${publicationA}','ready','1.0',
          repeat('9',64),'${connectorA}','{}',now()
        );
        UPDATE publications SET current_version_id = '${versionA}'
          WHERE id = '${publicationA}';
        INSERT INTO assets(
          id,tenant_id,sha256,pathname,content_type,byte_size,verified_at
        ) VALUES (
          '${assetA}','${tenantA}',repeat('e',64),
          'tenant-a/source','image/png',1,now()
        );
        INSERT INTO publication_assets(
          tenant_id,publication_version_id,asset_id
        ) VALUES ('${tenantA}','${versionA}','${assetA}');
      `);

      const publicPage = await database.query<{ publication_id: string }>(`
        SELECT publication_id FROM resolve_reader_page('site-a','guide','')
      `);
      expect(publicPage.rows).toEqual([{ publication_id: publicationA }]);
      const publicAsset = await database.query<{ publication_id: string }>(`
        SELECT publication_id FROM resolve_reader_asset(
          'site-a','${publicationA}',repeat('e',64),''
        )
      `);
      expect(publicAsset.rows).toEqual([{ publication_id: publicationA }]);

      const pendingDomain = await database.query<{ site_slug: string }>(`
        SELECT site_slug FROM resolve_custom_domain_site('docs.example.com')
      `);
      expect(pendingDomain.rows).toEqual([]);
      const pendingDomainPage = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_custom_domain_reader_page(
          'docs.example.com','guide',''
        )
      `);
      expect(pendingDomainPage.rows).toEqual([]);
      await database.exec(`
        SELECT record_custom_domain_check(
          '${tenantA}','${userA}','${domainA}',repeat('a',64),true,NULL
        )
      `);
      const verifiedDomain = await database.query<{ site_slug: string }>(`
        SELECT site_slug FROM resolve_custom_domain_site('docs.example.com')
      `);
      expect(verifiedDomain.rows).toEqual([{ site_slug: "site-a" }]);
      const verifiedDomainPage = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_custom_domain_reader_page(
          'docs.example.com','guide',''
        )
      `);
      expect(verifiedDomainPage.rows).toEqual([
        { publication_id: publicationA },
      ]);

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

      await database.exec(
        `SELECT set_config('app.tenant_id','${tenantA}',false)`,
      );
      const redeemed = await database.query<{
        tenant_id: string;
        site_slug: string;
      }>(`SELECT tenant_id,site_slug FROM redeem_reader_grant(
        repeat('b',64),'${sessionA}',repeat('d',64),now() + interval '1 hour',
        'wrong-site'
      )`);
      expect(redeemed.rows).toEqual([]);
      const untouched = await database.query<{
        redemption_count: number;
        sessions: number;
      }>(`
        SELECT reader_grant.redemption_count,
          (SELECT count(*)::int FROM reader_sessions) AS sessions
        FROM reader_grants AS reader_grant
        WHERE reader_grant.id = '${grantA}'
      `);
      expect(untouched.rows).toEqual([{ redemption_count: 0, sessions: 0 }]);

      const matchedRedemption = await database.query<{
        tenant_id: string;
        site_slug: string;
      }>(`SELECT tenant_id,site_slug FROM redeem_reader_grant(
        repeat('b',64),'${sessionA}',repeat('d',64),now() + interval '1 hour',
        'site-a'
      )`);
      expect(matchedRedemption.rows).toEqual([
        { tenant_id: tenantA, site_slug: "site-a" },
      ]);
      await database.exec(
        `UPDATE sites SET reader_access = 'authenticated' WHERE id = '${siteA}'`,
      );
      const anonymousPrivatePage = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_reader_page('site-a','guide','')
      `);
      expect(anonymousPrivatePage.rows).toEqual([]);
      const authenticatedPrivatePage = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_reader_page(
          'site-a','guide',repeat('d',64)
        )
      `);
      expect(authenticatedPrivatePage.rows).toEqual([
        { publication_id: publicationA },
      ]);
      const anonymousPrivateAsset = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_reader_asset(
          'site-a','${publicationA}',repeat('e',64),''
        )
      `);
      expect(anonymousPrivateAsset.rows).toEqual([]);
      const authenticatedPrivateAsset = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_reader_asset(
          'site-a','${publicationA}',repeat('e',64),repeat('d',64)
        )
      `);
      expect(authenticatedPrivateAsset.rows).toEqual([
        { publication_id: publicationA },
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
      `);
      const revoked = await database.query<{ authorized: boolean }>(
        `SELECT reader_session_authorizes('${siteA}',repeat('d',64)) AS authorized`,
      );
      expect(revoked.rows[0]?.authorized).toBe(false);
      const revokedPrivatePage = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_reader_page(
          'site-a','guide',repeat('d',64)
        )
      `);
      expect(revokedPrivatePage.rows).toEqual([]);
      const revokedPrivateAsset = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_reader_asset(
          'site-a','${publicationA}',repeat('e',64),repeat('d',64)
        )
      `);
      expect(revokedPrivateAsset.rows).toEqual([]);
      const disabledDomain = await database.query<{ site_slug: string }>(`
        SELECT site_slug FROM resolve_custom_domain_site('docs.example.com')
      `);
      expect(disabledDomain.rows).toEqual([]);
      const disabledDomainPage = await database.query<{
        publication_id: string;
      }>(`
        SELECT publication_id FROM resolve_custom_domain_reader_page(
          'docs.example.com','guide',repeat('d',64)
        )
      `);
      expect(disabledDomainPage.rows).toEqual([]);

      await expect(
        database.query(`INSERT INTO media_derivative_jobs(
          id,tenant_id,source_asset_id,purpose,output_content_type,max_width,max_height
        ) VALUES (
          gen_random_uuid(),'${tenantA}','${assetA}','thumbnail','image/webp',256,256
        )`),
      ).rejects.toThrow(/media derivatives are not enabled/u);

      await database.exec("RESET ROLE");
      const migrationIdentity = await database.query<{
        current_user: string;
        session_user: string;
        is_superuser: boolean;
      }>(`
        SELECT current_user, session_user, role.rolsuper AS is_superuser
        FROM pg_roles AS role
        WHERE role.rolname = current_user
      `);
      expect(migrationIdentity.rows).toEqual([
        {
          current_user: "knot_migrator",
          session_user: "knot_migrator",
          is_superuser: false,
        },
      ]);

      const resolverSecurity = await database.query<{
        owners: string[];
        can_create: boolean;
        public_can_execute: boolean;
        app_can_execute: boolean;
      }>(`
        SELECT
          ARRAY(
            SELECT DISTINCT pg_get_userbyid(proowner)
            FROM pg_proc
            WHERE proname IN (
              'redeem_reader_grant','reader_session_authorizes','resolve_reader_page',
              'resolve_reader_asset','resolve_custom_domain_reader_page',
              'resolve_custom_domain_site','resolve_reader_site_access'
            )
          ) AS owners,
          has_schema_privilege('knot_resolver', 'public', 'CREATE') AS can_create,
          has_function_privilege(
            'public', 'redeem_reader_grant(text,uuid,text,timestamptz,text)', 'EXECUTE'
          ) AS public_can_execute,
          has_function_privilege(
            'knot_app', 'redeem_reader_grant(text,uuid,text,timestamptz,text)', 'EXECUTE'
          ) AS app_can_execute
      `);
      expect(resolverSecurity.rows).toEqual([
        {
          owners: ["knot_resolver"],
          can_create: false,
          public_can_execute: false,
          app_can_execute: true,
        },
      ]);
    } finally {
      await database.exec("RESET SESSION AUTHORIZATION").catch(() => undefined);
      await database.close();
    }
  });
});
