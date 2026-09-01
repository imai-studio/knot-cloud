# P0 verification record

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
| Production endpoints                             | `https://knot.imai.tech/api/health` returned healthy and `https://knot.imai.tech/api/v1/meta` returned protocol metadata over the primary Cloudflare-managed domain. `https://knot.imai.studio` remains a trusted compatibility origin.        |
| Private object storage                           | Vitest covers tenant-derived keys, immutable writes, exact upload bounds, SHA-256 checks, bounded reads, metadata validation, private cache policy, tombstone gating, deduplicated deletion, and partial R2 delete failures.                   |

The production deployment uses Vercel, Neon, private Cloudflare R2, and Resend. The application
uses R2 through its S3-compatible API and does not use Vercel Blob. Signed connector routes remain
release-gated until Upstash is provisioned and the provider smoke check passes. The Vercel
application environment does not contain an owner or migrator database credential.

This record does not verify connector pairing, publication mutation, a public reader, API-key
management, or Anytype data routes. Those routes are not released. The public reader also needs a
separate registrable domain, which has not been selected.
