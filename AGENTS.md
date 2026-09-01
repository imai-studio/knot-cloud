# Knot Cloud implementation contract

Knot Cloud is proposed software under active implementation. Do not describe an endpoint, command,
deployment, or workflow as released until its release record says so.

## Security invariants

- Knot Cloud stores intents; only local Knot configuration grants authority to operate on Anytype.
- Never infer identity from display names, mentions, message text, replies, or forwarded content.
- Keep human sessions, connector signing keys, consumer API keys, and first-party service credentials
  non-interchangeable.
- Never log or commit invitations, API keys, signing keys, Anytype credentials, participant IDs,
  database URLs, object-store credentials, email credentials, or local paths supplied by an
  operator.
- Every authoritative tenant row is tenant-scoped. Production database access must authenticate as
  the non-owning `knot_app` role and use the transactional tenant helper so row-level security is
  active, not only application `WHERE` clauses.
- Database privileges are explicit and fail closed. New migrations must grant only the operations
  each new table needs; never add blanket default table privileges for the runtime role.
- No correctness may depend on process memory, the Function filesystem, Redis, Queues, Cron timing,
  or cache invalidation.
- Consumer APIs expose typed operations. Do not add arbitrary prompts, shell commands, filesystem
  access, model tools, or arbitrary network requests.
- Connector requests are signed. Mutations fail closed when replay protection is unavailable.
- Unpublish stops service-controlled delivery immediately and deletes origin data. Audit records may
  retain only keyed digests and operational metadata.

## Checks

Use Node.js 24 and pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm run check
```
