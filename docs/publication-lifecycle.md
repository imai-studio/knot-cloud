# Publication lifecycle

Status: implemented for review, not released. The public reader domain is still undecided, so this
code must not be deployed as a public publishing service.

## Data path

1. An owner or admin creates a site in the dashboard or with `POST /api/v1/session/sites`.
2. A connector with `publications.write` requests an asset upload at
   `POST /api/v1/connectors/{connectorId}/assets/request`.
3. The connector uploads the exact bytes to the short-lived private R2 URL. Vercel does not proxy
   the media body.
4. The connector calls `POST /api/v1/connectors/{connectorId}/assets/commit`. Knot reads the private
   object, calculates SHA-256, checks its length and metadata, and records the asset for that site.
5. The connector sends a typed publication bundle to
   `POST /api/v1/connectors/{connectorId}/publications`.
6. Knot stores the canonical bundle under an immutable version key. One database transaction checks
   every referenced site asset, marks the version ready, and changes the active pointer.

All connector control requests use the versioned signing protocol and replay nonce store. A cloud
scope allows the request to reach this service. The local connector still decides what Anytype
content it may read and publish.

## Visibility and deletion

No public reader route exists in this change. `knot.imai.tech` remains the operator control plane.
Reader HTML and assets stay blocked until a separate registrable domain passes the CSP, cookie,
DNS, and cross-origin tests in the release plan.

Disable clears reader eligibility without deleting stored versions. Rollback selects an earlier
ready version. Unpublish does three things in one database transaction:

1. clears the active pointer and records the tombstone;
2. makes every service-controlled lookup return not found;
3. creates deletion outbox rows for every bundle and every asset not used by another live
   publication.

Vercel invokes the authenticated maintenance route every ten minutes. Self-hosted operators call
the same route with the dedicated `CRON_SECRET`. The worker discovers due tenants through a narrow
schedule table, then claims rows with `SKIP LOCKED`, a random lease digest, and an expiry. It batches
R2 deletion and requires the same live lease before completing each row. After 12 failed claims, a
row moves to a visible dead-letter state and the cron request fails until an operator intervenes.
The publication remains tombstoned and is not falsely reported as deleted.

The worker also queues abandoned presigned uploads and verified assets that remain unreferenced
after a 24-hour grace period. Asset-digest advisory locks and a pending-deletion check prevent an
old unpublish from deleting bytes that a new live publication has reused. The worker removes a
publication record only after every outbox row completes. Audit data may retain keyed digests and
operational metadata, but it must not retain the deleted document or media.

## Recovery rules

- Asset and publication requests use credential-scoped idempotency keys.
- An interrupted bundle upload leaves a draft version. Retrying the same request reuses that version
  and immutable path before attempting the active-pointer transaction again.
- A failed asset verification never creates a site asset.
- A stale deletion lease cannot complete or reschedule a newer attempt.
- A resumed upload request extends an unverified upload lease and returns a fresh presigned URL.
- Asset verification compares SHA-256, exact length, and media type before recording the asset.
- Every image or file block must declare its digest in the publication asset list.
- R2 deletion is idempotent. Database tombstones remain authoritative while R2 is unavailable.
- Every repository call sets the tenant transaction context. Cross-tenant identifiers fail under
  forced row-level security and composite foreign keys.

## Release gates

Before release:

- merge and deploy tenant bootstrap, connector pairing, signed connector routes, and replay storage;
- run the managed-Neon two-tenant and lease-fencing tests;
- run large direct-to-R2 upload and interruption tests against the production candidate;
- provision a separate reader domain and pass its browser security tests;
- record destructive-unpublish failure injection and immediate not-found evidence.
