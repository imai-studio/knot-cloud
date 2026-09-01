# Deployment runbook

This runbook covers the current P0 foundation on Vercel with Neon and private Cloudflare R2. It
does not publish content or install a local connector.

## Prerequisites

- Node.js 24 and pnpm 11
- a Vercel project for `apps/cloud`
- a Neon database with separate owner and `knot_app` credentials
- a private Cloudflare R2 bucket and bucket-scoped S3 credentials
- a Resend sending key restricted to the configured sender domain

Do not provision a public R2 URL or content hostname. Public content needs a separate registrable
domain and renderer decision before release.

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

Configure R2 by following [`object-storage.md`](object-storage.md). Keep both public access methods
disabled on the bucket. `CONTENT_BASE_URL` is not part of the current environment contract.

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
private tenant-scoped R2 object.

## Deploy

Build and deploy the monorepo from its root. The Vercel project should use Node.js 24 and keep the
application region aligned with the Neon region. The production prebuild runs the same provider
smoke test before compiling Next.js.

After deployment, verify:

```bash
curl --fail --show-error https://<dashboard-host>/api/health
curl --fail --show-error https://<dashboard-host>/api/v1/meta
```

Confirm that the R2 smoke object was deleted and that the bucket still has no `r2.dev` URL or custom
domain. Record the deployment and check results in [`p0-verification.md`](p0-verification.md).
