# Threat model

Status: current for the connector, publishing, reader, event, and scoped data API release.

## Protected assets

- Anytype identity credentials, connector private keys, consumer API keys, and human sessions;
- tenant documents, media, provenance, commands, results, quotas, and audit history;
- local Anytype, filesystem, project, and runtime authority;
- publication availability and destructive-unpublish guarantees.

## Trust boundaries

The human browser authenticates to the dashboard by invitation and email. The application uses a
restricted PostgreSQL role and private object-store credentials. Migration credentials never enter
the application runtime. The release also has these boundaries:

1. A consumer application authenticates with a scoped API key.
2. A local connector authenticates with an Ed25519 key generated and stored locally.
3. Knot Cloud stores typed intents. Local Knot independently decides whether to execute one.
4. Postgres stores authoritative state. Private object storage holds bytes. Redis holds abuse
   counters, not authoritative state.

Human sessions, connector keys, API keys, and first-party service credentials are not
interchangeable. No endpoint may accept one credential class as a fallback for another.

Connector pairing keeps the raw poll token out of database rows and human list
responses. A pending poll may repeat, but only the first terminal poll returns approval or denial;
later polls return `consumed`. The poll endpoint rejects browser cookies, authorization headers,
consumer API keys, and connector headers so those credential classes cannot substitute for the
one-time token. The connector private key remains local.

The poll route accepts 120 attempts per Vercel client address each minute. Upstash applies the
counter before Knot Cloud validates a pairing ID. Malformed and unknown IDs receive the same
response, and callers cannot probe unlimited IDs. Requests without a trusted Vercel address share
one fallback bucket.

## Threats and controls

| Threat                                              | Control or release requirement                                                                                                                            | Evidence                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Display-name or forwarded-message identity spoofing | Cloud identity claims grant no local authority; local connector fetches native objects again                                                              | Contract excludes participant authority; adversarial integration tests |
| Cross-tenant access                                 | Session-bound workspace selection, membership checks, composite tenant foreign keys, transaction-scoped tenant GUC, and forced RLS                        | Migration and workspace authorization tests                            |
| Signed request replay                               | Short timestamp window, transactionally unique Postgres nonce claim, body digest, Postgres idempotency                                                    | Signature fixtures; durable nonce migration and replay tests           |
| Credential confusion                                | Separate human, connector, API, and service endpoint guards                                                                                               | Contract principal enum and endpoint tests                             |
| API becomes remote shell                            | Closed typed operation union; local operation allowlist                                                                                                   | Unknown `execute` payload rejection fixture                            |
| Duplicate remote effects                            | Postgres idempotency, lease fencing, local command-ID dedupe                                                                                              | Command contract fixture and crash tests                               |
| Stale connector result overwrites a new attempt     | Random lease token, stored digest, compare-and-set result                                                                                                 | Stale-result test                                                      |
| Public-page XSS reaches dashboard                   | Closed typed renderer, script-free CSP, and a separate registrable content domain                                                                         | Renderer tests and manual reader checks                                |
| Unpublish still serves origin data                  | The database tombstone removes eligibility before the scheduled worker deletes private bytes                                                              | Publication interruption and immediate not-found tests                 |
| R2 deletion fails                                   | Leased retries are bounded; poison rows dead-letter and keep the publication tombstoned until operator recovery                                           | Failure injection and maintenance-route alert test                     |
| Redis outage corrupts state                         | Postgres remains authoritative; Redis holds only abuse counters                                                                                           | Durable nonce and command-ledger tests                                 |
| Cron misses or duplicates work                      | Reconciliation is idempotent and not required for request correctness                                                                                     | Recovery tests                                                         |
| Connector offline indefinitely                      | Commands live in Postgres and expire explicitly                                                                                                           | Offline recovery tests                                                 |
| Protocol skew and clock drift                       | Version range endpoint, typed rejection, server time, doctor check                                                                                        | Golden fixtures and compatibility tests                                |
| Volumetric request or connection exhaustion         | Edge controls must reject abusive traffic before the function; route byte caps and per-connector limits protect only requests that reach application code | Application limit tests; edge policy remains deployment-owned          |

## Availability and denial-of-service boundary

The application bounds signed control bodies to 64 KiB, result bodies to 1 MiB, connector request
rates to 300 per minute, and database work to one command per claim. Those controls do not defend
the Vercel function from floods that consume connections, headers, or request bytes before the
handler runs. Production therefore relies on Cloudflare and Vercel edge protections for
volumetric denial of service, header-size limits, connection throttling, and coarse IP abuse
control. Application limits remain defense in depth; they are not a substitute for the edge.
The managed release accepts this dependency on Vercel and Cloudflare edge controls. Their policy is
owned outside this repository; the release record does not claim a separate WAF canary.

## Destructive unpublish boundary

Unpublish first commits a tombstone that makes every service-controlled page and asset route return
`404`. The scheduled worker drains the durable deletion outbox. Only keyed digests and operational
audit metadata may survive. The service
cannot recall copies that a reader already downloaded or stored outside Knot Cloud. Product copy
must never promise otherwise.

Knot Cloud does not serve reader content from `knot.imai.tech` or another control-plane registrable
domain. The managed reader uses `pages.imai.studio`. Self-hosted deployments must preserve the same
registrable-domain split.

## Product limits

The R2 bucket has no public URL. Private reads use `Cache-Control: private, no-store, max-age=0` and
check durable visibility before object storage. The reader uses a separate registrable domain and
returns explicit no-store headers.

- The cloud does not prove a raw Anytype participant ID supplied by a client.
- The cloud does not grant local filesystem, project, model, or agent permissions.
- Knot Cloud does not run hosted connectors, billing, or media transformations.
- The API does not expose arbitrary prompts, shell, HTTP, or model tools.
