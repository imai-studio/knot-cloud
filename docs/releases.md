# Release record

This file records behavior that users can rely on. Plans belong in
[`implementation-roadmap.md`](implementation-roadmap.md).

## 2026-09-01. P0 foundation

### Deployment

- Primary console: `https://knot.imai.tech`
- Trusted compatibility origin: `https://knot.imai.studio`
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
- The repository builds a standalone Next.js server and a non-root container image.

### Not released

- Connector pairing, heartbeat, command claim, lease, result, or revoke routes.
- Publication upload, public reader, rollback, disable, or unpublish routes.
- Consumer API-key management and the Anytype data API.
- A local connector configured to use Knot Cloud.
- Upstash replay storage, queue workers, scheduled reconciliation, or hosted connectors.

### Open release blocker

- Public reader content needs a separate registrable domain. The domain has not been chosen, so no
  public-content route may ship.

Evidence: [`p0-verification.md`](p0-verification.md).
