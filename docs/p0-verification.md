# P0 verification record

Verified locally on 2026-09-01 with Node.js 24 and pnpm 11.

| Gate                                             | Evidence                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting, lint, types, tests, production build | `pnpm run check`                                                                                                                                                                                                                               |
| Migration syntax and tenant isolation            | The Vitest suite applies all numbered migrations as a non-superuser migrator in ephemeral PostgreSQL, then exercises RLS, resolver functions, composite foreign keys, active-asset uniqueness, restricted-role privileges, and outbox cleanup. |
| Standalone Next.js runtime                       | Built `.next/standalone`, started the generated server, and probed `/api/health` and `/api/v1/meta`.                                                                                                                                           |
| Response security headers                        | Live response included CSP, HSTS, `nosniff`, referrer, frame, opener, resource, and permissions policies.                                                                                                                                      |
| Container                                        | Built `knot-cloud:p0`, ran it as the Dockerfile's non-root user, and received a healthy `/api/health` response.                                                                                                                                |
| Independent review                               | Claude Code Opus High reviewed the initial P0 slice, the remediated candidate, and the final hardening delta. It confirmed the final reported Critical and High set closed with no regression in that scope. CodeRabbit was not used.          |
| Production Vercel build                          | Vercel built the monorepo with Node.js 24 in `iad1`; the production preflight authenticated as the restricted `knot_app` role and completed a private R2 write/read/delete round trip before compiling Next.js.                                |
| Production endpoints                             | `https://knot.imai.studio/api/health` returned healthy and `https://knot.imai.studio/api/v1/meta` returned protocol metadata over the custom Cloudflare-managed domain.                                                                        |

The production foundation currently provisions Vercel, Neon, and Cloudflare R2. Upstash and email
remain intentionally unprovisioned until a released route needs them. No owner/migrator credential
is stored in the Vercel application environment.
