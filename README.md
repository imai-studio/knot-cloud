# Knot Cloud

Knot Cloud is the remote service for local [Knot](https://github.com/imai-studio/knot)
installations. It coordinates connectors, publishes selected Anytype content, and exposes a typed
Anytype data API. Local Knot remains the authority for access to Anytype and the operator's machine.

## Release status

The imai-operated service runs at [knot.imai.tech](https://knot.imai.tech). Public pages and media
use the isolated reader origin at [pages.imai.studio](https://pages.imai.studio). The same
application builds as a standalone container for self-hosting.

The released service supports:

- one-time pairing, signed command transport, connector review, rename, and revoke;
- typed publications with direct R2 asset upload, version history, rollback, disable, and terminal
  unpublish;
- scoped API keys for the closed Anytype operation union;
- public and grant-protected reader sites, custom-domain verification, quotas, and audit records;
- transactional channel events to webhook destinations approved in deployment configuration.

Hosted connectors, billing, and media transformation execution remain disabled. See
[`docs/releases.md`](docs/releases.md) for the release record and
[`docs/implementation-roadmap.md`](docs/implementation-roadmap.md) for the work that remains.

## Architecture

The deployed application uses:

| Service         | Provider      | Purpose                                        |
| --------------- | ------------- | ---------------------------------------------- |
| Web application | Vercel        | Console, connector API, and isolated reader    |
| PostgreSQL      | Neon          | Authentication and tenant-scoped state         |
| Object storage  | Cloudflare R2 | Private publication assets and version bundles |
| Rate limits     | Upstash Redis | Connector and pairing abuse limits             |
| Email           | Resend        | Passwordless sign-in links                     |

The application accesses R2 through the AWS S3 client. It does not use Vercel Blob. The current
adapter is specific to Cloudflare R2. A general S3-compatible adapter remains planned.

The managed deployment uses `pages.imai.studio` as its separate reader domain. Self-hosted
operators must set `CONTENT_BASE_URL` to a different registrable domain from `APP_BASE_URL`. Reader
routes fail closed when that boundary is missing. See [`docs/public-reader.md`](docs/public-reader.md).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for request paths and trust boundaries.

## Local development

Requirements: Node.js 24 or newer and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run dev
```

The operator console uses invitation-only email links.

## Configuration

The console requires `AUTH_BASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `EMAIL_FROM`,
`IDENTITY_DIGEST_PEPPER`, `KNOT_ALLOWED_EMAILS`, `API_KEY_PEPPER`,
`API_KEY_PEPPER_VERSION`, and `RESEND_API_KEY`. Set
`AUTH_TRUSTED_ORIGINS` to a comma-separated list
when the same deployment is served from additional domains. `KNOT_ALLOWED_EMAILS` is a
comma-separated operator allowlist; removing an address revokes its dashboard access on the next
request. Keep the Resend key sending-only and restrict it to the configured sender domain. Never
commit any of these values. See
[`docs/workspace-authorization.md`](docs/workspace-authorization.md) for the human session and tenant
boundary.

Signed connector routes claim replay nonces in Postgres. Upstash is used only for connector
rate limits. Configure `CONNECTOR_RATE_LIMIT_STORE_DRIVER=upstash` plus either the explicit
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` pair or Vercel's official integration pair,
`KV_REST_API_URL`/`KV_REST_API_TOKEN`. Explicit `UPSTASH_*` values take precedence; do not set only
one value from either pair.

Apply migrations from a trusted checkout:

```bash
pnpm --filter @imai/knot-cloud migrate
```

Set `MIGRATION_DATABASE_URL` only in the operator shell or dedicated `migrator` container. Never
deploy it to Vercel or the application container. `DATABASE_URL` must authenticate directly as the
restricted `knot_app` role. See
[`docs/database-provisioning.md`](docs/database-provisioning.md) for the credential boundary.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): deployed request paths and trust boundaries.
- [`docs/threat-model.md`](docs/threat-model.md): assets, trust boundaries, threats, and controls.
- [`docs/database-provisioning.md`](docs/database-provisioning.md): migration and runtime database
  credentials.
- [`docs/connector-pairing.md`](docs/connector-pairing.md): pairing and its security boundary.
- [`docs/workspace-authorization.md`](docs/workspace-authorization.md): human sessions, workspace
  bootstrap, and tenant selection.
- [`docs/deployment.md`](docs/deployment.md): deployment and provider preflight steps.
- [`docs/object-storage.md`](docs/object-storage.md): private R2 keys, verification, and deletion.
- [`docs/publication-lifecycle.md`](docs/publication-lifecycle.md): publication upload, controls,
  provenance, and deletion behavior.
- [`docs/public-reader.md`](docs/public-reader.md): isolated reader routes and Vercel/self-hosted
  deployment checks.
- [`docs/scoped-data-api.md`](docs/scoped-data-api.md): P4 key controls, typed operation submission,
  and status retrieval.
- [`docs/platform-extensions.md`](docs/platform-extensions.md): custom-domain, authenticated-reader,
  quota, and disabled provider boundaries.
- [`docs/p0-exit-criteria.md`](docs/p0-exit-criteria.md): historical P0 gates.
- [`docs/p0-verification.md`](docs/p0-verification.md): historical P0 evidence.
- [`docs/implementation-roadmap.md`](docs/implementation-roadmap.md): delivered phases and remaining
  work.
- [`docs/releases.md`](docs/releases.md): released behavior.

## Repositories

- [`imai-studio/knot`](https://github.com/imai-studio/knot): local Anytype gateway and agent runtime
  connector.
- [`imai-studio/knot-cloud`](https://github.com/imai-studio/knot-cloud): this remote service.
