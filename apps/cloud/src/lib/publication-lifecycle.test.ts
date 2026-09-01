import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "20000000-0000-4000-8000-000000000001";
const connectorA = "10000000-0000-4000-8000-000000000011";
const connectorB = "20000000-0000-4000-8000-000000000011";
const siteA = "10000000-0000-4000-8000-000000000021";
const siteB = "20000000-0000-4000-8000-000000000021";
const publicationA = "10000000-0000-4000-8000-000000000031";
const publicationB = "10000000-0000-4000-8000-000000000032";
const versionA1 = "10000000-0000-4000-8000-000000000041";
const versionA2 = "10000000-0000-4000-8000-000000000042";
const versionB1 = "10000000-0000-4000-8000-000000000043";
const assetA = "10000000-0000-4000-8000-000000000051";
const uploadA = "10000000-0000-4000-8000-000000000061";
const assetBytes = new TextEncoder().encode("verified asset");
const assetDigest = createHash("sha256").update(assetBytes).digest("hex");
const document = { schemaVersion: "1.0", title: "Page", blocks: [] };

describe("publication lifecycle migration", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
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
    const migrationDirectory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "migrations",
    );
    for (const migrationFile of (await readdir(migrationDirectory))
      .filter((name) => /^\d+.*\.sql$/u.test(name))
      .sort()) {
      await database.exec(
        await readFile(path.join(migrationDirectory, migrationFile), "utf8"),
      );
    }
    await database.exec(`
      RESET ROLE;
      INSERT INTO tenants (id, name) VALUES
        ('${tenantA}', 'Tenant A'), ('${tenantB}', 'Tenant B');
      INSERT INTO connectors (
        id, tenant_id, name, protocol_version, public_key, scopes
      ) VALUES
        ('${connectorA}', '${tenantA}', 'A', '1.0', decode(repeat('00', 32), 'hex'),
         '{publications.write,publications.unpublish}'),
        ('${connectorB}', '${tenantB}', 'B', '1.0', decode(repeat('00', 32), 'hex'),
         '{publications.write,publications.unpublish}');
      INSERT INTO sites (id, tenant_id, name, slug) VALUES
        ('${siteA}', '${tenantA}', 'Site A', 'site-a'),
        ('${siteB}', '${tenantB}', 'Site B', 'site-b');
      SET ROLE knot_app;
      SELECT set_config('app.tenant_id', '${tenantA}', false);
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  it("prepares an idempotent upload and verifies it for one site", async () => {
    const pathname = assetPath(tenantA, assetDigest);
    const first = await database.query<{
      upload_id: string;
      asset_id: string;
      duplicate: boolean;
    }>(
      `SELECT upload_id, asset_id, duplicate FROM prepare_asset_upload(
        $1, $2, $3, $4, $5, $6, $7, 'image/png', $8, 'asset.png',
        'asset-upload-key-0001', now() + interval '10 minutes'
      )`,
      [
        tenantA,
        connectorA,
        siteA,
        uploadA,
        assetA,
        assetDigest,
        pathname,
        assetBytes.byteLength,
      ],
    );
    expect(first.rows).toEqual([
      { upload_id: uploadA, asset_id: assetA, duplicate: false },
    ]);

    const retry = await database.query<{
      duplicate: boolean;
      expires_at: Date;
    }>(
      `SELECT duplicate, expires_at FROM prepare_asset_upload(
        $1, $2, $3, $4, $5, $6, $7, 'image/png', $8, 'asset.png',
        'asset-upload-key-0001', now() + interval '10 minutes'
      )`,
      [
        tenantA,
        connectorA,
        siteA,
        uploadA,
        assetA,
        assetDigest,
        pathname,
        assetBytes.byteLength,
      ],
    );
    expect(retry.rows[0]?.duplicate).toBe(true);
    expect(retry.rows[0]?.expires_at.getTime()).toBeGreaterThan(
      Date.now() + 9 * 60_000,
    );

    await expect(
      database.query(
        "SELECT * FROM commit_asset_upload($1, $2, $3, $4, $5, $6, $7)",
        [tenantA, connectorA, uploadA, assetA, "f".repeat(64), 1, "image/png"],
      ),
    ).rejects.toThrow(/does not match/u);
    await expect(
      database.query(
        "SELECT * FROM commit_asset_upload($1, $2, $3, $4, $5, $6, $7)",
        [
          tenantA,
          connectorA,
          uploadA,
          assetA,
          assetDigest,
          assetBytes.byteLength,
          "text/plain",
        ],
      ),
    ).rejects.toThrow(/does not match/u);

    const committed = await database.query<{ asset_id: string }>(
      "SELECT asset_id FROM commit_asset_upload($1, $2, $3, $4, $5, $6, $7)",
      [
        tenantA,
        connectorA,
        uploadA,
        assetA,
        assetDigest,
        assetBytes.byteLength,
        "image/png",
      ],
    );
    expect(committed.rows).toEqual([{ asset_id: assetA }]);
  });

  it("rejects cross-tenant publication mutations before writing state", async () => {
    const foreignDigest = "b".repeat(64);
    const foreignUpload = "20000000-0000-4000-8000-000000000061";
    const foreignAsset = "20000000-0000-4000-8000-000000000051";

    await expect(
      database.query(
        `SELECT * FROM prepare_asset_upload(
          $1, $2, $3, $4, $5, $6, $7, 'image/png', 10, 'foreign.png',
          'foreign-upload-key-0001', now() + interval '10 minutes'
        )`,
        [
          tenantB,
          connectorB,
          siteB,
          foreignUpload,
          foreignAsset,
          foreignDigest,
          assetPath(tenantB, foreignDigest),
        ],
      ),
    ).rejects.toThrow(/active tenant/u);

    const foreignRows = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM asset_uploads WHERE tenant_id = $1",
      [tenantB],
    );
    expect(foreignRows.rows).toEqual([{ count: 0 }]);
  });

  it("activates only after the bundle and every referenced asset verify", async () => {
    await verifyAsset();
    const bundleDigest = digestDocument(document);
    await prepareVersion(versionA1, bundleDigest, "create");

    await expect(
      database.query("SELECT commit_publication_version($1, $2, $3, $4, $5)", [
        tenantA,
        connectorA,
        publicationA,
        versionA1,
        ["f".repeat(64)],
      ]),
    ).rejects.toThrow(/not verified/u);
    await expect(activeVersion()).resolves.toBeUndefined();

    const committed = await database.query<{ state: string }>(
      "SELECT commit_publication_version($1, $2, $3, $4, $5) AS state",
      [tenantA, connectorA, publicationA, versionA1, [assetDigest]],
    );
    expect(committed.rows).toEqual([{ state: "ready" }]);
    await expect(activeVersion()).resolves.toBe(versionA1);

    const retry = await prepareVersion(versionA1, bundleDigest, "create");
    expect(retry.rows).toEqual([
      {
        bundle_path: bundlePath(tenantA, publicationA, versionA1, bundleDigest),
        duplicate: true,
        publication_id: publicationA,
        version_id: versionA1,
        version_state: "ready",
      },
    ]);
  });

  it("binds publication idempotency to the site, slug, and operation", async () => {
    const bundleDigest = digestDocument(document);
    await prepareVersion(versionA1, bundleDigest, "create");
    await expect(
      database.query(
        `SELECT * FROM prepare_publication_version(
          $1, $2, $3, $4, $5, 'different-page', 'create', '1.0',
          $6, $7, $8::jsonb, $9
        )`,
        [
          tenantA,
          connectorA,
          siteA,
          publicationA,
          versionA1,
          bundleDigest,
          bundlePath(tenantA, publicationA, versionA1, bundleDigest),
          JSON.stringify(document),
          `publication-key-${versionA1.slice(-4)}`,
        ],
      ),
    ).rejects.toThrow(/Idempotency key conflicts/u);
  });

  it("disables, rolls back, and tombstones before deleting private bytes", async () => {
    await verifyAsset();
    const firstDigest = digestDocument(document);
    await prepareVersion(versionA1, firstDigest, "create");
    await commitVersion(versionA1);
    const secondDocument = { ...document, title: "Page v2" };
    await prepareVersion(
      versionA2,
      digestDocument(secondDocument),
      "update",
      secondDocument,
    );
    await commitVersion(versionA2);
    await expect(activeVersion()).resolves.toBe(versionA2);

    await database.query("SELECT disable_publication($1, $2)", [
      tenantA,
      publicationA,
    ]);
    await expect(activeVersion()).resolves.toBeUndefined();

    await database.query("SELECT rollback_publication($1, $2, $3)", [
      tenantA,
      publicationA,
      versionA1,
    ]);
    await expect(activeVersion()).resolves.toBe(versionA1);

    const tombstone = await database.query<{ at: Date }>(
      "SELECT unpublish_publication($1, $2) AS at",
      [tenantA, publicationA],
    );
    expect(tombstone.rows[0]?.at).toBeInstanceOf(Date);
    await expect(activeVersion()).resolves.toBeUndefined();

    const retry = await database.query<{ at: Date }>(
      "SELECT unpublish_publication($1, $2) AS at",
      [tenantA, publicationA],
    );
    expect(retry.rows[0]?.at).toEqual(tombstone.rows[0]?.at);
    const pending = await database.query<{ pathname: string }>(
      `SELECT pathname FROM deletion_outbox
       WHERE tenant_id = $1 AND publication_id = $2 AND completed_at IS NULL`,
      [tenantA, publicationA],
    );
    expect(pending.rows).toHaveLength(3);
    expect(pending.rows.map((row) => row.pathname)).toContain(
      assetPath(tenantA, assetDigest),
    );
  });

  it("fences deletion attempts, retries safely, and finalizes after all objects delete", async () => {
    await verifyAsset();
    const bundleDigest = digestDocument(document);
    await prepareVersion(versionA1, bundleDigest, "create");
    await commitVersion(versionA1);
    await database.query("SELECT unpublish_publication($1, $2)", [
      tenantA,
      publicationA,
    ]);
    const initialMaintenance = await database.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM list_publication_maintenance_tenants(now(), 3600, 10)",
    );
    expect(initialMaintenance.rows).toEqual([{ tenant_id: tenantA }]);

    const leaseA = "a".repeat(64);
    const leaseB = "b".repeat(64);
    const claimed = await database.query<{
      outbox_id: string;
      pathname: string;
      attempt: number;
    }>(
      "SELECT outbox_id, pathname, attempt FROM claim_deletion_outbox($1, now(), $2, 30, 10)",
      [tenantA, leaseA],
    );
    expect(claimed.rows).toHaveLength(2);
    expect(claimed.rows.every((row) => row.attempt === 1)).toBe(true);

    const first = claimed.rows[0]!;
    const wrongLease = await database.query<{ ok: boolean }>(
      "SELECT complete_deletion_outbox($1, $2, $3, now()) AS ok",
      [tenantA, first.outbox_id, leaseB],
    );
    expect(wrongLease.rows).toEqual([{ ok: false }]);
    const retried = await database.query<{ ok: boolean }>(
      "SELECT retry_deletion_outbox($1, $2, $3, now(), 1, 'r2-delete-failed') AS ok",
      [tenantA, first.outbox_id, leaseA],
    );
    expect(retried.rows).toEqual([{ ok: true }]);

    for (const row of claimed.rows.slice(1)) {
      await database.query(
        "SELECT complete_deletion_outbox($1, $2, $3, now())",
        [tenantA, row.outbox_id, leaseA],
      );
    }
    const rescheduled = await database.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM list_publication_maintenance_tenants(now(), 3600, 10)",
    );
    expect(rescheduled.rows).toEqual([{ tenant_id: tenantA }]);
    const tooEarly = await database.query<{ done: boolean }>(
      "SELECT finalize_unpublished_publication($1, $2) AS done",
      [tenantA, publicationA],
    );
    expect(tooEarly.rows).toEqual([{ done: false }]);

    await database.exec("SELECT pg_sleep(1.01)");
    const reclaimed = await database.query<{ outbox_id: string }>(
      "SELECT outbox_id FROM claim_deletion_outbox($1, now(), $2, 30, 10)",
      [tenantA, leaseB],
    );
    expect(reclaimed.rows).toEqual([{ outbox_id: first.outbox_id }]);
    await database.query("SELECT complete_deletion_outbox($1, $2, $3, now())", [
      tenantA,
      first.outbox_id,
      leaseB,
    ]);
    const finalized = await database.query<{ done: boolean }>(
      "SELECT finalize_unpublished_publication($1, $2) AS done",
      [tenantA, publicationA],
    );
    expect(finalized.rows).toEqual([{ done: true }]);
    await expect(activeVersion()).resolves.toBeUndefined();
  });

  it("does not enqueue shared live assets when another publication still uses them", async () => {
    await verifyAsset();
    const digest = digestDocument(document);
    await prepareVersion(versionA1, digest, "create");
    await commitVersion(versionA1);
    await prepareVersionFor({
      publicationId: publicationB,
      versionId: versionB1,
      digest,
      operation: "create",
      slug: "page-b",
    });
    await database.query(
      "SELECT commit_publication_version($1, $2, $3, $4, $5)",
      [tenantA, connectorA, publicationB, versionB1, [assetDigest]],
    );

    await database.query("SELECT unpublish_publication($1, $2)", [
      tenantA,
      publicationA,
    ]);
    const assetRows = await database.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM deletion_outbox
       WHERE tenant_id = $1 AND publication_id = $2 AND asset_id = $3
         AND completed_at IS NULL`,
      [tenantA, publicationA, assetA],
    );
    expect(assetRows.rows).toEqual([{ count: 0 }]);
  });

  it("rejects activation while a reused digest is fenced for deletion", async () => {
    await verifyAsset();
    const digest = digestDocument(document);
    await prepareVersion(versionA1, digest, "create");
    await commitVersion(versionA1);
    await database.query("SELECT unpublish_publication($1, $2)", [
      tenantA,
      publicationA,
    ]);
    await prepareVersionFor({
      publicationId: publicationB,
      versionId: versionB1,
      digest,
      operation: "create",
      slug: "page-b",
    });
    await expect(
      database.query("SELECT commit_publication_version($1, $2, $3, $4, $5)", [
        tenantA,
        connectorA,
        publicationB,
        versionB1,
        [assetDigest],
      ]),
    ).rejects.toThrow(/pending deletion/u);
  });

  it("dead-letters poison deletions and leaves the publication visibly unfinalized", async () => {
    await verifyAsset();
    const digest = digestDocument(document);
    await prepareVersion(versionA1, digest, "create");
    await commitVersion(versionA1);
    await database.query("SELECT unpublish_publication($1, $2)", [
      tenantA,
      publicationA,
    ]);
    const lease = "c".repeat(64);
    const startedAt = Date.now();
    const target = await database.query<{ id: string }>(
      `SELECT id FROM deletion_outbox
       WHERE tenant_id = $1 AND publication_id = $2
       ORDER BY created_at, id LIMIT 1`,
      [tenantA, publicationA],
    );
    const targetId = target.rows[0]!.id;
    await database.query(
      `UPDATE deletion_outbox SET next_attempt_at = now() + interval '1 day'
       WHERE tenant_id = $1 AND publication_id = $2 AND id <> $3`,
      [tenantA, publicationA, targetId],
    );
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const claimAt = new Date(startedAt + attempt * 2_000);
      const claimed = await database.query<{ outbox_id: string }>(
        "SELECT outbox_id FROM claim_deletion_outbox($1, $2, $3, 30, 1)",
        [tenantA, claimAt, lease],
      );
      expect(claimed.rows[0]?.outbox_id).toBe(targetId);
      await database.query(
        "SELECT retry_deletion_outbox($1, $2, $3, $4, 1, 'r2-delete-failed')",
        [tenantA, targetId, lease, new Date(claimAt.getTime() + 500)],
      );
    }
    const dead = await database.query<{ dead_lettered_at: Date }>(
      "SELECT dead_lettered_at FROM deletion_outbox WHERE id = $1",
      [targetId],
    );
    expect(dead.rows[0]?.dead_lettered_at).toBeInstanceOf(Date);
    const reclaimed = await database.query<{ outbox_id: string }>(
      "SELECT outbox_id FROM claim_deletion_outbox($1, $2, $3, 30, 10)",
      [tenantA, new Date(startedAt + 30_000), lease],
    );
    expect(reclaimed.rows.some((row) => row.outbox_id === targetId)).toBe(
      false,
    );
    const finalized = await database.query<{ done: boolean }>(
      "SELECT finalize_unpublished_publication($1, $2) AS done",
      [tenantA, publicationA],
    );
    expect(finalized.rows).toEqual([{ done: false }]);
  });

  it("discovers scheduled tenants and enqueues abandoned upload bytes", async () => {
    const pathname = assetPath(tenantA, "e".repeat(64));
    await database.query(
      `SELECT * FROM prepare_asset_upload(
        $1, $2, $3, $4, $5, $6, $7, 'image/png', 10, 'orphan.png',
        'orphan-upload-key-0001', now() + interval '1 minute'
      )`,
      [
        tenantA,
        connectorA,
        siteA,
        "10000000-0000-4000-8000-000000000062",
        "10000000-0000-4000-8000-000000000052",
        "e".repeat(64),
        pathname,
      ],
    );
    const dueAt = new Date(Date.now() + 2 * 60_000);
    const tenants = await database.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM list_publication_maintenance_tenants($1, 3600, 10)",
      [dueAt],
    );
    expect(tenants.rows).toEqual([{ tenant_id: tenantA }]);
    await database.query(
      "SELECT enqueue_publication_orphan_deletions($1, $2, 3600, 10)",
      [tenantA, new Date(dueAt.getTime() + 3_600_000)],
    );
    const queued = await database.query<{ pathname: string }>(
      `SELECT pathname FROM deletion_outbox
       WHERE tenant_id = $1 AND pathname = $2 AND completed_at IS NULL`,
      [tenantA, pathname],
    );
    expect(queued.rows).toEqual([{ pathname }]);
  });

  async function verifyAsset() {
    const pathname = assetPath(tenantA, assetDigest);
    await database.query(
      `SELECT * FROM prepare_asset_upload(
        $1, $2, $3, $4, $5, $6, $7, 'image/png', $8, 'asset.png',
        'asset-upload-key-0001', now() + interval '10 minutes'
      )`,
      [
        tenantA,
        connectorA,
        siteA,
        uploadA,
        assetA,
        assetDigest,
        pathname,
        assetBytes.byteLength,
      ],
    );
    await database.query(
      "SELECT * FROM commit_asset_upload($1, $2, $3, $4, $5, $6, $7)",
      [
        tenantA,
        connectorA,
        uploadA,
        assetA,
        assetDigest,
        assetBytes.byteLength,
        "image/png",
      ],
    );
  }

  function prepareVersion(
    versionId: string,
    contentDigest: string,
    operation: "create" | "update",
    content = document,
  ) {
    return prepareVersionFor({
      publicationId: publicationA,
      versionId,
      digest: contentDigest,
      operation,
      content,
    });
  }

  function prepareVersionFor(input: {
    publicationId: string;
    versionId: string;
    digest: string;
    operation: "create" | "update";
    slug?: string;
    content?: typeof document;
  }) {
    const content = input.content ?? document;
    return database.query<{
      publication_id: string;
      version_id: string;
      bundle_path: string;
      version_state: string;
      duplicate: boolean;
    }>(
      `SELECT * FROM prepare_publication_version(
        $1, $2, $3, $4, $5, $6, $7, '1.0', $8, $9, $10::jsonb, $11
      )`,
      [
        tenantA,
        connectorA,
        siteA,
        input.publicationId,
        input.versionId,
        input.slug ?? "page",
        input.operation,
        input.digest,
        bundlePath(tenantA, input.publicationId, input.versionId, input.digest),
        JSON.stringify(content),
        `publication-key-${input.versionId.slice(-4)}`,
      ],
    );
  }

  async function commitVersion(versionId: string) {
    await database.query(
      "SELECT commit_publication_version($1, $2, $3, $4, $5)",
      [tenantA, connectorA, publicationA, versionId, [assetDigest]],
    );
  }

  async function activeVersion(): Promise<string | undefined> {
    const result = await database.query<{ current_version_id: string }>(
      `SELECT current_version_id FROM publications
       WHERE tenant_id = $1 AND id = $2
         AND disabled_at IS NULL AND unpublished_at IS NULL`,
      [tenantA, publicationA],
    );
    return result.rows[0]?.current_version_id ?? undefined;
  }
});

function digestDocument(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assetPath(tenantId: string, sha256: string): string {
  return `tenants/${tenantId}/assets/${sha256.slice(0, 2)}/${sha256}`;
}

function bundlePath(
  tenantId: string,
  publicationId: string,
  versionId: string,
  sha256: string,
): string {
  return `tenants/${tenantId}/publications/${publicationId}/versions/${versionId}/${sha256}.json`;
}
