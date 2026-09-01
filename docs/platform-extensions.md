# Reader access, domains, and platform limits

Status: custom domains, reader grants, reader sessions, workspace limits, and audit records are
released. Hosted connectors, billing, and media transformation execution remain disabled. Their
tables and provider boundaries do not make those runtimes available.

## Custom domains

An owner or admin attaches a bare hostname to one site. Knot returns an exact DNS TXT challenge at
`_knot.<hostname>`. The operator adds that record through their DNS provider and asks Knot to check
it. Knot performs only a TXT lookup; it never changes DNS records.

`DOMAIN_CHALLENGE_SECRET` must contain at least 32 random characters and must be independent from
authentication and API-key secrets. The database stores only a SHA-256 digest of each challenge.
The server reconstructs the challenge with HMAC when it needs to show or check it. Rotating the
secret invalidates pending challenges, so disable and recreate pending records after a rotation.

A hostname is routable only after verification. A partial unique index prevents two sites from
holding the same verified hostname. Disabling a domain immediately removes its reader mapping. DNS
and Vercel project configuration remain operator-owned deployment work.

## Authenticated readers

A site is either `public` or `authenticated`. For an authenticated site, an owner or admin creates a
reader grant with an expiry and redemption cap. The cleartext grant appears once. Postgres stores
only its digest.

The reader enters the grant at `/access/<site-slug>`. The form sends the grant and expected site to
`POST /api/v1/reader/sessions` on the same authorized reader host. The host must be the configured
content origin or the verified custom hostname for that exact site before Postgres consumes the
grant. The exchange creates a revocable, bounded session and sets an `HttpOnly`, `SameSite=Lax`,
site-specific cookie on that reader host. The resolver accepts only an unexpired session whose
parent grant is also live. Revoking a grant revokes every session created from it. Reader sessions
do not authorize dashboard or data API access.

Authenticated pages, media, redirects, and conditional responses use `private, no-store` plus
`Vary: Cookie` and explicit no-store headers for shared CDNs. Public reader responses also use
`no-store`, as described in [`public-reader.md`](public-reader.md).

The release provides these human-session routes:

| Route                                                             | Purpose                         |
| ----------------------------------------------------------------- | ------------------------------- |
| `GET /api/v1/session/platform`                                    | Capabilities and usage counters |
| `GET`, `PATCH /api/v1/session/sites/<site-id>/access`             | Read or change reader policy    |
| `GET`, `POST /api/v1/session/sites/<site-id>/domains`             | List or create domain state     |
| `POST /api/v1/session/sites/<site-id>/domains/<domain-id>/verify` | Check the exact TXT challenge   |
| `DELETE /api/v1/session/sites/<site-id>/domains/<domain-id>`      | Disable the mapping             |
| `GET`, `POST /api/v1/session/sites/<site-id>/reader-grants`       | List or create reader grants    |
| `DELETE /api/v1/session/sites/<site-id>/reader-grants/<grant-id>` | Revoke grant and sessions       |
| `POST /api/v1/reader/sessions`                                    | Exchange a grant for a session  |

The reader session body is `{ "token": "…", "siteSlug": "…" }`. A token for another site is
rejected before the transaction increments its redemption count.

Human mutations require a trusted same-origin request and an owner or admin workspace role.

## Enforced workspace limits

`tenant_platform_limits` holds database-enforced limits for:

- sites and active custom domains;
- active reader grants;
- active API keys and connectors;
- live object-storage bytes;
- monthly media derivative jobs.

Insert and update triggers take transaction-scoped advisory locks before checking shared limits.
The dashboard reads the same counters through `get_platform_usage`, so displayed values and write
enforcement have one source of truth. Defaults are safety limits, not a billing entitlement.

## Deliberately unavailable providers

The code defines typed boundaries for billing, hosted connectors, and media derivatives. Their
default implementations return unavailable capabilities:

| Capability        | Current reason                          |
| ----------------- | --------------------------------------- |
| Billing           | No billing provider is configured.      |
| Hosted connectors | Licensing and isolation are unresolved. |
| Media derivatives | No worker KMS boundary is configured.   |

Setting a database flag does not enable these providers. No route pretends to start a hosted
connector, charge an account, or transform media. Each feature needs an implementation, operational
owner, deletion behavior, and recovery evidence before release.

## Audit and deletion behavior

Site access changes, domain creation/check/disable, reader grant creation/revocation, and human
publication controls write tenant-scoped audit events in the same database transaction as their
state change. Publication disable is reversible: committing a new authorized version clears the
disabled state. Unpublish remains terminal for that publication identity and uses the durable
deletion outbox described in [`publication-lifecycle.md`](publication-lifecycle.md).

All new tenant tables have forced row-level security. The public reader functions run as the narrow
`knot_resolver` role. Grant exchange is the only resolver operation that begins without a tenant
context, and it can return only a live digest match while atomically consuming its redemption cap.

## Verification

Before release:

1. apply migrations with the owner credential and confirm the application still connects as
   `knot_app`;
2. configure a separate reader registrable domain and a domain challenge secret;
3. run `pnpm run check` and the production provider smoke test;
4. verify public, authenticated, revoked, disabled-domain, and cross-tenant paths against managed
   Neon;
5. test the custom hostname through the deployed Vercel routing and TLS configuration.
