# Release record

This file is the release contract. Plans belong in
[`implementation-roadmap.md`](implementation-roadmap.md).

## 2026-09-02. Connector, publishing, and API release

### Deployment

- Control plane: `https://knot.imai.tech`
- Reader origin: `https://pages.imai.studio`
- Runtime: Vercel with Node.js 24 in `iad1`
- State: Neon PostgreSQL under the restricted `knot_app` role
- Objects: private Cloudflare R2
- Connector and pairing abuse limits: Upstash Redis
- Email: Resend

### Released behavior

- Operators pair local connectors with a one-time request, review exact scopes and sites, then
  rename or permanently revoke the connector.
- Connectors sign command and publication requests with their local Ed25519 key. Transactional
  events use a scoped consumer API key bound to an approved connector. Postgres claims connector
  replay nonces and fences command leases.
- Operators issue scoped API keys bound to active connectors. The API accepts only the typed
  Anytype operation union and returns durable operation status.
- Connectors upload publication assets directly to private R2 with a short-lived signed request.
  Knot verifies bytes, length, metadata, and SHA-256 before a publication can reference the asset.
- Sites serve typed pages and current-version media from the isolated reader origin. Rollback,
  disable, and terminal unpublish are available. Unpublish removes reader eligibility before the
  scheduled worker deletes private objects.
- Sites may be public or grant-protected. Operators can issue and revoke reader grants, attach a
  custom hostname, and verify its exact DNS TXT challenge.
- The dashboard exposes connectors, sites, API keys, reader access, domains, workspace limits, and
  a filtered audit log.
- Transactional channel events can reach deployment-approved webhook destinations. Events carry
  Anytype object pointers, not sender authority. A recipient that asks local Knot to act must make
  Knot fetch the native object and authorize its participant.
- The local Knot CLI supports Cloud pairing, status, diagnostics, publication controls, and durable
  publication outbox recovery. Its default-off executor handles typed Cloud commands after local
  policy checks.

### Production evidence

- Repository CI passed the contract, renderer, application, type, lint, format, and production
  build checks.
- The production build authenticated as `knot_app`, exercised Upstash, then completed both direct
  and presigned R2 write-read-delete round trips with exact metadata.
- A live paired connector published a typed document with a WebP asset. The reader returned the
  page and digest-addressed media with `no-store` and no dashboard cookie.
- The reader origin resolved through Vercel DNS, returned the restrictive reader CSP, and rejected
  control-plane routes. The control origin rejected reader routes.
- Terminal unpublish made both URLs return uncached `404` responses on repeated requests.
- Connector revoke, reader-grant create and revoke, and the audit trail were verified in the live
  dashboard.
- Dashboard navigation was verified for connectors, sites, API keys, access and domains, and the
  audit log. API-key creation correctly remained disabled after the test connector was revoked.
- The deployment config schedules publication maintenance every ten minutes and webhook
  maintenance every minute. The durable outboxes keep authoritative work in Postgres between
  invocations.

The scoped data API, signed command claim/extend/result flow, custom-domain mutation, and webhook
delivery have repository integration coverage but were not separately exercised as live production
canaries in this release record.

### Independent review

Fable 5.1 High and Claude Code Opus High reviewed the R2 signing fix. Both also reviewed the release
reconciliation and webhook scheduler changes before merge. CodeRabbit CLI was not used.

### Deliberately disabled

- Hosted connector execution
- Billing and entitlement enforcement
- Media transformation execution

The Cloudflare R2 adapter is the only object-storage implementation. A general S3-compatible
adapter remains planned.

The database may store bounded configuration or job metadata for these areas. That does not enable
the provider or runtime.

## 2026-09-01. P0 foundation

Historical record. The status and limits below describe the P0 release on that date, not the
current service.

### Deployment

- Primary console: `https://knot.imai.tech`
- Application runtime: Vercel, Node.js 24, region `iad1`
- Database: Neon PostgreSQL
- Object storage: private Cloudflare R2 through the S3-compatible API
- Email: Resend for invitation-only magic links

### Released behavior

- Allowed operators can request a passwordless sign-in link and open the dashboard.
- Removing an address from `KNOT_ALLOWED_EMAILS` revokes dashboard access on the next request.
- `GET /api/health` returns service liveness.
- `GET /api/v1/meta` returns the supported protocol range and server time.
- The production build checks the restricted Neon role and completes a private R2
  write-read-delete round trip.
- The storage port derives tenant asset keys, checks SHA-256 on bounded transfers, prevents
  overwrites, and separates database tombstones from physical R2 deletion.
- The repository builds a standalone Next.js server and a non-root container image.

### Outside the P0 release

- Connector pairing, heartbeat, command claim, lease, result, or revoke routes.
- Publication upload, public reader, rollback, disable, or unpublish routes.
- Consumer API-key management and the Anytype data API.
- A local connector configured to use Knot Cloud.
- Durable connector nonce claims, queue workers, scheduled reconciliation, or hosted connectors.
- Custom reader domains, authenticated reader sessions, media derivatives, billing, or quota plans.

At the time of P0, the repository contained an implementation of signed command claim, lease, and
result routes that had not been released. The 2026-09-02 release section records the later release.

The protocol `1.0` command wire format was still pre-release during P0. Review narrowed command
identifiers and connector route identifiers to UUIDs rather than opaque strings. No released-client
compatibility promise changed at that time.

### P0 release blocker at the time

- Public reader content needed a separate registrable domain. That origin was added later at
  `pages.imai.studio`.

Evidence: [`p0-verification.md`](p0-verification.md).
