# Database credential boundary

Knot Cloud uses two PostgreSQL credentials:

- `MIGRATION_DATABASE_URL` belongs only in a trusted operator shell. It owns schema changes and may
  create roles. Never deploy it to Vercel or a running container.
- `DATABASE_URL` authenticates directly as the migration-created `knot_app` role. That role must not
  be a member of any other PostgreSQL role and must keep `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`,
  `NOCREATEROLE`, and `NOINHERIT`.

After applying the migration, set a generated password directly on `knot_app` through the managed
database's secure SQL console or an equivalent secret-safe administrative path. Do not create the
runtime role through Neon's Console/API role shortcut: those roles may inherit or be able to assume
`neon_superuser`, which Knot rejects. Store the resulting runtime URL only as `DATABASE_URL`.

The application verifies the runtime role before protected routes are enabled. Credential lookup
uses narrowly scoped security-definer functions owned by the no-login `knot_resolver` role; raw
tenant table reads still fail closed before a tenant context is established.
