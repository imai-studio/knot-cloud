CREATE TYPE pairing_state AS ENUM ('pending', 'approved', 'denied', 'expired');

CREATE FUNCTION knot_array_is_unique(values_array anyarray)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT values_array IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(values_array) AS element
      WHERE element IS NULL
    )
    AND pg_catalog.cardinality(values_array) = (
      SELECT pg_catalog.count(DISTINCT element)
      FROM pg_catalog.unnest(values_array) AS element
    )
$$;

CREATE UNIQUE INDEX connectors_tenant_public_key_idx
  ON connectors (tenant_id, public_key);

CREATE TABLE connector_site_grants (
  tenant_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, site_id),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id)
    REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE connector_slug_grants (
  tenant_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  slug_grant text NOT NULL CHECK (
    length(slug_grant) BETWEEN 1 AND 200
    AND slug_grant !~ '//'
    AND slug_grant ~ '^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?(?:/\*)?$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, slug_grant),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE pairing_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id uuid,
  connector_name text NOT NULL CHECK (
    length(trim(connector_name)) BETWEEN 1 AND 100
  ),
  protocol_version text NOT NULL,
  public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
  requested_scopes scope_name[] NOT NULL CHECK (
    cardinality(requested_scopes) >= 1
    AND knot_array_is_unique(requested_scopes)
  ),
  requested_site_ids uuid[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(requested_site_ids) <= 100
    AND knot_array_is_unique(requested_site_ids)
  ),
  requested_slug_grants text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(requested_slug_grants) <= 100
    AND knot_array_is_unique(requested_slug_grants)
  ),
  poll_token_digest text NOT NULL UNIQUE CHECK (
    poll_token_digest ~ '^[a-f0-9]{64}$'
  ),
  state pairing_state NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  approved_connector_id uuid,
  granted_scopes scope_name[],
  granted_site_ids uuid[],
  granted_slug_grants text[],
  approved_at timestamptz,
  denied_at timestamptz,
  poll_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES tenant_members(tenant_id, user_id)
    ON DELETE SET NULL (created_by_user_id),
  FOREIGN KEY (tenant_id, approved_connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE NO ACTION,
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'pending' AND approved_connector_id IS NULL AND approved_at IS NULL
      AND denied_at IS NULL AND granted_scopes IS NULL
      AND granted_site_ids IS NULL AND granted_slug_grants IS NULL)
    OR (state = 'approved' AND approved_connector_id IS NOT NULL
      AND approved_at IS NOT NULL AND denied_at IS NULL
      AND granted_scopes IS NOT NULL
      AND granted_site_ids IS NOT NULL
      AND granted_slug_grants IS NOT NULL
      AND cardinality(granted_scopes) >= 1
      AND cardinality(granted_site_ids) <= 100
      AND cardinality(granted_slug_grants) <= 100
      AND knot_array_is_unique(granted_scopes)
      AND knot_array_is_unique(granted_site_ids)
      AND knot_array_is_unique(granted_slug_grants))
    OR (state = 'denied' AND approved_connector_id IS NULL AND approved_at IS NULL
      AND denied_at IS NOT NULL AND granted_scopes IS NULL
      AND granted_site_ids IS NULL AND granted_slug_grants IS NULL)
    OR (state = 'expired' AND approved_connector_id IS NULL AND approved_at IS NULL
      AND denied_at IS NULL AND granted_scopes IS NULL
      AND granted_site_ids IS NULL AND granted_slug_grants IS NULL)
  )
);

CREATE INDEX pairing_sessions_tenant_state_created_idx
  ON pairing_sessions (tenant_id, state, created_at DESC);

CREATE INDEX pairing_sessions_tenant_expiry_idx
  ON pairing_sessions (tenant_id, expires_at);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'connector_site_grants', 'connector_slug_grants', 'pairing_sessions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  connector_site_grants, connector_slug_grants, pairing_sessions
TO knot_app;
REVOKE ALL ON FUNCTION knot_array_is_unique(anyarray) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knot_array_is_unique(anyarray) TO knot_app;

