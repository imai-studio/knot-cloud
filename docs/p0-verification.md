# P0 verification record

This is the historical foundation record. Current production evidence is in
[`releases.md`](releases.md).

Verified locally on 2026-09-01 with Node.js 24 and pnpm 11.

| Gate                                             | Evidence                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting, lint, types, tests, production build | `pnpm run check`                                                                                                                                                                                                                               |
| Migration syntax and tenant isolation            | The Vitest suite applies all numbered migrations as a non-superuser migrator in ephemeral PostgreSQL, then exercises RLS, resolver functions, composite foreign keys, active-asset uniqueness, restricted-role privileges, and outbox cleanup. |
| Human workspace authorization                    | Database tests cover first-session workspace creation, repeated resolution, legacy identity projection claims, per-session selection, membership denial, and restricted bootstrap privileges.                                                  |
| Standalone Next.js runtime                       | Built `.next/standalone`, started the generated server, and probed `/api/health` and `/api/v1/meta`.                                                                                                                                           |
| Response security headers                        | Live response included CSP, HSTS, `nosniff`, referrer, frame, opener, resource, and permissions policies.                                                                                                                                      |
| Container                                        | Built `knot-cloud:p0`, ran it as the Dockerfile's non-root user, and received a healthy `/api/health` response.                                                                                                                                |
| Independent review                               | Claude Code Opus High reviewed the initial P0 implementation and the fixes. The final review reported no remaining Critical or High issue in that scope. CodeRabbit was not used.                                                              |
| Production Vercel build                          | Vercel built the monorepo with Node.js 24 in `iad1`; the production preflight authenticated as the restricted `knot_app` role and completed a private R2 write/read/delete round trip before compiling Next.js.                                |
| Production endpoints                             | `https://knot.imai.tech/api/health` returned healthy and `https://knot.imai.tech/api/v1/meta` returned protocol metadata over the primary Cloudflare-managed domain.                                                                           |
| Private object storage                           | Vitest covers tenant-derived keys, immutable writes, exact upload bounds, SHA-256 checks, bounded reads, metadata validation, private cache policy, tombstone gating, deduplicated deletion, and partial R2 delete failures.                   |

The P0 deployment used Vercel, Neon, private Cloudflare R2, and Resend. The application used R2
through its S3-compatible API and did not use Vercel Blob. The Vercel application environment did
not contain an owner or migrator database credential.

This record predates connector pairing, command transport, publication mutation, the public reader,
API-key management, and Anytype data routes. It is not the status page for those capabilities.

Current behavior and current production evidence are recorded in [`releases.md`](releases.md).
