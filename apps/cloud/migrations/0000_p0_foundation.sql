CREATE TYPE credential_kind AS ENUM (
  'human-session',
  'connector-key',
  'consumer-api-key',
  'first-party-service'
);

CREATE TYPE scope_name AS ENUM (
  'anytype.objects.read',
  'anytype.objects.write',
  'anytype.collections.write',
  'anytype.files.write',
  'anytype.chats.read',
  'anytype.chats.write',
  'publications.write',
  'publications.unpublish'
);

CREATE TYPE publication_state AS ENUM (
  'draft',
  'ready',
  'disabled',
  'unpublished',
  'abandoned'
);

CREATE TYPE command_state AS ENUM (
  'pending',
  'leased',
  'succeeded',
  'rejected-by-local-policy',
  'failed',
  'expired',
  'cancelled',
  'dead-lettered'
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knot_app') THEN
    CREATE ROLE knot_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knot_resolver') THEN
    CREATE ROLE knot_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('knot_app', 'knot_resolver')
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'Knot runtime roles have unsafe attributes';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE member_role.rolname IN ('knot_app', 'knot_resolver')
  ) THEN
    RAISE EXCEPTION 'Knot runtime roles must not be members of any other role';
  END IF;
END
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_digest text NOT NULL UNIQUE CHECK (email_digest ~ '^[a-f0-9]{64}$'),
  email_digest_version smallint NOT NULL CHECK (email_digest_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email_digest text NOT NULL CHECK (email_digest ~ '^[a-f0-9]{64}$'),
  email_digest_version smallint NOT NULL CHECK (email_digest_version > 0),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  invited_role text NOT NULL CHECK (invited_role IN ('admin', 'member')),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invitations_pending_email_idx
  ON invitations (tenant_id, email_digest)
  WHERE redeemed_at IS NULL;

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'
    AND slug NOT IN ('api', 'next', 'www', 'admin', 'health', 'assets')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  protocol_version text NOT NULL,
  public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
  scopes scope_name[] NOT NULL DEFAULT '{}' CHECK (
    array_ndims(scopes) IS NULL OR
    (array_ndims(scopes) = 1 AND array_position(scopes, NULL) IS NULL)
  ),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_id text NOT NULL UNIQUE CHECK (key_id ~ '^[A-Za-z0-9_-]{16}$'),
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  digest_version smallint NOT NULL DEFAULT 1 CHECK (digest_version > 0),
  scopes scope_name[] NOT NULL DEFAULT '{}' CHECK (
    array_ndims(scopes) IS NULL OR
    (array_ndims(scopes) = 1 AND array_position(scopes, NULL) IS NULL)
  ),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE api_key_connectors (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, api_key_id, connector_id),
  FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES api_keys(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  slug text NOT NULL CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$'
    AND slug !~ '//'
    AND split_part(slug, '/', 1) NOT IN ('api', '_next', 'www', 'admin', 'health', 'assets')
  ),
  current_version_id uuid,
  disabled_at timestamptz,
  unpublished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)
    REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX publications_active_slug_idx
  ON publications (site_id, slug)
  WHERE unpublished_at IS NULL;

CREATE TABLE publication_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL,
  state publication_state NOT NULL DEFAULT 'draft',
  schema_version text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  bundle_path text,
  created_by_connector_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, publication_id, id),
  FOREIGN KEY (tenant_id, publication_id)
    REFERENCES publications(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE publications
  ADD CONSTRAINT publications_current_version_fk
  FOREIGN KEY (tenant_id, id, current_version_id)
  REFERENCES publication_versions(tenant_id, publication_id, id)
  ON DELETE RESTRICT;

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  pathname text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  verified_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sha256),
  UNIQUE (tenant_id, pathname)
);

CREATE TABLE publication_assets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication_version_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, publication_version_id, asset_id),
  FOREIGN KEY (tenant_id, publication_version_id)
    REFERENCES publication_versions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, asset_id)
    REFERENCES assets(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL,
  required_scope scope_name NOT NULL,
  payload jsonb NOT NULL,
  state command_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  not_before timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  lease_token_digest text CHECK (lease_token_digest ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 200),
  created_by_kind credential_kind NOT NULL,
  created_by_id uuid NOT NULL,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, created_by_kind, created_by_id, idempotency_key),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE CASCADE,
  CHECK (pg_column_size(payload) <= 1048576),
  CHECK (attempt_count <= max_attempts),
  CHECK (not_before >= created_at),
  CHECK (expires_at > not_before AND expires_at <= created_at + interval '7 days'),
  CHECK (lease_expires_at IS NULL OR lease_expires_at <= expires_at),
  CHECK (
    (state = 'leased') =
    (lease_token_digest IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX commands_claim_idx
  ON commands (tenant_id, connector_id, state, not_before, created_at)
  WHERE state IN ('pending', 'leased');

CREATE INDEX commands_lease_reaper_idx
  ON commands (tenant_id, lease_expires_at)
  WHERE state = 'leased';

CREATE TABLE command_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_token_digest text NOT NULL CHECK (lease_token_digest ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome command_state,
  error_code text,
  UNIQUE (tenant_id, command_id, attempt),
  FOREIGN KEY (tenant_id, command_id)
    REFERENCES commands(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credential_kind credential_kind NOT NULL,
  credential_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, credential_kind, credential_id, idempotency_key)
);

CREATE INDEX idempotency_records_expiry_idx
  ON idempotency_records (tenant_id, expires_at);

CREATE TABLE deletion_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication_id uuid,
  asset_id uuid,
  pathname text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, publication_id)
    REFERENCES publications(tenant_id, id) ON DELETE SET NULL (publication_id),
  FOREIGN KEY (tenant_id, asset_id)
    REFERENCES assets(tenant_id, id) ON DELETE SET NULL (asset_id)
);

