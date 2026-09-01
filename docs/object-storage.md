# Private object storage

Knot Cloud uses one private Cloudflare R2 bucket through its S3-compatible API. The bucket stores
immutable publication assets. It is not a public content origin.

The storage port is implemented. No upload route, publication route, deletion worker, or public
content hostname is released yet.

## Configure R2

Create a private bucket and an R2 API token that can read, write, and delete objects in that bucket.
Do not enable the `r2.dev` URL or attach a custom domain. Keep the token out of source control and
give it access to this bucket only.

Set these server-side variables:

| Variable               | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `OBJECT_STORE_DRIVER`  | Must be `r2`. This is also the default.                |
| `R2_ACCOUNT_ID`        | Cloudflare account that owns the bucket.               |
| `R2_BUCKET_NAME`       | Private bucket name.                                   |
| `R2_ACCESS_KEY_ID`     | Access key for the bucket-scoped R2 token.             |
| `R2_SECRET_ACCESS_KEY` | Secret for the same token.                             |
| `R2_MAX_OBJECT_BYTES`  | Upload and download cap. Defaults to 33,554,432 bytes. |

The cap cannot exceed 134,217,728 bytes in this implementation. Knot verifies an upload before it
sends bytes to R2, so the cap also limits per-request memory use.

Use [`apps/cloud/.env.example`](../apps/cloud/.env.example) for local development. Vercel and
self-hosted deployments should inject the same values through their secret managers.

## Object identity

Callers provide a tenant UUID, SHA-256 digest, media type, and bytes. They do not provide an R2
pathname. The adapter derives this key:

```text
tenants/<tenant-uuid>/assets/<first-two-digest-characters>/<sha256>
```

The adapter rejects malformed tenant IDs and digests. It computes SHA-256 over the upload and
compares it with the locator before writing. It also sends `Content-MD5` so R2 can detect transport
corruption. `If-None-Match: *` prevents an existing immutable object from being overwritten.

## Read limits and cache policy

Reads use the authenticated S3 endpoint. The adapter checks the response length and the recorded
tenant, asset marker, digest, and byte size. It buffers no more than the configured limit, verifies
the exact byte count and SHA-256 digest, and only then returns a stream to the caller.

Every stored object and returned object descriptor uses:

```text
Cache-Control: private, no-store, max-age=0
```

This policy keeps private reads out of browser and shared caches. A future public renderer must
apply its own cache policy after it checks publication state.

## Tombstones and deletion

Postgres decides whether content may be served. R2 does not. The intended deletion order is:

1. Commit the publication or asset tombstone and a `deletion_outbox` row in one database
   transaction.
2. Return a private `404` for all later reads without consulting R2.
3. Pass the tombstoned tenant and stored key to `deleteTombstoned`.
4. Mark the outbox row complete after R2 confirms deletion.

`RevocableObjectReader` models step 2. Its visibility port must be backed by the tenant-scoped
database state when routes are implemented. It returns the same `not-found` result for missing and
tombstoned objects and does not call R2 for either state. It checks visibility again after the R2
read and discards the body if a tombstone committed while the read was in flight. This makes
revocation independent of R2 availability and cache invalidation.

`deleteTombstoned` accepts only typed tombstone records and verifies that every key is a canonical
asset key for its tenant. It removes duplicate keys and respects R2's 1,000-object batch limit. A
partial batch failure is an error so the durable outbox can retry it. The current repository does
not contain that drainer yet.

## Public content domain gate

Do not reuse `knot.imai.tech`, `knot.imai.studio`, or another dashboard subdomain as the public
content origin. Before public publishing ships, choose a separate registrable domain, define its
cookie and CSP boundary, and decide whether a renderer or an R2 custom domain owns cache control.
Only then should deployment add a public hostname. `CONTENT_BASE_URL` is intentionally absent from
the current environment contract.

## Verification

Run the adapter and policy tests with:

```bash
pnpm --filter @imai/knot-cloud test
```

The production prebuild smoke test writes one tenant-scoped object to the private bucket, checks its
bytes and metadata, and deletes it. Run it directly only with the restricted database URL and R2
credentials loaded in the current shell:

```bash
pnpm --filter @imai/knot-cloud smoke:providers
```
