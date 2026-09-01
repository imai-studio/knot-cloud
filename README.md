# Knot Cloud

Knot Cloud is the remote service for local [Knot](https://github.com/imai-studio/knot)
installations. It will coordinate connectors, publish selected Anytype content, and expose a typed
Anytype data API. Local Knot remains the authority for access to Anytype and the operator's machine.

## Release status

The imai-operated P0 foundation is deployed at [knot.imai.tech](https://knot.imai.tech). It provides
an invitation-only operator console, `GET /api/health`, and `GET /api/v1/meta`. The application also
builds as a standalone container for self-hosting.

The following features are not released:

- connector pairing and command delivery;
- publication upload and public reader pages;
- consumer API keys and the Anytype data API;
- a local connector configured to use Knot Cloud.

The health and metadata endpoints are diagnostic. They do not provide an Anytype data API. See
[`docs/releases.md`](docs/releases.md) for the release contract and
[`docs/implementation-roadmap.md`](docs/implementation-roadmap.md) for planned work.

## Architecture

The deployed application uses:

| Service         | Provider      | Purpose                                      |
| --------------- | ------------- | -------------------------------------------- |
| Web application | Vercel        | Operator console and diagnostic endpoints    |
| PostgreSQL      | Neon          | Authentication and tenant-scoped state       |
| Object storage  | Cloudflare R2 | Private object storage and deployment checks |
| Email           | Resend        | Passwordless sign-in links                   |

The application accesses R2 through the AWS S3 client. It does not use Vercel Blob. The current
adapter is specific to Cloudflare R2. A general S3-compatible adapter remains planned.

Public reader pages need a separate registrable domain from the operator console. No domain has
been selected, so public publishing remains blocked. The implementation candidate fails closed
until `CONTENT_BASE_URL` is configured. See
[`docs/public-reader.md`](docs/public-reader.md).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for request paths and trust boundaries.

## Local development

Requirements: Node.js 24 or newer and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run dev
```

The operator console uses invitation-only email links. `https://knot.imai.studio` remains a trusted
compatibility origin for the imai deployment.

## Configuration

The console requires `AUTH_BASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `EMAIL_FROM`,
`IDENTITY_DIGEST_PEPPER`, `KNOT_ALLOWED_EMAILS`, and `RESEND_API_KEY`. Set
`AUTH_TRUSTED_ORIGINS` to a comma-separated list
when the same deployment is served from additional domains. `KNOT_ALLOWED_EMAILS` is a
comma-separated operator allowlist; removing an address revokes its dashboard access on the next
request. Keep the Resend key sending-only and restrict it to the configured sender domain. Never
commit any of these values. See
[`docs/workspace-authorization.md`](docs/workspace-authorization.md) for the human session and tenant
boundary.

Signed connector routes require an Upstash Redis database for nonce replay protection and connector
rate limits. Configure `REPLAY_STORE_DRIVER=upstash` plus either the explicit
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

- [`ARCHITECTURE.md`](ARCHITECTURE.md): deployed and planned request paths.
- [`docs/threat-model.md`](docs/threat-model.md): assets, trust boundaries, threats, and controls.
- [`docs/database-provisioning.md`](docs/database-provisioning.md): migration and runtime database
  credentials.
- [`docs/connector-pairing.md`](docs/connector-pairing.md): unreleased pairing candidate and its
  security boundary.
- [`docs/workspace-authorization.md`](docs/workspace-authorization.md): human sessions, workspace
  bootstrap, and tenant selection.
- [`docs/deployment.md`](docs/deployment.md): deployment and provider preflight steps.
- [`docs/object-storage.md`](docs/object-storage.md): private R2 keys, verification, and deletion.
- [`docs/publication-lifecycle.md`](docs/publication-lifecycle.md): unreleased publication upload,
  controls, provenance, and deletion behavior.
- [`docs/public-reader.md`](docs/public-reader.md): isolated reader routes and Vercel/self-hosted
  deployment checks.
- [`docs/p0-exit-criteria.md`](docs/p0-exit-criteria.md): completed and open P0 gates.
- [`docs/p0-verification.md`](docs/p0-verification.md): test and deployment evidence.
- [`docs/implementation-roadmap.md`](docs/implementation-roadmap.md): dependency-ordered planned
  work.
- [`docs/releases.md`](docs/releases.md): released behavior.

## Repositories

- [`imai-studio/knot`](https://github.com/imai-studio/knot): local Anytype gateway and agent runtime
  connector.
- [`imai-studio/knot-cloud`](https://github.com/imai-studio/knot-cloud): this remote service.
