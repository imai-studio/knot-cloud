# Database credential boundary

Knot Cloud uses separate credentials for migrations and application traffic.

- `MIGRATION_DATABASE_URL` belongs only in a trusted operator shell. It owns schema changes and may
  create roles. It must own the `public` schema and be able to grant `knot_resolver` to itself while
  installing security-definer functions. Never deploy it to Vercel or a running container.
- `DATABASE_URL` authenticates directly as the migration-created `knot_app` role. That role must not
  be a member of any other PostgreSQL role and must keep `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`,
  `NOCREATEROLE`, and `NOINHERIT`.

After applying the migration, set a generated password on `knot_app` through the managed database's
secure SQL console or another path that does not expose the secret. Do not create the runtime role
through Neon's console or API role shortcut. A role created that way may inherit, or be allowed to
assume, `neon_superuser`. Knot rejects such a role. Store the resulting runtime URL only as
`DATABASE_URL`.

The migrator must own the `public` schema. It must also be able to grant membership in the no-login
`knot_resolver` role while transferring resolver-function ownership. In PostgreSQL terms, the
migrator needs `ADMIN OPTION` on `knot_resolver` after that role exists. Run migrations with one
consistent owner role; changing migrator roles between releases can make function ownership and
role grants fail partway through an upgrade.

The migration runner checks the ledger before changing the schema. It refuses to run when an
applied migration is absent from the checkout, when an applied file's digest changed, or when a
pending filename sorts before the newest applied filename. Restore the expected checkout or repair
the ledger from a verified backup instead of bypassing these checks.

The application verifies the runtime role before protected routes are enabled. Credential lookup
uses narrowly scoped security-definer functions owned by the no-login `knot_resolver` role; raw
tenant table reads still fail closed before a tenant context is established.

Signed connector routes also require an Upstash Redis database. Set `REPLAY_STORE_DRIVER=upstash`
and a complete credential pair. Self-managed deployments can use `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`; Vercel's official Upstash integration supplies `KV_REST_API_URL` and
`KV_REST_API_TOKEN`. Explicit `UPSTASH_*` values take precedence over the Vercel names. Use a
database dedicated to the deployment, and limit the token to that database. Run
`pnpm --filter @imai/knot-cloud smoke:providers` before enabling connector traffic; the smoke check
verifies the restricted Neon role, sends a read-only Redis `PING`, and performs a private R2
write/read/delete round trip.

Human workspace bootstrap and selection use separate functions owned by the no-login
`knot_bootstrap` role. Neither no-login role can create schema objects, bypass row-level security,
or inherit another role.

Connector pairing adds the no-login `knot_pairing` role. It owns only
`poll_pairing_session(uuid,text,timestamptz)`. The role can read and update `pairing_sessions` through
a policy that permits token lookup before a tenant is known. It cannot read tenant membership,
approve a connector, create schema objects, bypass row-level security, or inherit another role. The
migration revokes the temporary schema-create grant before it returns.

`knot_app` creates and lists pairing requests inside an active tenant context. It calls separate
approval, denial, rename, and revoke functions. Those functions check that the actor is still an
owner or admin inside the same transaction. Removing a member keeps historical pairing rows and
clears their `created_by_user_id` value.

Approved pairing rows use an `ON DELETE NO ACTION` connector reference. PostgreSQL checks it at the
end of a tenant deletion statement, after the tenant cascade has removed both rows. A row-level
connector delete still fails while pairing history refers to it.

Before applying the tenant bootstrap migration to an existing Better Auth database, check for email
addresses that differ only by case:

```sql
SELECT lower(email)
FROM auth."user"
GROUP BY lower(email)
HAVING count(*) > 1;
```

Resolve every returned collision before migration. The migration normalizes emails and creates a
case-insensitive unique index.
