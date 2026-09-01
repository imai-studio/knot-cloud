# Knot Cloud implementation contract

Knot Cloud is under active development. Treat an endpoint, command, deployment, or workflow as
released only when [`docs/releases.md`](docs/releases.md) records it.

## Security invariants

- Knot Cloud stores intents; only local Knot configuration grants authority to operate on Anytype.
- Never infer identity from display names, mentions, message text, replies, or forwarded content.
- Keep human sessions, connector signing keys, consumer API keys, and first-party service credentials
  non-interchangeable.
- Never log or commit invitations, API keys, signing keys, Anytype credentials, participant IDs,
  database URLs, object-store credentials, email credentials, or local paths supplied by an
  operator.
- Every authoritative tenant row is tenant-scoped. Production database access must authenticate as
  the non-owning `knot_app` role and use the transactional tenant helper. Do not rely on application
  `WHERE` clauses instead of row-level security.
- Database privileges are explicit and fail closed. New migrations must grant only the operations
  each new table needs; never add blanket default table privileges for the runtime role.
- Correctness cannot depend on process memory, the function filesystem, Redis, queues, scheduled
  jobs, or cache invalidation.
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
