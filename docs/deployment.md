# Deployment runbook

This runbook covers the released P0 foundation and the unreleased publication candidate on Vercel
with Neon and private Cloudflare R2. Release status remains authoritative in `releases.md`.

## Prerequisites

- Node.js 24 and pnpm 11
- a Vercel project for `apps/cloud`
- a Neon database with separate owner and `knot_app` credentials
- a private Cloudflare R2 bucket and bucket-scoped S3 credentials
- a Resend sending key restricted to the configured sender domain

Do not provision a public R2 URL. Before enabling the publication candidate, select a separate
registrable content domain and follow [`public-reader.md`](public-reader.md).

## Apply the database migration

Follow [`database-provisioning.md`](database-provisioning.md). Keep `MIGRATION_DATABASE_URL` in a
trusted operator shell. Do not add it to Vercel or a running container.

```bash
MIGRATION_DATABASE_URL='<owner-url>' pnpm --filter @imai/knot-cloud migrate
```

Use the migration-created `knot_app` credential as `DATABASE_URL`.

## Configure the application

Start from [`apps/cloud/.env.example`](../apps/cloud/.env.example). Generate independent random
values for every secret and pepper. Do not copy the example placeholders into production.

Set `CRON_SECRET` to a dedicated random value of at least 32 characters. Vercel sends it as a
bearer credential to the scheduled publication-maintenance route. Self-hosted schedulers must call
the same route with `Authorization: Bearer <CRON_SECRET>`. Do not reuse `AUTH_SECRET` or an API-key
pepper.

Configure R2 by following [`object-storage.md`](object-storage.md). Keep both public access methods
disabled on the bucket. Leave `CONTENT_BASE_URL` unset until the isolated reader deployment and
domain are ready. Reader routes fail closed while it is absent.

## Verify the candidate

Run all repository checks before deployment:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

With the production variables loaded in a trusted shell, run the provider smoke test:

```bash
pnpm --filter @imai/knot-cloud smoke:providers
```

The smoke test rejects an elevated database runtime role. It also writes, verifies, and removes one
private tenant-scoped R2 object. Run it against the exact Neon, R2, and rate-limit credentials
configured for the candidate before promotion.

For publication candidates, also exercise the real presigned-upload path against the candidate R2
bucket: request a one-byte `application/octet-stream` asset upload from an authorized connector,
perform the returned `PUT` with every returned required header, commit the upload, and verify that
the API reports `verified`. Delete the test publication afterward and drain maintenance. This
proves that R2 preserved the signed `sha256`, `tenant-id`, `kind`, and `byte-size` metadata; a local
URL-shape test is not sufficient. Record the request ID and outcome, never the URL or credentials.

## Deploy

Build and deploy the monorepo from its root. The Vercel project should use Node.js 24 and keep the
application region aligned with the Neon region. The production prebuild runs the same provider
smoke test before compiling Next.js.

After deployment, verify:

```bash
curl --fail --show-error https://<dashboard-host>/api/health
curl --fail --show-error https://<dashboard-host>/api/v1/meta
```

When publication lifecycle code is part of the candidate, invoke
`/api/internal/publications/maintenance` once with the cron bearer credential. A successful empty
pass returns `200`; a `500` indicates a tenant failure or a deletion dead letter and must block
promotion.

Confirm that the R2 smoke object was deleted and that the bucket still has no `r2.dev` URL or custom
domain. Record the deployment and check results in [`p0-verification.md`](p0-verification.md).

For a publication candidate, also run the origin-isolation, CSP, cookie, page, media, disable,
rollback, destructive-unpublish, and deletion-drain checks in
[`public-reader.md`](public-reader.md). Do not record P3 as released until those checks pass on the
selected content domain.

## Managed Neon RLS probe

Run this with the exact production `knot_app` credential before promotion, never the migration
owner. The first query must report `off`, `on`, `false`; every listed relation must report both RLS
columns as `true`; and the final query must return `0` without setting `app.tenant_id`.

```sql
SELECT current_setting('is_superuser') AS superuser,
       current_setting('row_security') AS row_security,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls;

SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname IN (
  'webhook_subscriptions', 'transactional_events', 'webhook_deliveries',
  'tenant_platform_limits', 'custom_domains', 'reader_grants', 'reader_sessions',
  'media_derivative_jobs', 'connector_request_nonces'
)
ORDER BY relname;

SELECT set_config('app.tenant_id', '', false);
SELECT count(*) FROM connector_request_nonces;
```

Record only the booleans and row count. Never paste the connection URL or tenant data into a
ticket, build log, or model prompt.
