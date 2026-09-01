# Workspace authorization

Better Auth owns human accounts and browser sessions. Knot does not issue a second human session.
The `users` table is a tenant identity projection, not another login database.

## First verified session

The first authorized dashboard or `GET /api/v1/session/workspace` request performs one database
transaction:

1. Verify that the Better Auth session exists, has not expired, belongs to the supplied Better Auth
   user, and has a verified email.
2. Find the user's Knot projection by Better Auth user ID. An unmapped legacy projection can be
   claimed only when its keyed email digest matches. The one-time claim records `claimed_at`, writes
   an audit event, and updates the stored digest version.
3. Reuse the user's default active membership. If none exists, reuse the oldest active membership
   and mark it as default. If the user has no active membership, create `Personal workspace` and an
   owner membership.
4. Store the selected tenant for that Better Auth session.

The transaction takes a PostgreSQL advisory lock derived from the Better Auth user ID. The unique
Better Auth user mapping and one-default-membership index provide a second defense against duplicate
first workspaces.

## Session selection

`PUT /api/v1/session/workspace` accepts a tenant UUID from a same-origin browser request. The
database changes the selection only when all of these checks pass:

- the Better Auth session is active and belongs to the supplied user;
- the email is verified;
- the user's Knot projection is mapped to that Better Auth user;
- the user has a membership in the requested tenant;
- the tenant is not suspended.

Selections are stored per browser session. Switching one session does not change another session.
The endpoint returns `application/problem+json` when authentication, input validation, or membership
checks fail.

## Database roles

The application connects as `knot_app`. It cannot read the workspace identity projection or session
selection table directly. It can call two narrow functions:

- `resolve_or_bootstrap_workspace` for an active Better Auth session;
- `select_workspace_for_session` for an existing membership.

Those functions run as the `knot_bootstrap` no-login role. The role has only the table permissions
needed by those functions. It cannot create schema objects, bypass row-level security, or inherit
another role. Tenant data queries still run through the transaction-scoped tenant helper and forced
row-level security.

Email addresses are not stored in the Knot projection. The service stores an HMAC-SHA256 digest of
the normalized email using `IDENTITY_DIGEST_PEPPER`. A matching legacy digest is upgraded to the
configured `IDENTITY_DIGEST_VERSION` during its one-time claim. If a rotation changes the digest,
migrate existing projections before serving requests with the new pepper.

Deleting a Better Auth user also deletes its Knot identity projection, tenant memberships, and
session selections. The tenant remains for recovery, but it may have no owner afterward. Transfer
ownership or export the tenant before deleting its last owner account.
