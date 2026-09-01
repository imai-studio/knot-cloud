# Public reader deployment

The public reader is part of the P3 candidate. It stays disabled until `CONTENT_BASE_URL` is set to
an isolated origin. That origin must use a different registrable domain from `APP_BASE_URL`; a
subdomain such as `pages.knot.imai.tech` is not sufficient when the console is on
`knot.imai.tech`.

Reader URLs have two forms:

```text
https://<content-origin>/p/<site-slug>/<publication-slug>
https://<content-origin>/media/<site-slug>/<publication-id>/<sha256>
```

The page route renders only the versioned document schema. It does not accept HTML, scripts,
styles, embeds, or arbitrary URLs. Media is read from the private object store only after the
database confirms that the digest belongs to the current active version. Pages and media are
checked again before the response starts. Disabled and unpublished content returns `404`. Every
page, media, redirect, and error response uses explicit browser and CDN `no-store` directives.

## Vercel

Use the existing Vercel project with two domains:

1. Keep the console and API on the control-plane domain.
2. Bind the separate registrable content domain to the project.
3. Set `CONTENT_BASE_URL` to the content origin.
4. Do not configure a public R2 URL or R2 custom domain.

If Cloudflare manages DNS for a Vercel reader hostname, keep the Vercel CNAME **DNS-only**. Do not
place a Cache Rule, Worker, Cache Reserve rule, or Edge Cache TTL in front of reader paths. In
particular, never configure an Edge Cache TTL that ignores origin cache headers. Knot does not
mutate DNS; this is a deployment control. These constraints prevent disable, rollback, and
unpublish from being masked by an edge copy.

The application proxy allows reader pages, media, the reader-grant exchange, and the static assets
needed by that exchange on `CONTENT_BASE_URL`. It returns `404` for dashboard, authentication, and
other API routes. The reader handlers also compare the request origin with `CONTENT_BASE_URL`, so
reader paths return `404` on the console origin. Vercel preview aliases are never reader or app
origins. Unknown hosts can reach only database-backed custom-reader handlers, which return `404`
unless the hostname has an exact verified mapping.

Before promotion, verify both directions:

```bash
curl -i https://<content-origin>/dashboard
curl -i https://<console-origin>/p/example/page
curl -i https://<content-origin>/p/example/page
```

The first two requests must return `404`. The third must return either the active page or `404`; it
must never redirect to sign-in or set a cookie. Inspect the page and media responses for the CSP,
`nosniff`, same-origin resource policy, no-referrer policy, and the browser, Vercel, generic CDN,
and Cloudflare-specific `no-store` headers. When Cloudflare is intentionally present in a
non-production test, `CF-Cache-Status` must be `BYPASS` or `DYNAMIC`, never `HIT`, before and after
an unpublish.

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
