# Public reader deployment

The public reader is part of the P3 candidate. It stays disabled until `CONTENT_BASE_URL` is set to
an isolated origin. That origin must use a different registrable domain from `APP_BASE_URL`; a
subdomain such as `pages.knot.imai.tech` is not sufficient when the console is on
`knot.imai.tech`.

Fixed-origin reader URLs use these forms:

```text
https://<content-origin>/p/<site-slug>/<publication-slug>
https://<content-origin>/media/<site-slug>/<publication-id>/<sha256>
https://<content-origin>/access/<site-slug>
```

A verified custom hostname serves publication slugs from its root and uses the same `/media/*` and
`/access/*` paths. The hostname-to-site mapping is checked again in every route handler.

The page route renders only the versioned document schema. It does not accept HTML, scripts,
styles, embeds, or arbitrary URLs. Media is read from the private object store only after the
database confirms that the digest belongs to the current active version. Pages and media are
checked again before the response starts. Public pages use `Cache-Control: no-store`. Public
digest-addressed media uses `Cache-Control: public, max-age=0, must-revalidate` plus a digest ETag:
browsers may keep the immutable bytes but must revalidate visibility before every reuse.
Authenticated pages and media instead use `private, no-store`, `Vary: Cookie`, and explicit CDN
no-store headers. A matching public conditional request returns `304` only after the active-version
lookup succeeds, so disable and unpublish take effect immediately without downloading and hashing
the R2 object again.

## Vercel

Use the existing Vercel project with two domains:

1. Keep the console and API on the control-plane domain.
2. Bind the separate registrable content domain to the project.
3. Set `CONTENT_BASE_URL` to the content origin.
4. Do not configure a public R2 URL or R2 custom domain.

The application proxy allows `/p/*`, `/media/*`, `/access/*`, the exact reader-session endpoint,
and immutable Next.js static assets on `CONTENT_BASE_URL`. It returns `404` for the dashboard,
control-plane authentication and API routes, and public-file paths on that origin. The console
origin rejects every reader-only route. Potential custom hosts reach only reader surfaces; each
reader handler then requires a verified hostname mapping for the exact requested site. Missing or
invalid `CONTENT_BASE_URL` configuration makes fixed-origin and custom-host readers return `404`.

Before promotion, verify both directions:

```bash
curl -i https://<content-origin>/dashboard
curl -i https://<console-origin>/p/example/page
curl -i https://<content-origin>/p/example/page
```

The first two requests must return `404`. The third must return either the active page, the reader
grant form for an authenticated site, or `404`; it must never redirect to dashboard sign-in or set
a dashboard cookie. Inspect the page and media responses for the CSP, `nosniff`, same-origin
resource policy, no-referrer policy, public page `no-store`, public media `must-revalidate`, and
authenticated `private, no-store` plus `Vary: Cookie` policies.

## Self-hosting

Route the console and content hostnames to the same application only if the reverse proxy preserves
the original scheme and host. Set `APP_BASE_URL` and `CONTENT_BASE_URL` to those external origins.
The application enforces the same host split used on Vercel.

For a stricter network boundary, run two application instances with the same database and private
object store, then expose each instance on only its intended hostname. The application host checks
still apply. Neither instance needs direct public access to R2.

After every disable, rollback, or unpublish test, request both the page and a previously returned
media URL. Disable and unpublish must make both return `404` immediately. Unpublish then drains the
deletion outbox until the private bundle and unshared assets are removed.
