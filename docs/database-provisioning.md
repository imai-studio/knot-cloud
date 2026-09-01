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

The application verifies the runtime role before protected routes are enabled. Credential lookup
uses narrow security-definer functions owned by the no-login `knot_resolver` role. Human workspace
bootstrap and selection use separate functions owned by the no-login `knot_bootstrap` role. Neither
role can create schema objects, bypass row-level security, or inherit another role. Raw tenant table
reads still fail closed before a tenant context is established.

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
