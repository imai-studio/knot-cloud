# Implementation roadmap

This roadmap orders work by dependency. A phase can start in parallel where its inputs are stable,
but it cannot release until every earlier gate it relies on has passed.

## P0. Deployed foundation

P0 released on 2026-09-01.

P0 includes the invitation-only console, protocol contracts, database schema, provider adapters,
security tests, and deployment checks. It does not include a usable connector, publishing service,
or data API. The release record is in [`releases.md`](releases.md).

## P1. Close production gates

P1 depends on P0.

- Choose and record a separate registrable domain for public reader content.
- Check the first local connector candidate against the versioned protocol fixtures.
- Exercise large streaming R2 uploads and server-side digest calculation.
- Exercise Neon row locking, lease fencing, and two-tenant isolation against the managed database.
- Provision the replay nonce store before enabling any signed mutation route.
- Record CSP, cookie, DNS, and cross-origin tests for the chosen reader domain.

P1 does not add a customer-facing route. It closes the infrastructure and browser gates that later
routes depend on.

## P2. Tenant bootstrap and connector pairing

P2 depends on the P1 replay protection and managed-database tests.

- Create or reuse the operator's tenant after an allowed email signs in.
- Add a short-lived, single-use pairing challenge initiated by a human session.
- Register the connector's public key, protocol version, name, and requested scopes.
- Add signed connector heartbeat, command claim, lease renewal, result, and rejection routes.
- Add connector status, scope review, rename, and revoke controls to the dashboard.
- Test replay, protocol skew, stale leases, connector revocation, and cross-tenant access.

The local connector still applies its own policy. A cloud scope permits a request to enter the queue;
it does not grant local Anytype or filesystem access.

## P3. Publication lifecycle

P3 depends on P2 connector identity and the P1 reader-domain decision.

- Add site and publication management for human sessions.
- Accept typed publication bundles and bounded asset streams from an authorized connector.
- Calculate digests on the server and store immutable bytes in private R2.
- Commit the active publication pointer only after every referenced object is verified.
- Serve typed HTML and assets from the separate public-content domain with a restrictive CSP.
- Add disable, rollback, and destructive unpublish transitions.
- Drain the durable deletion outbox until the publication bundle and its unshared assets are gone.
- Test interruption recovery and immediate 404 behavior for pages and media.

P3 releases publishing only after disable and unpublish pass failure-injection tests. A successful
upload without those controls is not a releasable publication path.

## P4. Scoped Anytype data API

P4 depends on P2 command transport and stable local operation handlers.

- Add human controls to create, inspect, rotate, and revoke consumer API keys.
- Bind each key to explicit scopes and one or more connectors.
- Accept only the typed Anytype operation union from the protocol package.
- Queue operations in Postgres and return durable command IDs.
- Add command status and result retrieval without exposing local prompts, shell access, arbitrary
  HTTP, filesystem paths, or model tools.
- Enforce quotas, expiry, idempotency, audit digests, and tenant isolation.

P4 is asynchronous. The cloud accepts a typed intent, and the chosen local connector decides whether
to execute it.

## P5. Local CLI and MCP integration

P5 depends on P2 pairing. Each command also depends on its P3 or P4 server route.

- Add local login and pairing commands to Knot.
- Add connector status, revoke, and diagnostic commands.
- Add publish, rollback, disable, unpublish, and operation-status commands after their server routes
  release.
- Add a narrow MCP publish tool that calls the same local policy checks and cloud contracts.
- Test offline outbox recovery and protocol compatibility across released client and server
  versions.

## P6. Workflow integration

P6 depends on the local Knot workflow runner and the released P3 or P4 operations.

- Send cloud publication and Anytype operation events into the existing local runner.
- Add transactional channel actions through that runner instead of building a second scheduler.
- Preserve native Anytype participant identity in every event and authorization decision.
- Add retry, dead-letter, approval, and audit views backed by Postgres records.

## P7. Later product work

P7 depends on stable security and recovery evidence from P2 through P6.

- Custom reader domains.
- Authenticated reader sites.
- Billing and quota plans.
- Media transformation workers.
- Hosted connectors for operators who choose that trust model.

These items stay out of the release contract until their security model, deletion behavior, and
operational owner are documented.
