DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knot_bootstrap') THEN
    CREATE ROLE knot_bootstrap NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'knot_bootstrap'
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'Knot bootstrap role has unsafe attributes';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = 'knot_bootstrap'
  ) THEN
    RAISE EXCEPTION 'Knot bootstrap role must not be a member of another role';
  END IF;
END
$$;

GRANT knot_bootstrap TO CURRENT_USER;
GRANT knot_resolver TO CURRENT_USER;

DROP FUNCTION resolve_session(text);
DROP FUNCTION tenant_ids_for_user(uuid);
REVOKE knot_resolver FROM CURRENT_USER;
DROP TABLE sessions;

ALTER TABLE users ADD COLUMN auth_user_id text;
ALTER TABLE users ADD COLUMN claimed_at timestamptz;
ALTER TABLE users
  ADD CONSTRAINT users_auth_user_id_fk
  FOREIGN KEY (auth_user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX users_auth_user_id_idx
  ON users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

UPDATE auth."user" SET email = lower(trim(email));
CREATE UNIQUE INDEX auth_user_email_lower_idx ON auth."user" (lower(email));

COMMENT ON TABLE users IS
  'Workspace identity projection. auth.user and auth.session are the sole human authentication authority.';
COMMENT ON COLUMN users.auth_user_id IS
  'Better Auth user ID. A verified session may claim an unmapped legacy row with the same keyed email digest.';

ALTER TABLE tenant_members
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX tenant_members_one_default_idx
  ON tenant_members (user_id)
  WHERE is_default;

ALTER TABLE auth.session
  ADD CONSTRAINT auth_session_id_user_id_unique UNIQUE (id, "userId");

CREATE TABLE session_tenant_selections (
  auth_session_id text PRIMARY KEY,
  auth_user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (auth_session_id, auth_user_id)
    REFERENCES auth.session(id, "userId") ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE
);

ALTER TABLE session_tenant_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_tenant_selections FORCE ROW LEVEL SECURITY;

CREATE POLICY bootstrap_users ON users TO knot_bootstrap
  USING (true) WITH CHECK (true);
CREATE POLICY bootstrap_tenants ON tenants TO knot_bootstrap
  USING (true) WITH CHECK (true);
CREATE POLICY bootstrap_tenant_members ON tenant_members TO knot_bootstrap
  USING (true) WITH CHECK (true);
CREATE POLICY bootstrap_session_selection ON session_tenant_selections TO knot_bootstrap
  USING (true) WITH CHECK (true);
CREATE POLICY bootstrap_audit_insert ON audit_events FOR INSERT TO knot_bootstrap
  WITH CHECK (true);

GRANT USAGE, CREATE ON SCHEMA public TO knot_bootstrap;
GRANT USAGE ON SCHEMA auth TO knot_bootstrap;
GRANT SELECT ON auth."user", auth.session TO knot_bootstrap;
GRANT SELECT, INSERT, UPDATE ON users, tenants, tenant_members TO knot_bootstrap;
GRANT SELECT, INSERT, UPDATE, DELETE ON session_tenant_selections TO knot_bootstrap;
GRANT INSERT ON audit_events TO knot_bootstrap;

REVOKE SELECT, INSERT, UPDATE ON users FROM knot_app;
REVOKE ALL ON session_tenant_selections FROM PUBLIC, knot_app, knot_resolver;

CREATE FUNCTION resolve_or_bootstrap_workspace(
  lookup_auth_session_id text,
  lookup_auth_user_id text,
  lookup_email_digest text,
  lookup_email_digest_version smallint,
  default_workspace_name text
)
RETURNS TABLE (
  user_id uuid,
  tenant_id uuid,
  tenant_name text,
  member_role text,
  suspended_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  resolved_user_id uuid;
  resolved_tenant_id uuid;
  resolved_tenant_name text;
  resolved_member_role text;
  resolved_suspended_at timestamptz;
  did_claim_legacy boolean := false;
BEGIN
  IF lookup_email_digest !~ '^[a-f0-9]{64}$' OR lookup_email_digest_version < 1 THEN
    RAISE EXCEPTION 'Invalid identity digest' USING ERRCODE = '22023';
  END IF;
  IF length(trim(default_workspace_name)) < 1 OR length(default_workspace_name) > 100 THEN
    RAISE EXCEPTION 'Invalid workspace name' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(lookup_auth_user_id, 12648430));

  IF NOT EXISTS (
    SELECT 1
    FROM auth.session AS auth_session
    JOIN auth."user" AS auth_user ON auth_user.id = auth_session."userId"
    WHERE auth_session.id = lookup_auth_session_id
      AND auth_session."userId" = lookup_auth_user_id
      AND auth_session."expiresAt" > now()
      AND auth_user."emailVerified"
  ) THEN
    RETURN;
  END IF;

  SELECT projected_user.id INTO resolved_user_id
  FROM public.users AS projected_user
  WHERE projected_user.auth_user_id = lookup_auth_user_id;

  IF resolved_user_id IS NULL THEN
    SELECT projected_user.id INTO resolved_user_id
    FROM public.users AS projected_user
    WHERE projected_user.auth_user_id IS NULL
      AND projected_user.email_digest = lookup_email_digest
    FOR UPDATE;
    did_claim_legacy := resolved_user_id IS NOT NULL;
  END IF;

  IF resolved_user_id IS NULL THEN
    INSERT INTO public.users (auth_user_id, email_digest, email_digest_version)
    VALUES (lookup_auth_user_id, lookup_email_digest, lookup_email_digest_version)
    RETURNING id INTO resolved_user_id;
  ELSE
    UPDATE public.users
    SET auth_user_id = lookup_auth_user_id,
        email_digest = lookup_email_digest,
        email_digest_version = lookup_email_digest_version,
        claimed_at = CASE WHEN did_claim_legacy THEN now() ELSE claimed_at END
    WHERE id = resolved_user_id
      AND (
        auth_user_id IS DISTINCT FROM lookup_auth_user_id
        OR (email_digest, email_digest_version) IS DISTINCT FROM
           (lookup_email_digest, lookup_email_digest_version)
      );
  END IF;

  SELECT selected_tenant.id, selected_tenant.name, membership.role,
         selected_tenant.suspended_at
  INTO resolved_tenant_id, resolved_tenant_name, resolved_member_role,
       resolved_suspended_at
  FROM public.session_tenant_selections AS selection
  JOIN public.tenant_members AS membership
    ON membership.tenant_id = selection.tenant_id
   AND membership.user_id = selection.user_id
  JOIN public.tenants AS selected_tenant ON selected_tenant.id = selection.tenant_id
  WHERE selection.auth_session_id = lookup_auth_session_id
    AND selection.auth_user_id = lookup_auth_user_id
    AND selection.user_id = resolved_user_id;

  IF resolved_tenant_id IS NULL THEN
    SELECT default_tenant.id, default_tenant.name, membership.role,
           default_tenant.suspended_at
    INTO resolved_tenant_id, resolved_tenant_name, resolved_member_role,
         resolved_suspended_at
    FROM public.tenant_members AS membership
    JOIN public.tenants AS default_tenant ON default_tenant.id = membership.tenant_id
    WHERE membership.user_id = resolved_user_id
      AND membership.is_default
    LIMIT 1;
  END IF;

  IF resolved_tenant_id IS NULL THEN
    SELECT existing_tenant.id, existing_tenant.name, membership.role,
           existing_tenant.suspended_at
    INTO resolved_tenant_id, resolved_tenant_name, resolved_member_role,
         resolved_suspended_at
    FROM public.tenant_members AS membership
    JOIN public.tenants AS existing_tenant ON existing_tenant.id = membership.tenant_id
    WHERE membership.user_id = resolved_user_id
    ORDER BY existing_tenant.created_at, existing_tenant.id
    LIMIT 1;

    IF resolved_tenant_id IS NOT NULL THEN
      UPDATE public.tenant_members AS membership
      SET is_default = true
      WHERE membership.tenant_id = resolved_tenant_id
        AND membership.user_id = resolved_user_id;
    END IF;
  END IF;

  IF resolved_tenant_id IS NULL THEN
    INSERT INTO public.tenants (name)
    VALUES (trim(default_workspace_name))
    RETURNING tenants.id, tenants.name, tenants.suspended_at
    INTO resolved_tenant_id, resolved_tenant_name, resolved_suspended_at;

    INSERT INTO public.tenant_members (tenant_id, user_id, role, is_default)
    VALUES (resolved_tenant_id, resolved_user_id, 'owner', true);
    resolved_member_role := 'owner';
  END IF;

  INSERT INTO public.session_tenant_selections (
    auth_session_id, auth_user_id, user_id, tenant_id
  ) VALUES (
    lookup_auth_session_id, lookup_auth_user_id, resolved_user_id, resolved_tenant_id
  )
  ON CONFLICT (auth_session_id) DO UPDATE
  SET auth_user_id = EXCLUDED.auth_user_id,
      user_id = EXCLUDED.user_id,
      tenant_id = EXCLUDED.tenant_id,
      selected_at = now();

  IF did_claim_legacy THEN
    INSERT INTO public.audit_events (
      tenant_id, principal_kind, principal_id, action,
      target_kind, target_id, outcome,
      metadata
    ) VALUES (
      resolved_tenant_id, 'human-session', resolved_user_id,
      'identity.legacy-claim', 'user', resolved_user_id, 'succeeded',
      jsonb_build_object('digestVersion', lookup_email_digest_version)
    );
  END IF;

  RETURN QUERY SELECT resolved_user_id, resolved_tenant_id,
                      resolved_tenant_name, resolved_member_role,
                      resolved_suspended_at;
END
$$;

CREATE FUNCTION select_workspace_for_session(
  lookup_auth_session_id text,
  lookup_auth_user_id text,
  requested_tenant_id uuid
)
RETURNS TABLE (
  user_id uuid,
  tenant_id uuid,
  tenant_name text,
  member_role text,
  suspended_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  resolved_user_id uuid;
  resolved_tenant_name text;
  resolved_member_role text;
  resolved_suspended_at timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM auth.session AS auth_session
    JOIN auth."user" AS auth_user ON auth_user.id = auth_session."userId"
    WHERE auth_session.id = lookup_auth_session_id
      AND auth_session."userId" = lookup_auth_user_id
      AND auth_session."expiresAt" > now()
      AND auth_user."emailVerified"
  ) THEN
    RETURN;
  END IF;

  SELECT id INTO resolved_user_id
  FROM public.users WHERE auth_user_id = lookup_auth_user_id;

  SELECT tenant.name, membership.role, tenant.suspended_at
  INTO resolved_tenant_name, resolved_member_role, resolved_suspended_at
  FROM public.tenant_members AS membership
  JOIN public.tenants AS tenant ON tenant.id = membership.tenant_id
  WHERE membership.user_id = resolved_user_id
    AND membership.tenant_id = requested_tenant_id;

  IF resolved_user_id IS NULL OR resolved_tenant_name IS NULL OR resolved_suspended_at IS NOT NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.session_tenant_selections (
    auth_session_id, auth_user_id, user_id, tenant_id
  ) VALUES (
    lookup_auth_session_id, lookup_auth_user_id, resolved_user_id,
    requested_tenant_id
  )
  ON CONFLICT (auth_session_id) DO UPDATE
  SET auth_user_id = EXCLUDED.auth_user_id,
      user_id = EXCLUDED.user_id,
      tenant_id = EXCLUDED.tenant_id,
      selected_at = now();

  RETURN QUERY SELECT resolved_user_id, requested_tenant_id,
                      resolved_tenant_name, resolved_member_role,
                      resolved_suspended_at;
END
$$;

ALTER FUNCTION resolve_or_bootstrap_workspace(text, text, text, smallint, text)
  OWNER TO knot_bootstrap;
ALTER FUNCTION select_workspace_for_session(text, text, uuid)
  OWNER TO knot_bootstrap;

REVOKE CREATE ON SCHEMA public FROM knot_bootstrap;
REVOKE knot_bootstrap FROM CURRENT_USER;

REVOKE ALL ON FUNCTION
  resolve_or_bootstrap_workspace(text, text, text, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION select_workspace_for_session(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  resolve_or_bootstrap_workspace(text, text, text, smallint, text) TO knot_app;
GRANT EXECUTE ON FUNCTION select_workspace_for_session(text, text, uuid) TO knot_app;
