# Knot Cloud

Knot Cloud is the remote control and publishing plane under construction for local Knot
installations. The imai-operated P0 reference foundation runs on Vercel with Neon and private
Cloudflare R2. The standalone image and provider ports remain the foundation for self-hosting;
additional object-store and replay-store adapters are not implemented yet.

> **Implementation status:** the production P0 foundation and invitation-only operator console are
> deployed. Public publishing routes and the released local connector are not implemented yet. The
> hosted health and protocol metadata endpoints do not constitute a usable public API.

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
`GET /api/v1/meta`; liveness is `GET /api/health`. The imai
deployment uses Neon, a private Cloudflare R2 bucket, and a domain-restricted Resend sending key.
Redis remains unprovisioned because no released route uses it yet.

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

See [`docs/threat-model.md`](docs/threat-model.md),
[`docs/database-provisioning.md`](docs/database-provisioning.md),
[`docs/p0-exit-criteria.md`](docs/p0-exit-criteria.md), and
[`docs/p0-verification.md`](docs/p0-verification.md) for the current security boundary and evidence.

## Repositories

- `imai-studio/knot`: local Anytype Gateway and agent runtime connector.
- `imai-studio/knot-cloud`: this control and publishing plane.
