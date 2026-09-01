ALTER TABLE api_keys
  ADD COLUMN requests_per_minute integer NOT NULL DEFAULT 60
    CHECK (requests_per_minute BETWEEN 1 AND 1000),
  ADD COLUMN requests_per_day integer NOT NULL DEFAULT 10000
    CHECK (requests_per_day BETWEEN 1 AND 1000000);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_name_size CHECK (char_length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT api_keys_expiry_order CHECK (expires_at IS NULL OR expires_at > created_at);

ALTER TABLE commands
  ADD COLUMN actor_digest text CHECK (actor_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN actor_digest_version smallint CHECK (actor_digest_version > 0),
  ADD CONSTRAINT commands_actor_digest_pair CHECK (
    (actor_digest IS NULL) = (actor_digest_version IS NULL)
  );

-- Existing commands predate authenticated actor envelopes. Preserve them with an
-- explicit, non-authorizing sentinel so connectors can reject them by local
-- policy instead of losing them as malformed commands during the upgrade.
-- The table is FORCE RLS, so temporarily restore the owning migration role's
-- normal owner bypass while performing this all-tenant data migration.
ALTER TABLE commands NO FORCE ROW LEVEL SECURITY;
UPDATE commands
SET actor_digest = repeat('0', 64), actor_digest_version = 1
WHERE actor_digest IS NULL;
ALTER TABLE commands FORCE ROW LEVEL SECURITY;

CREATE TABLE api_key_usage_windows (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL,
  window_kind text NOT NULL CHECK (window_kind IN ('minute', 'day')),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, api_key_id, window_kind, window_started_at),
  FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES api_keys(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX api_key_usage_windows_expiry_idx
  ON api_key_usage_windows (tenant_id, expires_at);

ALTER TABLE api_key_usage_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_key_usage_windows
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_usage_windows TO knot_app;

CREATE FUNCTION resolve_consumer_api_key(lookup_key_id text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  key_digest text,
  digest_version smallint,
  scopes scope_name[],
  expires_at timestamptz,
  revoked_at timestamptz,
  requests_per_minute integer,
  requests_per_day integer,
  connector_ids uuid[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    key.id,
    key.tenant_id,
    key.key_digest,
    key.digest_version,
    key.scopes,
    key.expires_at,
    key.revoked_at,
    key.requests_per_minute,
    key.requests_per_day,
    COALESCE(
      array_agg(binding.connector_id ORDER BY binding.connector_id)
        FILTER (WHERE binding.connector_id IS NOT NULL),
      '{}'::uuid[]
    )
  FROM public.api_keys AS key
  LEFT JOIN public.api_key_connectors AS binding
    ON binding.tenant_id = key.tenant_id AND binding.api_key_id = key.id
  WHERE key.key_id = lookup_key_id
  GROUP BY key.id
$$;

REVOKE ALL ON FUNCTION resolve_consumer_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_consumer_api_key(text) TO knot_app;

GRANT knot_resolver TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO knot_resolver;
GRANT SELECT ON api_key_connectors TO knot_resolver;
CREATE POLICY resolver_select ON api_key_connectors
  FOR SELECT TO knot_resolver USING (true);
ALTER FUNCTION resolve_consumer_api_key(text) OWNER TO knot_resolver;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER GRANTED BY CURRENT_USER;

CREATE FUNCTION create_consumer_api_key(
  p_tenant_id uuid,
  p_user_id uuid,
  p_name text,
  p_key_id text,
  p_key_digest text,
  p_digest_version smallint,
  p_scopes scope_name[],
  p_connector_ids uuid[],
  p_expires_at timestamptz,
  p_requests_per_minute integer,
  p_requests_per_day integer
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_id uuid := gen_random_uuid();
BEGIN
  IF p_tenant_id IS DISTINCT FROM
    nullif(current_setting('app.tenant_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Tenant context mismatch';
  END IF;
  IF char_length(p_name) NOT BETWEEN 1 AND 100
    OR p_key_id !~ '^[A-Za-z0-9_-]{16}$'
    OR p_key_digest !~ '^[a-f0-9]{64}$'
    OR p_digest_version < 1
    OR cardinality(p_scopes) < 1
    OR cardinality(p_connector_ids) < 1
    OR cardinality(p_scopes) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_scopes)))
    OR cardinality(p_connector_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_connector_ids)))
    OR EXISTS (SELECT 1 FROM unnest(p_scopes) AS scope WHERE scope::text LIKE 'publications.%')
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid API key configuration';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'API key expiry must be in the future';
  END IF;
  IF (
    SELECT count(*)
    FROM connectors
    WHERE tenant_id = p_tenant_id
      AND id = ANY(p_connector_ids)
      AND revoked_at IS NULL
      AND scopes @> p_scopes
  ) <> cardinality(p_connector_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Connector scope binding denied';
  END IF;

  INSERT INTO api_keys (
    id, tenant_id, name, key_id, key_digest, digest_version, scopes, expires_at,
    requests_per_minute, requests_per_day
  ) VALUES (
    new_id, p_tenant_id, p_name, p_key_id, p_key_digest, p_digest_version,
    p_scopes, p_expires_at, p_requests_per_minute, p_requests_per_day
  );
  INSERT INTO api_key_connectors (tenant_id, api_key_id, connector_id)
  SELECT p_tenant_id, new_id, connector_id FROM unnest(p_connector_ids) AS connector_id;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome,
    metadata
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, 'api-key.create', 'api-key', new_id,
    'succeeded', jsonb_build_object('scopes', p_scopes, 'connectors', cardinality(p_connector_ids))
  );
  RETURN new_id;
END
$$;

CREATE FUNCTION rotate_consumer_api_key(
  p_tenant_id uuid,
  p_user_id uuid,
  p_api_key_id uuid,
  p_key_id text,
  p_key_digest text,
  p_digest_version smallint
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE api_keys
  SET key_id = p_key_id, key_digest = p_key_digest, digest_version = p_digest_version
  WHERE tenant_id = p_tenant_id AND id = p_api_key_id AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, 'api-key.rotate', 'api-key', p_api_key_id,
    'succeeded'
  );
  RETURN true;
END
$$;

CREATE FUNCTION revoke_consumer_api_key(
  p_tenant_id uuid,
  p_user_id uuid,
  p_api_key_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  exists_in_tenant boolean;
  newly_revoked boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM api_keys WHERE tenant_id = p_tenant_id AND id = p_api_key_id
  ) INTO exists_in_tenant;
  IF NOT exists_in_tenant THEN RETURN false; END IF;
  UPDATE api_keys SET revoked_at = clock_timestamp()
  WHERE tenant_id = p_tenant_id AND id = p_api_key_id AND revoked_at IS NULL;
  newly_revoked := FOUND;
  IF newly_revoked THEN
    INSERT INTO audit_events (
      tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome
    ) VALUES (
      p_tenant_id, 'human-session', p_user_id, 'api-key.revoke', 'api-key', p_api_key_id,
      'succeeded'
    );
  END IF;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION create_consumer_api_key(
  uuid, uuid, text, text, text, smallint, scope_name[], uuid[], timestamptz, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION rotate_consumer_api_key(uuid, uuid, uuid, text, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_consumer_api_key(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_consumer_api_key(
  uuid, uuid, text, text, text, smallint, scope_name[], uuid[], timestamptz, integer, integer
) TO knot_app;
GRANT EXECUTE ON FUNCTION rotate_consumer_api_key(uuid, uuid, uuid, text, text, smallint) TO knot_app;
GRANT EXECUTE ON FUNCTION revoke_consumer_api_key(uuid, uuid, uuid) TO knot_app;

CREATE FUNCTION enqueue_consumer_operation(
  p_tenant_id uuid,
  p_api_key_id uuid,
  p_connector_id uuid,
  p_required_scope scope_name,
  p_operation jsonb,
  p_idempotency_key text,
  p_request_sha256 text,
  p_created_at timestamptz,
  p_expires_at timestamptz,
  p_actor_digest text,
  p_actor_digest_version smallint
)
RETURNS TABLE (command_id uuid, command_state command_state, was_created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  key_record api_keys%ROWTYPE;
  existing_request_sha256 text;
  existing_command_id uuid;
  existing_command_state command_state;
  minute_count integer;
  day_count integer;
  new_command_id uuid := gen_random_uuid();
BEGIN
  IF p_tenant_id IS DISTINCT FROM
    nullif(current_setting('app.tenant_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Tenant context mismatch';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 16 AND 200
    OR p_request_sha256 IS NULL OR p_request_sha256 !~ '^[a-f0-9]{64}$'
    OR p_actor_digest IS NULL OR p_actor_digest !~ '^[a-f0-9]{64}$'
    OR p_actor_digest_version IS NULL OR p_actor_digest_version < 1
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid operation metadata';
  END IF;
  IF p_created_at > clock_timestamp() + interval '5 minutes'
    OR p_created_at < clock_timestamp() - interval '5 minutes'
    OR p_expires_at <= p_created_at
    OR p_expires_at > p_created_at + interval '24 hours'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid operation timestamps';
  END IF;

  SELECT * INTO key_record
  FROM api_keys
  WHERE tenant_id = p_tenant_id AND id = p_api_key_id
  FOR UPDATE;

  IF NOT FOUND OR key_record.revoked_at IS NOT NULL
    OR (key_record.expires_at IS NOT NULL AND key_record.expires_at <= clock_timestamp())
  THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'API key is inactive';
  END IF;
  IF NOT p_required_scope = ANY(key_record.scopes) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'API key scope denied';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM api_key_connectors AS binding
    JOIN connectors AS connector
      ON connector.tenant_id = binding.tenant_id AND connector.id = binding.connector_id
    WHERE binding.tenant_id = p_tenant_id
      AND binding.api_key_id = p_api_key_id
      AND binding.connector_id = p_connector_id
      AND connector.revoked_at IS NULL
      AND p_required_scope = ANY(connector.scopes)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Connector binding denied';
  END IF;

  INSERT INTO api_key_usage_windows (
    tenant_id, api_key_id, window_kind, window_started_at, request_count, expires_at
  ) VALUES (
    p_tenant_id, p_api_key_id, 'minute', date_trunc('minute', clock_timestamp()), 1,
    date_trunc('minute', clock_timestamp()) + interval '2 minutes'
  )
  ON CONFLICT (tenant_id, api_key_id, window_kind, window_started_at)
  DO UPDATE SET request_count = api_key_usage_windows.request_count + 1
  RETURNING request_count INTO minute_count;

  INSERT INTO api_key_usage_windows (
    tenant_id, api_key_id, window_kind, window_started_at, request_count, expires_at
  ) VALUES (
    p_tenant_id, p_api_key_id, 'day', date_trunc('day', clock_timestamp()), 1,
    date_trunc('day', clock_timestamp()) + interval '2 days'
  )
  ON CONFLICT (tenant_id, api_key_id, window_kind, window_started_at)
  DO UPDATE SET request_count = api_key_usage_windows.request_count + 1
  RETURNING request_count INTO day_count;

  IF minute_count > key_record.requests_per_minute OR day_count > key_record.requests_per_day THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'API key quota exceeded';
  END IF;

  SELECT record.request_sha256, command.id, command.state
  INTO existing_request_sha256, existing_command_id, existing_command_state
  FROM idempotency_records AS record
  JOIN commands AS command
    ON command.tenant_id = record.tenant_id
    AND command.created_by_kind = record.credential_kind
    AND command.created_by_id = record.credential_id
    AND command.idempotency_key = record.idempotency_key
  WHERE record.tenant_id = p_tenant_id
    AND record.credential_kind = 'consumer-api-key'
    AND record.credential_id = p_api_key_id
    AND record.idempotency_key = p_idempotency_key
    AND record.expires_at > clock_timestamp();

  IF FOUND THEN
    IF existing_request_sha256 <> p_request_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Idempotency key payload mismatch';
    END IF;
    RETURN QUERY SELECT existing_command_id, existing_command_state, false;
    RETURN;
  END IF;

  INSERT INTO commands (
    id, tenant_id, connector_id, required_scope, payload, not_before, expires_at,
    idempotency_key, created_by_kind, created_by_id, actor_digest,
    actor_digest_version, created_at, updated_at
  ) VALUES (
    new_command_id, p_tenant_id, p_connector_id, p_required_scope,
    jsonb_build_object('domain', 'anytype', 'operation', p_operation),
    p_created_at, p_expires_at, p_idempotency_key, 'consumer-api-key', p_api_key_id,
    p_actor_digest, p_actor_digest_version, p_created_at, p_created_at
  );

  INSERT INTO idempotency_records (
    tenant_id, credential_kind, credential_id, idempotency_key, request_sha256,
    response_status, response_body, created_at, expires_at
  ) VALUES (
    p_tenant_id, 'consumer-api-key', p_api_key_id, p_idempotency_key, p_request_sha256,
    202, jsonb_build_object('operationId', new_command_id), p_created_at,
    LEAST(p_expires_at + interval '1 day', p_created_at + interval '7 days')
  );

  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, actor_digest, actor_digest_version,
    action, target_kind, target_id, outcome, metadata
  ) VALUES (
    p_tenant_id, 'consumer-api-key', p_api_key_id, p_actor_digest,
    p_actor_digest_version, 'operation.enqueue', 'command', new_command_id, 'accepted',
    jsonb_build_object('connectorId', p_connector_id, 'scope', p_required_scope)
  );

  RETURN QUERY SELECT new_command_id, 'pending'::command_state, true;
END
$$;

REVOKE ALL ON FUNCTION enqueue_consumer_operation(
  uuid, uuid, uuid, scope_name, jsonb, text, text, timestamptz, timestamptz, text, smallint
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_consumer_operation(
  uuid, uuid, uuid, scope_name, jsonb, text, text, timestamptz, timestamptz, text, smallint
) TO knot_app;