CREATE UNIQUE INDEX deletion_outbox_pending_path_idx
  ON deletion_outbox (tenant_id, pathname)
  WHERE completed_at IS NULL;

CREATE INDEX deletion_outbox_claim_idx
  ON deletion_outbox (tenant_id, next_attempt_at, created_at)
  WHERE completed_at IS NULL;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  principal_kind credential_kind NOT NULL,
  principal_id uuid,
  actor_digest text CHECK (actor_digest ~ '^[a-f0-9]{64}$'),
  actor_digest_version smallint CHECK (actor_digest_version > 0),
  action text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN users.email_digest IS 'HMAC-SHA256 of normalized email';
COMMENT ON COLUMN invitations.email_digest IS 'HMAC-SHA256 of normalized email';
COMMENT ON COLUMN audit_events.actor_digest IS 'HMAC-SHA256 of the external actor identifier';

CREATE INDEX audit_events_tenant_created_idx
  ON audit_events (tenant_id, created_at DESC);

GRANT knot_resolver TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO knot_resolver;
GRANT SELECT ON users, sessions, tenant_members, invitations, connectors, api_keys TO knot_resolver;

CREATE FUNCTION resolve_connector(lookup_id uuid)
RETURNS TABLE (
  id uuid, tenant_id uuid, public_key bytea, protocol_version text,
  scopes scope_name[], revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.tenant_id, c.public_key, c.protocol_version, c.scopes, c.revoked_at
  FROM public.connectors AS c WHERE c.id = lookup_id
$$;

CREATE FUNCTION resolve_api_key(lookup_key_id text)
RETURNS TABLE (
  id uuid, tenant_id uuid, key_digest text, digest_version smallint,
  scopes scope_name[], expires_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT k.id, k.tenant_id, k.key_digest, k.digest_version,
         k.scopes, k.expires_at, k.revoked_at
  FROM public.api_keys AS k WHERE k.key_id = lookup_key_id
$$;

CREATE FUNCTION resolve_invitation(lookup_token_digest text)
RETURNS TABLE (
  id uuid, tenant_id uuid, email_digest text, email_digest_version smallint,
  invited_role text, expires_at timestamptz, redeemed_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.tenant_id, i.email_digest, i.email_digest_version,
         i.invited_role, i.expires_at, i.redeemed_at
  FROM public.invitations AS i WHERE i.token_digest = lookup_token_digest
$$;

CREATE FUNCTION resolve_session(lookup_token_digest text)
RETURNS TABLE (id uuid, user_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.user_id, s.expires_at, s.revoked_at
  FROM public.sessions AS s WHERE s.token_digest = lookup_token_digest
$$;

CREATE FUNCTION tenant_ids_for_user(lookup_user_id uuid)
RETURNS TABLE (tenant_id uuid, role text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT m.tenant_id, m.role
  FROM public.tenant_members AS m WHERE m.user_id = lookup_user_id
$$;

ALTER FUNCTION resolve_connector(uuid) OWNER TO knot_resolver;
ALTER FUNCTION resolve_api_key(text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_invitation(text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_session(text) OWNER TO knot_resolver;
ALTER FUNCTION tenant_ids_for_user(uuid) OWNER TO knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;

REVOKE ALL ON FUNCTION resolve_connector(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_invitation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_ids_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_connector(uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_invitation(text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_session(text) TO knot_app;
GRANT EXECUTE ON FUNCTION tenant_ids_for_user(uuid) TO knot_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO knot_app, knot_resolver;
GRANT SELECT, INSERT, UPDATE ON users, sessions TO knot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, tenant_members, invitations, sites, connectors, api_keys,
  api_key_connectors, publications, publication_versions, assets,
  publication_assets, commands, idempotency_records, deletion_outbox
TO knot_app;
GRANT SELECT, INSERT ON command_attempts, audit_events TO knot_app;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE ALL ON schema_migrations FROM knot_app;
  END IF;
END
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_members', 'invitations', 'sites', 'connectors', 'api_keys',
    'api_key_connectors', 'publications', 'publication_versions', 'assets',
    'publication_assets', 'commands', 'idempotency_records', 'deletion_outbox'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['command_attempts', 'audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_select ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

CREATE POLICY tenant_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY current_user_access ON users TO knot_app
  USING (id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY current_user_access ON sessions TO knot_app
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY resolver_select ON users FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_select ON sessions FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_select ON tenant_members FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_select ON invitations FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_select ON connectors FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_select ON api_keys FOR SELECT TO knot_resolver USING (true);
