# P0 verification record

Verified locally on 2026-09-01 with Node.js 24 and pnpm 11.

| Gate                                             | Evidence                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting, lint, types, tests, production build | `pnpm run check`                                                                                                                                                                                                                               |
| Migration syntax and tenant isolation            | The Vitest suite applies all numbered migrations as a non-superuser migrator in ephemeral PostgreSQL, then exercises RLS, resolver functions, composite foreign keys, active-asset uniqueness, restricted-role privileges, and outbox cleanup. |
| Standalone Next.js runtime                       | Built `.next/standalone`, started the generated server, and probed `/api/health` and `/api/v1/meta`.                                                                                                                                           |
| Response security headers                        | Live response included CSP, HSTS, `nosniff`, referrer, frame, opener, resource, and permissions policies.                                                                                                                                      |
| Container                                        | Built `knot-cloud:p0`, ran it as the Dockerfile's non-root user, and received a healthy `/api/health` response.                                                                                                                                |
| Independent review                               | Claude Code Opus High reviewed the initial P0 implementation and the fixes. The final review reported no remaining Critical or High issue in that scope. CodeRabbit was not used.                                                              |
| Production Vercel build                          | Vercel built the monorepo with Node.js 24 in `iad1`; the production preflight authenticated as the restricted `knot_app` role and completed a private R2 write/read/delete round trip before compiling Next.js.                                |
| Production endpoints                             | `https://knot.imai.tech/api/health` returned healthy and `https://knot.imai.tech/api/v1/meta` returned protocol metadata over the primary Cloudflare-managed domain. `https://knot.imai.studio` remains a trusted compatibility origin.        |

The production deployment uses Vercel, Neon, private Cloudflare R2, and Resend. The application
uses R2 through its S3-compatible API and does not use Vercel Blob. Upstash remains unprovisioned
until a released signed mutation route needs replay protection. The Vercel application environment
does not contain an owner or migrator database credential.

This record does not verify connector pairing, publication mutation, a public reader, API-key
management, or Anytype data routes. Those routes are not released. The public reader also needs a
separate registrable domain, which has not been selected.
