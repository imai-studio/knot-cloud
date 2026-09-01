# Private object storage

Knot Cloud uses one private Cloudflare R2 bucket through its S3-compatible API. The bucket stores
immutable publication assets. It is not a public content origin.

The storage port and an unreleased publication lifecycle are implemented. No upload route,
publication route, deletion worker trigger, or public content hostname is released yet.

## Configure R2

Create a private bucket and an R2 API token that can read, write, and delete objects in that bucket.
Do not enable the `r2.dev` URL or attach a custom domain. Keep the token out of source control and
give it access to this bucket only.

Set these server-side variables:

| Variable               | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `OBJECT_STORE_DRIVER`  | Must be `r2`. This is also the default.                                   |
| `R2_ACCOUNT_ID`        | Cloudflare account that owns the bucket.                                  |
| `R2_BUCKET_NAME`       | Private bucket name.                                                      |
| `R2_ACCESS_KEY_ID`     | Access key for the bucket-scoped R2 token.                                |
| `R2_SECRET_ACCESS_KEY` | Secret for the same token.                                                |
| `R2_MAX_OBJECT_BYTES`  | Upload and download cap. Defaults to and cannot exceed 104,857,600 bytes. |

The publication API accepts assets up to 100 MiB (104,857,600 bytes). The lower configured
`R2_MAX_OBJECT_BYTES` value still wins. Knot buffers one verified object per request, so total
memory use grows with concurrent requests. Choose the configured cap against the runtime's memory
limit. Lowering it below the size of stored objects makes those objects unreadable until the cap is
restored.

Vercel Functions are not the asset transport. Their request body is limited to roughly 4.5 MiB,
well below the R2 object limit. Publication clients must upload large bytes with a short-lived,
single-object presigned R2 request that binds the tenant, digest, size, kind, and media-type
metadata. The control plane then reads the private object, validates that signed metadata,
calculates its SHA-256 digest, checks its exact length, and only then marks the asset verified. Do
not add a Function route that buffers an upload before passing it to R2.

The released uploader is the server-side Node connector. It sends every header returned by the
upload-init response, including the signed `x-amz-meta-*` identity headers, directly to R2. Browser
uploads are not supported, so the private bucket intentionally has no browser CORS policy. Adding
a browser uploader requires a separate threat-model and CORS review; do not broaden the bucket's
allowed origins or headers as a workaround.

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
corruption. For single-part responses that expose a canonical MD5 ETag, Knot compares that ETag as
an additional integrity check; SHA-256 remains the object identity and final authority.
`If-None-Match: *` prevents an existing immutable object from being overwritten. A `412` retry is
accepted only after `HEAD` confirms the exact tenant, digest, kind, byte size, media type, and any
canonical single-part ETag returned by R2.

## Read limits and cache policy

Reads use the authenticated S3 endpoint. The adapter checks the response length and the recorded
tenant, asset marker, digest, and byte size, then returns a byte-count-bounded stream. Direct
uploads are fully streamed and SHA-256 verified at commit time before they can be linked to a live
publication; immutable digest keys and R2 metadata carry that verified identity on later reads.
The stored byte-size value must use canonical unsigned decimal syntax; whitespace, signs, decimal
points, exponent notation, and unsafe integers are rejected. Missing media type metadata falls
back to `application/octet-stream`, while malformed media types fail closed.

Every stored object and private object descriptor uses:

```text
Cache-Control: private, no-store, max-age=0
```

This policy keeps private reads out of browser and shared caches. The public reader applies
`must-revalidate` with a digest ETag after checking active publication state before and after the
private read. Conditional requests avoid a second R2 transfer while still rechecking revocation.

## Tombstones and deletion

Postgres decides whether content may be served. R2 does not. The intended deletion order is:

1. Commit the publication or asset tombstone and a `deletion_outbox` row in one database
   transaction.
2. Return a private `404` for all later reads without consulting R2.
3. Pass the tombstoned tenant and stored key to `deleteTombstoned`.
4. Mark the outbox row complete after R2 confirms deletion.

The reader resolves current-version eligibility before the R2 read and repeats the database lookup
before returning the body. Missing, disabled, unpublished, and unlinked media all return the same
`404`. This makes revocation independent of R2 availability and cache invalidation.

`deleteTombstoned` accepts only typed tombstone records and verifies that every asset or publication
bundle key belongs to its tenant. It removes duplicate keys and respects R2's 1,000-object batch
limit. A partial batch failure is an error, so the durable outbox retries it with a new lease.

## Public content domain gate

Do not reuse `knot.imai.tech`, `knot.imai.studio`, or another dashboard subdomain as the public
content origin. Before public publishing ships, choose a separate registrable domain and pass the
cookie, CSP, DNS, disable, and unpublish checks in [`public-reader.md`](public-reader.md). R2 stays
private; the application owns reader cache control.

## Verification

Run the adapter and policy tests with:

```bash
pnpm --filter @imai/knot-cloud test
```

The production prebuild smoke test writes one tenant-scoped object through the SDK and another
through the same presigned request builder used by the upload API. It sends the returned header map
unchanged, checks both objects' bytes and metadata, and deletes both keys. Run it directly only with
the restricted database URL and R2 credentials loaded in the current shell:

```bash
pnpm --filter @imai/knot-cloud smoke:providers
```

Run this check against the exact candidate environment before promotion. It verifies credentials
and private bucket access. It does not replace publication commit or destructive-unpublish tests.