CREATE FUNCTION approve_pairing_session(
  requested_tenant_id uuid,
  requested_pairing_id uuid,
  actor_user_id uuid,
  approved_scopes scope_name[],
  approved_site_ids uuid[],
  approved_slug_grants text[],
  decision_at timestamptz
)
RETURNS TABLE (
  outcome text,
  connector_id uuid,
  approved_at timestamptz
)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  pairing_record pairing_sessions%ROWTYPE;
  resolved_connector_id uuid;
  resolved_approved_at timestamptz;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pairing tenant does not match the active tenant'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_members
    WHERE tenant_id = requested_tenant_id
      AND user_id = actor_user_id
      AND role IN ('owner', 'admin')
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF approved_scopes IS NULL
     OR approved_site_ids IS NULL
     OR approved_slug_grants IS NULL
     OR cardinality(approved_scopes) < 1
     OR cardinality(approved_site_ids) > 100
     OR cardinality(approved_slug_grants) > 100
     OR array_position(approved_scopes, NULL) IS NOT NULL
     OR array_position(approved_site_ids, NULL) IS NOT NULL
     OR array_position(approved_slug_grants, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid pairing grant' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM unnest(approved_scopes) AS scope_value)
     <> (SELECT count(DISTINCT scope_value) FROM unnest(approved_scopes) AS scope_value)
     OR (SELECT count(*) FROM unnest(approved_site_ids) AS site_value)
     <> (SELECT count(DISTINCT site_value) FROM unnest(approved_site_ids) AS site_value)
     OR (SELECT count(*) FROM unnest(approved_slug_grants) AS slug_value)
     <> (SELECT count(DISTINCT slug_value) FROM unnest(approved_slug_grants) AS slug_value) THEN
    RAISE EXCEPTION 'Pairing grants must be unique' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO pairing_record
  FROM pairing_sessions
  WHERE tenant_id = requested_tenant_id AND id = requested_pairing_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not-found'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF pairing_record.state = 'pending' AND pairing_record.expires_at <= decision_at THEN
    UPDATE pairing_sessions
    SET state = 'expired', updated_at = decision_at
    WHERE tenant_id = requested_tenant_id AND id = requested_pairing_id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF pairing_record.state = 'approved' THEN
    IF pairing_record.granted_scopes @> approved_scopes
       AND approved_scopes @> pairing_record.granted_scopes
       AND pairing_record.granted_site_ids @> approved_site_ids
       AND approved_site_ids @> pairing_record.granted_site_ids
       AND pairing_record.granted_slug_grants @> approved_slug_grants
       AND approved_slug_grants @> pairing_record.granted_slug_grants THEN
      RETURN QUERY SELECT 'approved'::text,
        pairing_record.approved_connector_id, pairing_record.approved_at;
    ELSE
      RETURN QUERY SELECT 'conflict'::text,
        pairing_record.approved_connector_id, pairing_record.approved_at;
    END IF;
    RETURN;
  END IF;
  IF pairing_record.state = 'expired' THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF pairing_record.state <> 'pending' THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF NOT pairing_record.requested_scopes @> approved_scopes
     OR NOT pairing_record.requested_site_ids @> approved_site_ids
     OR NOT pairing_record.requested_slug_grants @> approved_slug_grants THEN
    RETURN QUERY SELECT 'scope-escalation'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF (
    SELECT count(*) FROM sites
    WHERE tenant_id = requested_tenant_id AND id = ANY(approved_site_ids)
  ) <> cardinality(approved_site_ids) THEN
    RETURN QUERY SELECT 'unknown-site'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(encode(pairing_record.public_key, 'hex'), 134802772)
  );

  SELECT id INTO resolved_connector_id
  FROM connectors
  WHERE tenant_id = requested_tenant_id
    AND public_key = pairing_record.public_key
  FOR UPDATE;
  IF resolved_connector_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM connectors
    WHERE tenant_id = requested_tenant_id
      AND id = resolved_connector_id
      AND revoked_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'revoked-key'::text, resolved_connector_id, NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO connectors (
    tenant_id, name, protocol_version, public_key, scopes
  ) VALUES (
    requested_tenant_id, pairing_record.connector_name,
    pairing_record.protocol_version, pairing_record.public_key, approved_scopes
  )
  ON CONFLICT (tenant_id, public_key) DO UPDATE
  SET name = EXCLUDED.name,
      protocol_version = EXCLUDED.protocol_version,
      scopes = EXCLUDED.scopes
  WHERE connectors.revoked_at IS NULL
  RETURNING id INTO resolved_connector_id;

  IF resolved_connector_id IS NULL THEN
    RETURN QUERY SELECT 'revoked-key'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  DELETE FROM connector_site_grants
  WHERE connector_site_grants.tenant_id = requested_tenant_id
    AND connector_site_grants.connector_id = resolved_connector_id;
  INSERT INTO connector_site_grants (tenant_id, connector_id, site_id)
  SELECT requested_tenant_id, resolved_connector_id, site_id
  FROM unnest(approved_site_ids) AS site_id;

  DELETE FROM connector_slug_grants
  WHERE connector_slug_grants.tenant_id = requested_tenant_id
    AND connector_slug_grants.connector_id = resolved_connector_id;
  INSERT INTO connector_slug_grants (tenant_id, connector_id, slug_grant)
  SELECT requested_tenant_id, resolved_connector_id, slug_grant
  FROM unnest(approved_slug_grants) AS slug_grant;

  resolved_approved_at := decision_at;
  UPDATE pairing_sessions
  SET state = 'approved',
      approved_connector_id = resolved_connector_id,
      granted_scopes = approved_scopes,
      granted_site_ids = approved_site_ids,
      granted_slug_grants = approved_slug_grants,
      approved_at = resolved_approved_at,
      expires_at = decision_at + interval '10 minutes',
      updated_at = decision_at
  WHERE tenant_id = requested_tenant_id AND id = requested_pairing_id;

  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action,
    target_kind, target_id, outcome, metadata
  ) VALUES (
    requested_tenant_id, 'human-session', actor_user_id,
    'connector.pair.approve', 'connector', resolved_connector_id, 'succeeded',
    pg_catalog.jsonb_build_object(
      'pairingId', requested_pairing_id,
      'scopes', approved_scopes,
      'siteIds', approved_site_ids,
      'slugGrants', approved_slug_grants
    )
  );

  RETURN QUERY SELECT 'approved'::text, resolved_connector_id, resolved_approved_at;
