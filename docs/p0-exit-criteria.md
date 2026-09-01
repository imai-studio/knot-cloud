# P0 exit criteria

P0 defines compatibility and security boundaries before a public API exists.

## Contract

- [x] Protocol range and server-time response schema.
- [x] Exact request-signing canonicalization and Ed25519 verification fixture.
- [x] Canonical JSON and deterministic idempotency derivation.
- [x] Typed publication document schema.
- [x] Closed typed Anytype operation union.
- [x] Command envelope, lease fencing, and terminal local-policy rejection.
- [x] Connector-attested provenance is metadata rather than cloud authority.
- [ ] Check released-client fixtures against the first server candidate.

## Deployment targets

- [x] Next.js App Router Node-runtime skeleton.
- [x] Standalone output configuration.
- [x] Lazy Neon adapter that does not require build-time environment values.
- [x] Private immutable Cloudflare R2 adapter with bounded uploads.
- [x] Tenant-derived object keys, upload and download digest checks, bounded reads, and typed
      tombstone deletion.
- [x] Fail-closed replay-store boundary.
- [x] Tenant-scoped migration with composite foreign keys, a restricted role, and forced RLS.
- [x] Transaction-scoped Neon tenant helper and runtime-role assertion.
- [x] Better Auth is the only human session authority.
- [x] First verified session creates one default owner workspace without duplicate tenants.
- [x] Active workspace selection is bound to a verified session and tenant membership.
- [x] Link the imai Vercel project, provision Neon, and provision a private Cloudflare R2 bucket.
- [ ] Choose a separate registrable domain for untrusted public content.
- [ ] Provision Upstash and pass the provider smoke check before releasing signed connector routes.
- [x] Verify the private storage port's digest, size, tenant, cache, and tombstone behavior in unit
      tests.
- [ ] Verify a large upload against the production R2 limit before raising the 32 MiB default.
- [ ] Merge the signed command route candidate and apply its command-ledger migration in production.
- [ ] Deploy the signed command routes and record a live signed claim, lease extension, and result
      canary. Until then, the routes remain unreleased even when their code is present in a branch.
- [ ] Exercise row locking and lease fencing against Neon.
- [ ] Prove publication-aware media returns 404 immediately after a tombstone.
- [x] Build and run the generated standalone Next.js server.
- [x] Build and run the Docker image and probe its health endpoint.
- [x] Record local P0 evidence in `docs/p0-verification.md`.
- [x] Record the production URL, region, and resource configuration without secrets.

## Review gates

- [x] Threat-model review.
- [x] Claude Code Opus High implementation review.
- [x] Resolve all Critical and High security and correctness findings from the final review set.
- [x] Run `pnpm run check` after review fixes.
