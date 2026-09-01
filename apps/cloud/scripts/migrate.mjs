import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { validateMigrationPlan } from "./migration-plan.mjs";

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "MIGRATION_DATABASE_URL is required and must use the owner/migrator role",
  );
}

const directory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);
const migrationFiles = (await readdir(directory))
  .filter((name) => /^\d+.*\.sql$/u.test(name))
  .sort();
const migrationHost = new URL(databaseUrl).hostname;
const localMigration = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
  migrationHost,
);
const sql = postgres(databaseUrl, {
  max: 1,
  ssl: localMigration
    ? false
    : { rejectUnauthorized: true, servername: migrationHost },
});

try {
  await sql`SELECT pg_advisory_lock(hashtext('knot-cloud-migrations'))`;
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const appliedMigrations = await sql`
    SELECT name, sha256 FROM schema_migrations ORDER BY name
  `;
  validateMigrationPlan(migrationFiles, appliedMigrations);

  for (const applied of appliedMigrations) {
    const source = await readFile(path.join(directory, applied.name), "utf8");
    const sha256 = createHash("sha256").update(source).digest("hex");
    if (applied.sha256 !== sha256) {
      throw new Error(`Applied migration ${applied.name} has changed`);
    }
  }

  for (const name of migrationFiles) {
    const source = await readFile(path.join(directory, name), "utf8");
    const sha256 = createHash("sha256").update(source).digest("hex");
    await sql.begin(async (transaction) => {
      const existing = await transaction`
        SELECT sha256 FROM schema_migrations WHERE name = ${name}
      `;
      if (existing[0]) return;
      await transaction.unsafe(source);
      await transaction`
        INSERT INTO schema_migrations (name, sha256) VALUES (${name}, ${sha256})
      `;
    });
  }
  await sql.unsafe("REVOKE ALL ON schema_migrations FROM knot_app");
} finally {
  await sql`SELECT pg_advisory_unlock(hashtext('knot-cloud-migrations'))`.catch(
    () => undefined,
  );
  await sql.end();
}