END
$$;

CREATE FUNCTION deny_pairing_session(
  requested_tenant_id uuid,
  requested_pairing_id uuid,
  actor_user_id uuid,
  decision_at timestamptz
)
RETURNS text
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  pairing_record pairing_sessions%ROWTYPE;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pairing tenant does not match the active tenant'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_members
    WHERE tenant_id = requested_tenant_id
      AND user_id = actor_user_id
      AND role IN ('owner', 'admin')
  ) THEN
    RETURN 'forbidden';
  END IF;

  SELECT * INTO pairing_record
  FROM pairing_sessions
  WHERE tenant_id = requested_tenant_id AND id = requested_pairing_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not-found'; END IF;
  IF pairing_record.state = 'pending' AND pairing_record.expires_at <= decision_at THEN
    UPDATE pairing_sessions
    SET state = 'expired', updated_at = decision_at
    WHERE tenant_id = requested_tenant_id AND id = requested_pairing_id;
    RETURN 'expired';
  END IF;
  IF pairing_record.state = 'denied' THEN RETURN 'denied'; END IF;
  IF pairing_record.state <> 'pending' THEN RETURN 'conflict'; END IF;

  UPDATE pairing_sessions
  SET state = 'denied', denied_at = decision_at,
      expires_at = decision_at + interval '10 minutes', updated_at = decision_at
  WHERE tenant_id = requested_tenant_id AND id = requested_pairing_id;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action,
    target_kind, target_id, outcome
  ) VALUES (
    requested_tenant_id, 'human-session', actor_user_id,
    'connector.pair.deny', 'pairing-session', requested_pairing_id, 'succeeded'
  );
  RETURN 'denied';
END
$$;

CREATE FUNCTION rename_connector(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  actor_user_id uuid,
  requested_name text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_name text;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Connector tenant does not match the active tenant'
      USING ERRCODE = '42501';
  END IF;
  IF requested_name IS NULL
     OR length(trim(requested_name)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid connector name' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_members
    WHERE tenant_id = requested_tenant_id
      AND user_id = actor_user_id
      AND role IN ('owner', 'admin')
  ) THEN
    RETURN false;
  END IF;
  SELECT name INTO previous_name
  FROM connectors
  WHERE tenant_id = requested_tenant_id AND id = requested_connector_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE connectors SET name = trim(requested_name)
  WHERE tenant_id = requested_tenant_id AND id = requested_connector_id;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action,
    target_kind, target_id, outcome, metadata
  ) VALUES (
    requested_tenant_id, 'human-session', actor_user_id,
    'connector.rename', 'connector', requested_connector_id, 'succeeded',
    pg_catalog.jsonb_build_object(
      'oldName', previous_name,
      'newName', trim(requested_name)
    )
  );
  RETURN true;
END
$$;

CREATE FUNCTION revoke_connector(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  actor_user_id uuid,
  revoked_time timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  did_revoke boolean;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Connector tenant does not match the active tenant'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_members
    WHERE tenant_id = requested_tenant_id
      AND user_id = actor_user_id
      AND role IN ('owner', 'admin')
  ) THEN
    RETURN false;
  END IF;
  UPDATE connectors SET revoked_at = revoked_time
  WHERE tenant_id = requested_tenant_id
    AND id = requested_connector_id
    AND revoked_at IS NULL;
  did_revoke := FOUND;
  IF NOT did_revoke THEN
    RETURN EXISTS (
      SELECT 1 FROM connectors
      WHERE tenant_id = requested_tenant_id
        AND id = requested_connector_id
        AND revoked_at IS NOT NULL
    );
  END IF;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action,
    target_kind, target_id, outcome
  ) VALUES (
    requested_tenant_id, 'human-session', actor_user_id,
    'connector.revoke', 'connector', requested_connector_id, 'succeeded'
  );
  RETURN true;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knot_pairing') THEN
    CREATE ROLE knot_pairing NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'knot_pairing'
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members
    JOIN pg_roles ON pg_roles.oid = pg_auth_members.member
    WHERE pg_roles.rolname = 'knot_pairing'
  ) THEN
    RAISE EXCEPTION 'Knot pairing role has unsafe privileges';
  END IF;
