# P0 threat model

Status: deployed P0 foundation. The invitation-only operator console, health endpoint, and protocol
metadata endpoint are live. Pairing, publishing, public readers, and the Anytype data API remain
unreleased.

## Protected assets

- Anytype identity credentials, connector private keys, consumer API keys, and human sessions;
- tenant documents, media, provenance, commands, results, quotas, and audit history;
- local Anytype, filesystem, project, and runtime authority;
- publication availability and destructive-unpublish guarantees.

## Trust boundaries

The deployed P0 boundary is a human browser authenticated to the dashboard by invitation and email.
The application uses a restricted PostgreSQL role and private object-store credentials. Migration
credentials never enter the application runtime.

Later releases add these boundaries:

1. A consumer application authenticates with a scoped API key.
2. A local connector authenticates with an Ed25519 key generated and stored locally.
3. Knot Cloud stores typed intents. Local Knot independently decides whether to execute one.
4. Postgres stores authoritative state. Private object storage holds bytes. Redis and queues may
   start work or cache data, but cannot hold the only copy of authoritative state.

Human sessions, connector keys, API keys, and first-party service credentials are not
interchangeable. No endpoint may accept one credential class as a fallback for another.

## Threats and controls

| Threat                                              | Control or release requirement                                                                        | Evidence or later gate                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Display-name or forwarded-message identity spoofing | Cloud identity claims grant no local authority; local connector fetches native objects again          | Contract excludes participant authority; P2 adversarial integration |
| Cross-tenant access                                 | Composite tenant foreign keys, non-owner runtime role, transaction-scoped tenant GUC, and forced RLS  | Migration review and two-tenant P1 test                             |
| Signed request replay                               | Short timestamp window, nonce claim, body digest, Postgres idempotency                                | Signature fixtures; replay-store outage test before a signed route  |
| Credential confusion                                | Separate human, connector, API, and service endpoint guards                                           | Contract principal enum and endpoint tests                          |
| API becomes remote shell                            | Closed typed operation union; local operation allowlist                                               | Unknown `execute` payload rejection fixture                         |
| Duplicate remote effects                            | Postgres idempotency, lease fencing, local command-ID dedupe                                          | Command contract fixture; P2 crash tests                            |
| Stale connector result overwrites a new attempt     | Random lease token, stored digest, compare-and-set result                                             | P2 stale-result test                                                |
| Public-page XSS reaches dashboard                   | Safe typed links now; separate registrable content domain and nonce-based renderer CSP required in P1 | P1 browser test                                                     |
| Unpublish still serves origin data                  | Private R2 objects and durable deletion outbox exist; route tombstones and draining worker are P1     | P1 interruption tests                                               |
| R2 deletion fails                                   | Public pointer tombstoned first; routes return 404; idempotent deletion retry                         | P1 failure injection                                                |
| Redis or Queue outage corrupts state                | Postgres remains authoritative; signed mutations fail closed without nonce store                      | P1 outage tests                                                     |
| Cron misses or duplicates work                      | Reconciliation is idempotent and not required for request correctness                                 | P1 recovery tests                                                   |
| Connector offline indefinitely                      | Commands live in Postgres, expire explicitly, and are not stored only in Queue                        | P2 offline recovery                                                 |
| Protocol skew and clock drift                       | Version range endpoint, typed rejection, server time, doctor check                                    | Golden fixtures and P2 compatibility matrix                         |

## Destructive unpublish boundary

Unpublish will first commit a tombstone that makes every service-controlled page and asset route
return 404. The P0 schema contains the durable deletion outbox; the state transition and idempotent
drainer remain P1 work. Only keyed digests and operational audit metadata may survive. The service
cannot recall copies that a reader already downloaded or stored outside Knot Cloud. Product copy
must never promise otherwise.

Knot Cloud will not serve untrusted reader content from `knot.imai.tech` or another control-plane
registrable domain. The public-content domain has not been selected. Publishing remains blocked
until the operator records that choice and the renderer passes the P1 browser tests.

## Not in P0

- The cloud does not prove a raw Anytype participant ID supplied by a client.
- The cloud does not grant local filesystem, project, model, or agent permissions.
- P0 provides invitation-only operator login. It does not provide connector pairing, a publishing
  endpoint, a public reader, consumer API keys, an Anytype data API, or a hosted connector.
- The first release does not expose arbitrary prompts, shell, HTTP, or model tools.
