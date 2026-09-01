# Knot Cloud

Knot Cloud is the remote control and publishing service under construction for local Knot
installations. The imai-operated P0 deployment runs on Vercel with Neon, private Cloudflare R2, and
Resend. The same Next.js application builds as a standalone container for self-hosting.

> **Implementation status:** the P0 foundation and invitation-only operator console are deployed.
> Connector pairing, public publishing, consumer API keys, and the Anytype data API are not
> released. The health and protocol metadata endpoints are diagnostic endpoints, not a usable data
> API.

## P0 contents

- a provider-neutral, versioned protocol package;
- typed publication and Anytype operation schemas;
- canonical Ed25519 request signing and replay-safe request metadata;
- command and lease contracts;
- a Next.js App Router service skeleton for Vercel and standalone containers;
- an invitation-only, passwordless operator console with isolated auth tables and a restricted
  database runtime role;
- lazy Neon, private Cloudflare R2, and Upstash adapters behind explicit provider factories;
- a tenant-scoped PostgreSQL schema with composite foreign keys, forced row-level security, and a
  restricted runtime role;
- threat-model and P0 exit documentation;
- protocol and adversarial tests.

## Development

Requirements: Node.js 24 or newer and pnpm 11.

```bash
pnpm install
pnpm run check
pnpm run dev
```

The operator console is available at `https://knot.imai.tech` and uses invitation-only email magic
links. `https://knot.imai.studio` remains a trusted compatibility origin. The metadata endpoint is
`GET /api/v1/meta`; liveness is `GET /api/health`.

The imai deployment uses Neon, a private Cloudflare R2 bucket, and a domain-restricted Resend
sending key. Knot accesses R2 with the AWS S3 client. It does not use Vercel Blob. The current
object-store adapter is R2-specific even though R2 implements the S3 protocol. A general
S3-compatible adapter for self-hosters remains planned. Upstash is not provisioned because no
released signed mutation route needs replay storage yet.

The public-content hostname is unresolved. Hosted reader pages must use a separate registrable
domain from the operator console before publishing can ship. `CONTENT_BASE_URL` is a configuration
boundary, not an approved production content domain.

The console requires `AUTH_BASE_URL`, `AUTH_SECRET`, `EMAIL_FROM`, `KNOT_ALLOWED_EMAILS`, and
`RESEND_API_KEY`. Set `AUTH_TRUSTED_ORIGINS` to a comma-separated list when the same deployment is
served from additional domains. `KNOT_ALLOWED_EMAILS` is a comma-separated operator allowlist;
removing an address revokes its dashboard access on the next request. Keep the Resend key
sending-only and restrict it to the configured sender domain. Never commit any of these values.

Run `pnpm --filter @imai/knot-cloud migrate` from a trusted checkout using the owner credential in a
shell-local `MIGRATION_DATABASE_URL`; never deploy that variable to Vercel or an application
container. The application `DATABASE_URL` must authenticate directly as the restricted `knot_app`
role. Self-hosters may run the Dockerfile's dedicated `migrator` target with the owner credential
and the `runner` target with only the restricted runtime credential.

See [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`docs/threat-model.md`](docs/threat-model.md),
[`docs/database-provisioning.md`](docs/database-provisioning.md),
[`docs/p0-exit-criteria.md`](docs/p0-exit-criteria.md), and
[`docs/p0-verification.md`](docs/p0-verification.md) for the current security boundary and evidence.

[`docs/implementation-roadmap.md`](docs/implementation-roadmap.md) lists the dependency order for
unreleased work. [`docs/releases.md`](docs/releases.md) is the source of truth for shipped behavior.

## Repositories

- `imai-studio/knot`: local Anytype Gateway and agent runtime connector.
- `imai-studio/knot-cloud`: this control and publishing plane.