END
$$;

GRANT knot_pairing TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO knot_pairing;
GRANT SELECT, UPDATE ON pairing_sessions TO knot_pairing;
GRANT EXECUTE ON FUNCTION knot_array_is_unique(anyarray) TO knot_pairing;
CREATE POLICY pairing_poll_access ON pairing_sessions TO knot_pairing
  USING (true) WITH CHECK (true);

CREATE FUNCTION poll_pairing_session(
  requested_pairing_id uuid,
  requested_poll_token_digest text,
  polled_at timestamptz
)
RETURNS TABLE (
  pairing_id uuid,
  status text,
  expires_at timestamptz,
  connector_id uuid,
  tenant_id uuid,
  granted_scopes scope_name[],
  granted_site_ids uuid[],
  granted_slug_grants text[],
  approved_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  pairing_record pairing_sessions%ROWTYPE;
BEGIN
  IF requested_poll_token_digest !~ '^[a-f0-9]{64}$' THEN RETURN; END IF;
  SELECT * INTO pairing_record
  FROM pairing_sessions
  WHERE id = requested_pairing_id
    AND poll_token_digest = requested_poll_token_digest
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF pairing_record.poll_consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT pairing_record.id, 'consumed'::text,
      pairing_record.expires_at, NULL::uuid, NULL::uuid,
      NULL::scope_name[], NULL::uuid[], NULL::text[], NULL::timestamptz;
    RETURN;
  END IF;
  IF pairing_record.state IN ('approved', 'denied')
     AND pairing_record.expires_at <= polled_at THEN
    UPDATE pairing_sessions
    SET poll_consumed_at = polled_at, updated_at = polled_at
    WHERE id = pairing_record.id;
    RETURN QUERY SELECT pairing_record.id, 'expired'::text,
      pairing_record.expires_at, NULL::uuid, NULL::uuid,
      NULL::scope_name[], NULL::uuid[], NULL::text[], NULL::timestamptz;
    RETURN;
  END IF;
  IF pairing_record.state = 'pending' AND pairing_record.expires_at <= polled_at THEN
    UPDATE pairing_sessions
    SET state = 'expired', updated_at = polled_at
    WHERE id = pairing_record.id;
    pairing_record.state := 'expired';
  END IF;
  IF pairing_record.state = 'pending' THEN
    RETURN QUERY SELECT pairing_record.id, 'pending'::text,
      pairing_record.expires_at, NULL::uuid, NULL::uuid,
      NULL::scope_name[], NULL::uuid[], NULL::text[], NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE pairing_sessions SET poll_consumed_at = polled_at, updated_at = polled_at
  WHERE id = pairing_record.id;
  IF pairing_record.state = 'approved' THEN
    RETURN QUERY SELECT pairing_record.id, 'approved'::text,
      pairing_record.expires_at, pairing_record.approved_connector_id,
      pairing_record.tenant_id, pairing_record.granted_scopes,
      pairing_record.granted_site_ids, pairing_record.granted_slug_grants,
      pairing_record.approved_at;
  ELSE
    RETURN QUERY SELECT pairing_record.id, pairing_record.state::text,
      pairing_record.expires_at, NULL::uuid, NULL::uuid,
      NULL::scope_name[], NULL::uuid[], NULL::text[], NULL::timestamptz;
  END IF;
END
$$;

ALTER FUNCTION poll_pairing_session(uuid, text, timestamptz)
  OWNER TO knot_pairing;
REVOKE CREATE ON SCHEMA public FROM knot_pairing;
REVOKE knot_pairing FROM CURRENT_USER;

REVOKE ALL ON FUNCTION
  approve_pairing_session(uuid, uuid, uuid, scope_name[], uuid[], text[], timestamptz)
FROM PUBLIC;
REVOKE ALL ON FUNCTION deny_pairing_session(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION rename_connector(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_connector(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION poll_pairing_session(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  approve_pairing_session(uuid, uuid, uuid, scope_name[], uuid[], text[], timestamptz)
TO knot_app;
GRANT EXECUTE ON FUNCTION deny_pairing_session(uuid, uuid, uuid, timestamptz) TO knot_app;
GRANT EXECUTE ON FUNCTION rename_connector(uuid, uuid, uuid, text) TO knot_app;
GRANT EXECUTE ON FUNCTION revoke_connector(uuid, uuid, uuid, timestamptz) TO knot_app;
GRANT EXECUTE ON FUNCTION poll_pairing_session(uuid, text, timestamptz) TO knot_app;
