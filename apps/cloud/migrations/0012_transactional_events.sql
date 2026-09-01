CREATE TYPE webhook_delivery_state AS ENUM (
  'pending', 'leased', 'retrying', 'succeeded', 'dead-lettered'
);

CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  destination_name text NOT NULL CHECK (
    destination_name ~ '^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$'
  ),
  event_types text[] NOT NULL CHECK (
    cardinality(event_types) BETWEEN 1 AND 10
    AND event_types <@ ARRAY['channel.message.available']::text[]
  ),
  connector_ids uuid[] NOT NULL CHECK (cardinality(connector_ids) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE transactional_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 200),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type = 'channel.message.available'),
  origin_space_id text NOT NULL CHECK (char_length(origin_space_id) BETWEEN 1 AND 200),
  origin_chat_id text NOT NULL CHECK (char_length(origin_chat_id) BETWEEN 1 AND 200),
  origin_message_id text NOT NULL CHECK (char_length(origin_message_id) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, api_key_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES connectors(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, api_key_id) REFERENCES api_keys(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state webhook_delivery_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token_digest text CHECK (lease_token_digest IS NULL OR lease_token_digest ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  response_status integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_sha256 text CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[a-f0-9]{64}$'),
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, subscription_id, event_id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES webhook_subscriptions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, event_id) REFERENCES transactional_events(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX webhook_deliveries_ready_idx
  ON webhook_deliveries (available_at, tenant_id, id)
  WHERE state IN ('pending', 'retrying', 'leased');
CREATE INDEX transactional_events_tenant_created_idx
  ON transactional_events (tenant_id, created_at DESC, id DESC);

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE transactional_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactional_events FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_subscriptions_tenant ON webhook_subscriptions TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY transactional_events_tenant ON transactional_events TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY webhook_deliveries_resolver_select ON webhook_deliveries
  FOR SELECT TO knot_resolver USING (true);
CREATE POLICY webhook_subscriptions_resolver_select ON webhook_subscriptions
  FOR SELECT TO knot_resolver USING (true);

CREATE FUNCTION create_webhook_subscription(
  p_tenant_id uuid,
  p_user_id uuid,
  p_name text,
  p_destination_name text,
  p_event_types text[],
  p_connector_ids uuid[],
  p_active_limit integer
)
RETURNS TABLE (
  status text, subscription_id uuid, subscription_name text,
  destination_name text, event_types text[], connector_ids uuid[],
  active boolean, created_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_subscription webhook_subscriptions%ROWTYPE;
  v_authorized_count integer;
  v_active_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
    nullif(current_setting('app.tenant_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Tenant context mismatch';
  END IF;
  IF p_active_limit NOT BETWEEN 1 AND 1000
    OR cardinality(p_connector_ids) NOT BETWEEN 1 AND 100
    OR cardinality(p_event_types) NOT BETWEEN 1 AND 10
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid subscription limits';
  END IF;

  -- Serializing on the tenant makes the configured active-subscription cap a
  -- hard limit even when several admins create subscriptions concurrently.
  PERFORM 1 FROM tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Tenant context mismatch';
  END IF;

  SELECT count(*)::int INTO v_authorized_count
  FROM connectors
  WHERE tenant_id = p_tenant_id
    AND id = ANY(p_connector_ids)
    AND revoked_at IS NULL;
  IF v_authorized_count <> cardinality(p_connector_ids) THEN
    RETURN QUERY SELECT 'connector-denied',NULL::uuid,NULL::text,NULL::text,
      NULL::text[],NULL::uuid[],NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM webhook_subscriptions AS subscription
    WHERE subscription.tenant_id = p_tenant_id AND subscription.active
      AND subscription.destination_name = p_destination_name
      AND subscription.event_types @> p_event_types
      AND subscription.event_types <@ p_event_types
      AND subscription.connector_ids @> p_connector_ids
      AND subscription.connector_ids <@ p_connector_ids
  ) THEN
    RETURN QUERY SELECT 'duplicate-subscription',NULL::uuid,NULL::text,NULL::text,
      NULL::text[],NULL::uuid[],NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM webhook_subscriptions AS subscription
    WHERE subscription.tenant_id = p_tenant_id AND subscription.name = p_name
  ) THEN
    RETURN QUERY SELECT 'subscription-name-conflict',NULL::uuid,NULL::text,NULL::text,
      NULL::text[],NULL::uuid[],NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;

  SELECT count(*)::int INTO v_active_count
  FROM webhook_subscriptions AS subscription
  WHERE subscription.tenant_id = p_tenant_id AND subscription.active;
  IF v_active_count >= p_active_limit THEN
    RETURN QUERY SELECT 'subscription-limit-exceeded',NULL::uuid,NULL::text,NULL::text,
      NULL::text[],NULL::uuid[],NULL::boolean,NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO webhook_subscriptions(
    tenant_id,name,destination_name,event_types,connector_ids,created_by
  ) VALUES (
    p_tenant_id,p_name,p_destination_name,p_event_types,p_connector_ids,p_user_id
  ) RETURNING * INTO v_subscription;

  INSERT INTO audit_events(
    tenant_id,principal_kind,principal_id,action,target_kind,target_id,outcome,metadata
  ) VALUES (
    p_tenant_id,'human-session',p_user_id,'webhook.subscription.create',
    'webhook-subscription',v_subscription.id,'succeeded',
    jsonb_build_object('connectors',v_subscription.connector_ids)
  );

  RETURN QUERY SELECT 'created',v_subscription.id,v_subscription.name,
    v_subscription.destination_name,v_subscription.event_types,
    v_subscription.connector_ids,v_subscription.active,v_subscription.created_at;
END
$$;

CREATE FUNCTION disable_webhook_subscription(
  p_tenant_id uuid,
  p_user_id uuid,
  p_subscription_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_disabled boolean := false;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
    nullif(current_setting('app.tenant_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Tenant context mismatch';
  END IF;

  UPDATE webhook_subscriptions
  SET active=false,updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND id=p_subscription_id AND active
  RETURNING true INTO v_disabled;
  IF NOT v_disabled THEN RETURN false; END IF;

  WITH dead AS (
    UPDATE webhook_deliveries
    SET state='dead-lettered',last_error_code='subscription-disabled',
      lease_token_digest=NULL,lease_expires_at=NULL,
      completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant_id AND subscription_id=p_subscription_id
      AND state IN ('pending','retrying','leased')
    RETURNING id
  )
  INSERT INTO audit_events(
    tenant_id,principal_kind,principal_id,action,target_kind,target_id,outcome,metadata
  ) SELECT p_tenant_id,'human-session',p_user_id,'webhook.delivery',
      'webhook-delivery',dead.id,'dead-lettered',
      jsonb_build_object('reason','subscription-disabled')
    FROM dead;

  INSERT INTO audit_events(
    tenant_id,principal_kind,principal_id,action,target_kind,target_id,outcome,metadata
  ) VALUES (
    p_tenant_id,'human-session',p_user_id,'webhook.subscription.disable',
    'webhook-subscription',p_subscription_id,'succeeded','{}'::jsonb
  );
  RETURN true;
END
$$;

CREATE FUNCTION enqueue_transactional_event(
  p_tenant_id uuid,
  p_api_key_id uuid,
  p_connector_id uuid,
  p_idempotency_key text,
  p_request_sha256 text,
  p_event_type text,
  p_origin_space_id text,
  p_origin_chat_id text,
  p_origin_message_id text,
  p_occurred_at timestamptz
)
RETURNS TABLE (event_id uuid, was_created boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id uuid;
  v_existing_sha text;
  key_record api_keys%ROWTYPE;
  minute_count integer;
  day_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
    nullif(current_setting('app.tenant_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Tenant context mismatch';
  END IF;
  IF p_request_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid event metadata';
  END IF;

  -- The credential row serializes replay lookup, quota charging, and insert so
  -- concurrent retries cannot consume more than one quota unit.
  SELECT * INTO key_record
  FROM api_keys
  WHERE tenant_id = p_tenant_id AND id = p_api_key_id
  FOR UPDATE;
  IF NOT FOUND OR key_record.revoked_at IS NOT NULL
    OR (key_record.expires_at IS NOT NULL AND key_record.expires_at <= clock_timestamp())
  THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'API key is inactive';
  END IF;
  IF NOT 'anytype.chats.read'::scope_name = ANY(key_record.scopes) THEN
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
      AND 'anytype.chats.read'::scope_name = ANY(connector.scopes)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Connector binding denied';
  END IF;

  SELECT id, request_sha256 INTO v_event_id, v_existing_sha
  FROM transactional_events
  WHERE tenant_id = p_tenant_id AND api_key_id = p_api_key_id
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_sha <> p_request_sha256 THEN
      RAISE EXCEPTION 'event idempotency conflict' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY SELECT v_event_id, false;
    RETURN;
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

  INSERT INTO transactional_events (
    tenant_id, api_key_id, connector_id, idempotency_key, request_sha256,
    event_type, origin_space_id, origin_chat_id, origin_message_id, occurred_at
  ) VALUES (
    p_tenant_id, p_api_key_id, p_connector_id, p_idempotency_key, p_request_sha256,
    p_event_type, p_origin_space_id, p_origin_chat_id, p_origin_message_id, p_occurred_at
  ) RETURNING id INTO v_event_id;

  INSERT INTO webhook_deliveries (tenant_id, subscription_id, event_id)
  SELECT p_tenant_id, subscription.id, v_event_id
  FROM webhook_subscriptions AS subscription
  WHERE subscription.tenant_id = p_tenant_id
    AND subscription.active
    AND p_event_type = ANY(subscription.event_types)
    AND p_connector_id = ANY(subscription.connector_ids)
  ON CONFLICT DO NOTHING;

  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind,
    target_id, outcome, metadata
  ) VALUES (
    p_tenant_id, 'consumer-api-key', p_api_key_id, 'transactional-event.accept',
    'transactional-event', v_event_id, 'succeeded',
    jsonb_build_object('connectorId', p_connector_id, 'requestSha256', p_request_sha256)
  );
  RETURN QUERY SELECT v_event_id, true;
END
$$;

CREATE FUNCTION list_webhook_delivery_tenants(
  p_now timestamptz,
  p_limit integer
)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT delivery.tenant_id
  FROM webhook_deliveries AS delivery
  JOIN webhook_subscriptions AS subscription
    ON subscription.tenant_id = delivery.tenant_id
   AND subscription.id = delivery.subscription_id
  WHERE p_limit BETWEEN 1 AND 100
    AND subscription.active
    AND (
      (delivery.state IN ('pending', 'retrying') AND delivery.available_at <= p_now)
      OR (delivery.state = 'leased' AND delivery.lease_expires_at <= p_now)
    )
  ORDER BY delivery.tenant_id
  LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION list_webhook_delivery_tenants(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_webhook_delivery_tenants(timestamptz, integer) TO knot_app;

GRANT knot_resolver TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO knot_resolver;
GRANT SELECT ON webhook_deliveries, webhook_subscriptions TO knot_resolver;
ALTER FUNCTION list_webhook_delivery_tenants(timestamptz, integer) OWNER TO knot_resolver;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER;

CREATE FUNCTION claim_webhook_delivery(
  p_tenant_id uuid,
  p_now timestamptz,
  p_lease_token_digest text,
  p_lease_seconds integer
)
RETURNS TABLE (
  delivery_id uuid, subscription_id uuid, destination_name text,
  event_id uuid, event_type text, connector_id uuid,
  origin_space_id text, origin_chat_id text, origin_message_id text,
  occurred_at timestamptz, attempt integer
)
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
  WITH dead AS (
    UPDATE webhook_deliveries
    SET state = 'dead-lettered', last_error_code = 'attempts-exhausted',
        lease_token_digest = NULL, lease_expires_at = NULL,
        completed_at = p_now, updated_at = p_now
    WHERE tenant_id = p_tenant_id AND state = 'leased'
      AND lease_expires_at <= p_now AND attempt_count >= 10
    RETURNING id
  ), dead_audit AS (
    INSERT INTO audit_events(
      tenant_id,principal_kind,action,target_kind,target_id,outcome,metadata
    ) SELECT
      p_tenant_id,'first-party-service','webhook.delivery','webhook-delivery',
      dead.id,'dead-lettered','{}'::jsonb
    FROM dead
    RETURNING 1
  ), candidate AS (
    SELECT id FROM webhook_deliveries
    WHERE tenant_id = p_tenant_id AND attempt_count < 10
      AND EXISTS (
        SELECT 1 FROM webhook_subscriptions AS subscription
        WHERE subscription.tenant_id = p_tenant_id
          AND subscription.id = webhook_deliveries.subscription_id
          AND subscription.active
      )
      AND (
        (state IN ('pending', 'retrying') AND available_at <= p_now)
        OR (state = 'leased' AND lease_expires_at <= p_now)
      )
      AND p_lease_seconds BETWEEN 15 AND 300
      AND p_lease_token_digest ~ '^[a-f0-9]{64}$'
    ORDER BY available_at, created_at, id
    FOR UPDATE SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE webhook_deliveries AS delivery
    SET state = 'leased', attempt_count = delivery.attempt_count + 1,
        lease_token_digest = p_lease_token_digest,
        lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
        updated_at = p_now
    FROM candidate WHERE delivery.tenant_id = p_tenant_id AND delivery.id = candidate.id
    RETURNING delivery.*
  )
  SELECT claimed.id, subscription.id, subscription.destination_name,
    event.id, event.event_type, event.connector_id,
    event.origin_space_id, event.origin_chat_id, event.origin_message_id,
    event.occurred_at, claimed.attempt_count
  FROM claimed
  JOIN webhook_subscriptions AS subscription
    ON subscription.tenant_id = claimed.tenant_id AND subscription.id = claimed.subscription_id
  JOIN transactional_events AS event
    ON event.tenant_id = claimed.tenant_id AND event.id = claimed.event_id
$$;

CREATE FUNCTION complete_webhook_delivery(
  p_tenant_id uuid, p_delivery_id uuid, p_attempt integer,
  p_lease_token_digest text, p_now timestamptz,
  p_success boolean, p_retryable boolean, p_response_status integer,
  p_response_sha256 text, p_error_code text
)
RETURNS webhook_delivery_state
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_state webhook_delivery_state;
BEGIN
  UPDATE webhook_deliveries
  SET state = CASE
        WHEN p_success THEN 'succeeded'::webhook_delivery_state
        WHEN p_retryable AND attempt_count < 10 THEN 'retrying'::webhook_delivery_state
        ELSE 'dead-lettered'::webhook_delivery_state
      END,
      available_at = CASE WHEN NOT p_success AND p_retryable AND attempt_count < 10
        THEN p_now + make_interval(secs => LEAST(3600, power(2, LEAST(attempt_count, 11))::integer))
        ELSE available_at END,
      lease_token_digest = NULL, lease_expires_at = NULL,
      response_status = p_response_status, response_sha256 = p_response_sha256,
      last_error_code = p_error_code,
      completed_at = CASE WHEN p_success OR NOT p_retryable OR attempt_count >= 10 THEN p_now ELSE NULL END,
      updated_at = p_now
  WHERE tenant_id = p_tenant_id AND id = p_delivery_id
    AND state = 'leased' AND attempt_count = p_attempt
    AND lease_token_digest = p_lease_token_digest AND lease_expires_at > p_now
  RETURNING state INTO v_state;
  IF v_state IS NULL THEN RAISE EXCEPTION 'stale delivery fence' USING ERRCODE = 'P0003'; END IF;
  IF v_state = 'dead-lettered' THEN
    INSERT INTO audit_events (
      tenant_id, principal_kind, action, target_kind, target_id, outcome, metadata
    ) VALUES (
      p_tenant_id, 'first-party-service', 'webhook.delivery', 'webhook-delivery',
      p_delivery_id, 'dead-lettered', jsonb_build_object('responseSha256', p_response_sha256)
    );
  END IF;
  RETURN v_state;
END
$$;

REVOKE ALL ON FUNCTION enqueue_transactional_event(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_webhook_subscription(uuid,uuid,text,text,text[],uuid[],integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION disable_webhook_subscription(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_webhook_delivery(uuid,timestamptz,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_webhook_delivery(uuid,uuid,integer,text,timestamptz,boolean,boolean,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_transactional_event(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz) TO knot_app;
GRANT EXECUTE ON FUNCTION create_webhook_subscription(uuid,uuid,text,text,text[],uuid[],integer) TO knot_app;
GRANT EXECUTE ON FUNCTION disable_webhook_subscription(uuid,uuid,uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION claim_webhook_delivery(uuid,timestamptz,text,integer) TO knot_app;
GRANT EXECUTE ON FUNCTION complete_webhook_delivery(uuid,uuid,integer,text,timestamptz,boolean,boolean,integer,text,text) TO knot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_subscriptions TO knot_app;
GRANT SELECT, INSERT ON transactional_events TO knot_app;
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO knot_app;
