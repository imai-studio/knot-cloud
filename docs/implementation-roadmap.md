# Implementation roadmap

This roadmap separates delivered phases from the work that remains. A feature is released only
when [`releases.md`](releases.md) records it.

## P0. Deployed foundation

P0 released on 2026-09-01.

P0 includes the invitation-only console, protocol contracts, database schema, provider boundaries,
security tests, and deployment checks. Later phases now build on it. See
[`releases.md`](releases.md) for the current release.

## P1. Production gates

Status: the gates required by the current release are closed. Two scale checks remain before Knot
raises the published object limit or broadens managed-database claims.

- [x] Use `pages.imai.studio` as the separate reader origin and verify host isolation.
- [x] Check the local connector against the versioned protocol fixtures.
- [x] Exercise direct and presigned R2 uploads with persisted metadata and server-side SHA-256.
- [x] Apply and probe the durable Postgres replay-nonce migration.
- [x] Record CSP, cookie, DNS, and host-isolation checks for the reader origin.
- [ ] Record a managed R2 upload at the configured maximum size before raising that limit.
- [ ] Add a repeatable operator record for managed Neon lease contention and two-tenant probes.

Repository tests already cover lease fencing, RLS, and two-tenant isolation. The last item asks for
repeatable evidence against managed Neon, not another in-memory test.

## P2. Tenant bootstrap and connector pairing

Dependencies: durable replay protection and database isolation and lease tests.

Status: released. Knot Cloud has no heartbeat route or last-seen signal.

- [x] Create or reuse the operator's tenant after an allowed email signs in.
- [x] Add a short-lived pairing request with a one-time terminal result.
- [x] Register or reuse the connector's public key, protocol version, name, and approved scopes.
- [x] Add signed command claim, lease renewal, and result routes. Local policy rejection uses the
      result route.
- [x] Add connector status, scope review, rename, and revoke controls to the dashboard.
- [x] Test pairing replay, expiry, scope escalation, connector revocation, and cross-tenant access.
- [x] Test signed-route protocol skew, stale leases, and connector command transport.

The local connector still applies its own policy. A cloud scope permits a request to enter the
queue. It does not grant local Anytype or filesystem access.

## P3. Publication lifecycle

Status: released.

Prerequisites: P2 connector identity and the P1 reader-domain decision.

- [x] Add site and publication management for human sessions.
- [x] Accept typed publication bundles and bounded asset streams from an authorized connector.
- [x] Calculate digests on the server and store immutable bytes in private R2.
- [x] Commit the active publication pointer only after every referenced object is verified.
- [x] Serve typed HTML and assets from the separate public-content domain with a restrictive CSP.
- [x] Add disable, rollback, and destructive unpublish transitions.
- [x] Drain the durable deletion outbox until the publication bundle and its unshared assets are
      gone.
- [x] Test interruption recovery and immediate 404 behavior for pages and media.

The release uses `/p/<site>/<publication>` for pages and
`/media/<site>/<publication-id>/<digest>` for immutable identifiers. The managed reader is
`pages.imai.studio`.

Disable and unpublish have failure-injection tests. An upload path without those controls would be
incomplete.

## P4. Scoped Anytype data API

Prerequisites: P2 command transport and stable local operation handlers.

Status: released. The server has durable quota and idempotency checks, API-key controls, and
dashboard key management.

- [x] Add human controls to create, inspect, rotate, and revoke consumer API keys.
- [x] Bind each key to explicit scopes and one or more connectors.
- [x] Accept only the typed Anytype operation union from the protocol package.
- [x] Store operations in Postgres and return durable command IDs.
- [x] Add command status and result retrieval without exposing local prompts, shell access,
      arbitrary HTTP, filesystem paths, or model tools.
- [x] Enforce quotas, expiry, idempotency, audit digests, and tenant isolation.

P4 is asynchronous. Knot Cloud accepts a typed intent. The selected local connector decides whether
to execute it.

## P5. Local CLI and MCP integration

Status: released for pairing, diagnostics, publication controls, publication outbox recovery, and
the narrow publish MCP tool. Remote connector revoke remains a dashboard action. The local revoke
command removes credentials only after the operator revokes the connector remotely.

Prerequisite: P2 pairing. Each command also requires its P3 or P4 server route.

- [x] Add local login and pairing commands to Knot.
- [x] Add connector status, local credential removal, and diagnostic commands.
- [x] Add publish, rollback, disable, unpublish, and operation-status commands.
- [x] Add a narrow MCP publish tool that calls the same local policy checks and cloud contracts.
- [x] Test offline publication outbox recovery and protocol compatibility.
- [ ] Add a consumer-key CLI only if a concrete non-HTTP use case requires one.

## P6. Workflow integration

Status: partial and default-off. Local Knot has the durable workflow runner and a constrained Cloud
command executor. The Cloud event API, webhook outbox, retries, and dead letters are released. A
general Cloud-to-local workflow bridge is not released.

Prerequisites: the local Knot workflow runner and the relevant released P3 or P4 operations.

- Send cloud publication and Anytype operation events into the existing local runner.
- Add transactional channel actions through that runner instead of building a second scheduler.
- Preserve native Anytype participant identity in every event and authorization decision.
- Add retry, dead-letter, approval, and audit views backed by Postgres records.

### Transactional events

The released Cloud half of transactional channel events provides tenant-isolated
subscriptions to deployment-approved destination names, atomic event-and-delivery persistence,
signed bounded envelopes, lease-fenced retries, idempotency, dead-lettering, and audit records. See
[`transactional-events.md`](transactional-events.md). Vercel schedules the webhook worker every
minute. The event deliberately stores only channel-origin
pointers. Native Anytype sender verification and `chat.send` authorization remain local connector
responsibilities and must use the existing P6 runner.

## P7. Platform extensions and later product work

Status: custom-domain verification and routing, authenticated readers, quotas, and audit records are
released. The operator still owns DNS and Vercel domain attachment.

- [x] Custom reader-domain verification and routing support.
- [x] Authenticated reader sites.
- [x] Database-enforced safety limits and usage counters.
- [ ] Billing and entitlement enforcement.
- [ ] Media transformation execution.
- [ ] Hosted connector execution.

These items stay out of the release contract until their security model, deletion behavior, and
operational owner are documented.

### Provider boundaries

The release keeps provider work behind explicit disabled adapters:

- [x] DNS TXT challenge state and owner/admin controls for custom reader domains, without DNS
      mutation.
- [x] Digest-only reader grants, revocable reader sessions, and public/authenticated site policy.
- [x] Database-enforced limits and dashboard usage for sites, domains, grants, API keys, connectors,
      storage, and derivative job metadata.
- [x] Tenant RLS and audit records for platform mutations and human publication controls.
- [ ] Media transformation execution. Only bounded job metadata and a disabled provider boundary
      exist.
- [ ] Hosted connector execution. The provider remains disabled pending licensing, runtime
      isolation, and KMS design.
- [ ] Billing. The provider remains disabled until a provider, entitlement model, and webhook
      recovery plan exist.

See [`platform-extensions.md`](platform-extensions.md) for the released boundaries and provider
checks.
