# Implementation roadmap

This roadmap orders unreleased work by dependency. Work may proceed in parallel when its inputs are
stable. A feature cannot release until its listed prerequisites pass.

## P0. Deployed foundation

P0 released on 2026-09-01.

P0 includes the invitation-only console, protocol contracts, database schema, provider boundaries,
security tests, and deployment checks. It does not include a usable connector, publishing service,
or data API. See [`releases.md`](releases.md) for the release record.

## P1. Close production gates

Prerequisite: P0.

- Choose and record a separate registrable domain for public reader content.
- Check the first local connector candidate against the versioned protocol fixtures.
- Exercise large streaming R2 uploads and server-side digest calculation.
- Exercise Neon row locking, lease fencing, and two-tenant isolation against the managed database.
- Provision the replay nonce store before enabling any signed mutation route.
- Record CSP, cookie, DNS, and cross-origin tests for the chosen reader domain.

P1 does not add a user-facing route. It closes infrastructure and browser security gates needed by
later routes.

## P2. Tenant bootstrap and connector pairing

Prerequisites: P1 replay protection and managed-database tests.

Candidate code is complete for the checked items, but it remains unreleased until its stacked changes
merge and the managed deployment passes the release gates.

- [x] Create or reuse the operator's tenant after an allowed email signs in.
- [x] Add a short-lived pairing request with a one-time terminal result.
- [x] Register or reuse the connector's public key, protocol version, name, and approved scopes.
- [ ] Add signed connector heartbeat, command claim, lease renewal, result, and rejection routes.
- [x] Add connector status, scope review, rename, and revoke controls to the dashboard.
- [x] Test pairing replay, expiry, scope escalation, connector revocation, and cross-tenant access.
- [ ] Test signed-route protocol skew, stale leases, and connector command transport.

The local connector still applies its own policy. A cloud scope permits a request to enter the
queue. It does not grant local Anytype or filesystem access.

## P3. Publication lifecycle

Prerequisites: P2 connector identity and the P1 reader-domain decision.

- Add site and publication management for human sessions.
- Accept typed publication bundles and bounded asset streams from an authorized connector.
- Calculate digests on the server and store immutable bytes in private R2.
- Commit the active publication pointer only after every referenced object is verified.
- Serve typed HTML and assets from the separate public-content domain with a restrictive CSP.
- Add disable, rollback, and destructive unpublish transitions.
- Drain the durable deletion outbox until the publication bundle and its unshared assets are gone.
- Test interruption recovery and immediate 404 behavior for pages and media.

The implementation candidate uses `/p/<site>/<publication>` for pages and
`/media/<site>/<publication-id>/<digest>` for immutable identifiers. It remains unreleased until a
separate registrable content domain is selected and the checks in
[`public-reader.md`](public-reader.md) pass there.

Publishing can release only after disable and unpublish pass failure-injection tests. An upload path
without those controls is incomplete.

## P4. Scoped Anytype data API

Prerequisites: P2 command transport and stable local operation handlers.

Implementation PR: the scoped API branch contains the server routes, durable quota and idempotency
fences, API-key controls, and dashboard key management. This remains unreleased until its stacked
dependencies pass review and the release record changes.

- Add human controls to create, inspect, rotate, and revoke consumer API keys.
- Bind each key to explicit scopes and one or more connectors.
- Accept only the typed Anytype operation union from the protocol package.
- Queue operations in Postgres and return durable command IDs.
- Add command status and result retrieval without exposing local prompts, shell access, arbitrary
  HTTP, filesystem paths, or model tools.
- Enforce quotas, expiry, idempotency, audit digests, and tenant isolation.

P4 is asynchronous. Knot Cloud accepts a typed intent. The selected local connector decides whether
to execute it.

## P5. Local CLI and MCP integration

Prerequisite: P2 pairing. Each command also requires its P3 or P4 server route.

- Add local login and pairing commands to Knot.
- Add connector status, revoke, and diagnostic commands.
- Add publish, rollback, disable, unpublish, and operation-status commands after their server routes
  release.
- Add a narrow MCP publish tool that calls the same local policy checks and cloud contracts.
- Test offline outbox recovery and protocol compatibility across released client and server
  versions.

## P6. Workflow integration

Prerequisites: the local Knot workflow runner and the relevant released P3 or P4 operations.

- Send cloud publication and Anytype operation events into the existing local runner.
- Add transactional channel actions through that runner instead of building a second scheduler.
- Preserve native Anytype participant identity in every event and authorization decision.
- Add retry, dead-letter, approval, and audit views backed by Postgres records.

## P7. Later product work

Prerequisite: security and recovery evidence from P2 through P6.

- Custom reader domains.
- Authenticated reader sites.
- Billing and quota plans.
- Media transformation workers.
- Hosted connectors for operators who choose that trust model.

These items stay out of the release contract until their security model, deletion behavior, and
operational owner are documented.
