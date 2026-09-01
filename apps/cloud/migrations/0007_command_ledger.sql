CREATE POLICY tenant_update ON command_attempts
  FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE commands
  ADD CONSTRAINT commands_result_size
  CHECK (result IS NULL OR pg_column_size(result) <= 1048576);

ALTER TABLE commands
  ADD CONSTRAINT commands_error_code_size
  CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 200);

ALTER TABLE commands
  ADD CONSTRAINT commands_required_scope_matches_payload
  CHECK (
    required_scope IS NOT DISTINCT FROM CASE
      WHEN payload ->> 'domain' = 'anytype' THEN
        CASE payload -> 'operation' ->> 'type'
          WHEN 'object.read' THEN 'anytype.objects.read'::scope_name
          WHEN 'object.query' THEN 'anytype.objects.read'::scope_name
          WHEN 'object.create' THEN 'anytype.objects.write'::scope_name
          WHEN 'object.update' THEN 'anytype.objects.write'::scope_name
          WHEN 'object.archive' THEN 'anytype.objects.write'::scope_name
          WHEN 'collection.read' THEN 'anytype.collections.read'::scope_name
          WHEN 'collection.members.add' THEN 'anytype.collections.write'::scope_name
          WHEN 'collection.members.remove' THEN 'anytype.collections.write'::scope_name
          WHEN 'file.download' THEN 'anytype.files.read'::scope_name
          WHEN 'file.upload' THEN 'anytype.files.write'::scope_name
          WHEN 'file.attach' THEN 'anytype.files.write'::scope_name
          WHEN 'chat.read' THEN 'anytype.chats.read'::scope_name
          WHEN 'chat.send' THEN 'anytype.chats.send'::scope_name
          ELSE NULL
        END
      WHEN payload ->> 'domain' = 'publication' THEN
        CASE payload -> 'operation' ->> 'type'
          WHEN 'publication.disable' THEN 'publications.write'::scope_name
          WHEN 'publication.rollback' THEN 'publications.write'::scope_name
          WHEN 'publication.unpublish' THEN 'publications.unpublish'::scope_name
          ELSE NULL
        END
      ELSE NULL
    END
  );

CREATE FUNCTION claim_command(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_allowed_scopes scope_name[],
  p_now timestamptz,
  p_lease_token_digest text,
  p_lease_seconds integer
)
RETURNS TABLE (
  command_id uuid,
  required_scope scope_name,
  payload jsonb,
  created_by_kind credential_kind,
  created_at timestamptz,
  not_before timestamptz,
  expires_at timestamptz,
  attempt integer,
  lease_expires_at timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH expire_commands AS (
    UPDATE commands
    SET
      state = 'expired',
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      updated_at = p_now
    WHERE tenant_id = p_tenant_id
      AND connector_id = p_connector_id
      AND state IN ('pending', 'leased')
      AND expires_at <= p_now
    RETURNING id
  ),
  dead_letter_commands AS (
    UPDATE commands
    SET
      state = 'dead-lettered',
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      updated_at = p_now
    WHERE tenant_id = p_tenant_id
      AND connector_id = p_connector_id
      AND state = 'leased'
      AND lease_expires_at <= p_now
      AND attempt_count >= max_attempts
      AND expires_at > p_now
    RETURNING id
  ),
  candidate AS (
    SELECT id
    FROM commands
    WHERE tenant_id = p_tenant_id
      AND connector_id = p_connector_id
      AND required_scope = ANY(p_allowed_scopes)
      AND expires_at > p_now + make_interval(secs => LEAST(p_lease_seconds, 15))
      AND attempt_count < max_attempts
      AND (
        (state = 'pending' AND not_before <= p_now)
        OR (state = 'leased' AND lease_expires_at <= p_now)
      )
      AND p_lease_token_digest ~ '^[a-f0-9]{64}$'
      AND p_lease_seconds BETWEEN 5 AND 300
    ORDER BY not_before, created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ),
  claimed AS (
    UPDATE commands AS command
    SET
      state = 'leased',
      attempt_count = command.attempt_count + 1,
      lease_token_digest = p_lease_token_digest,
      lease_expires_at = LEAST(
        command.expires_at,
        p_now + make_interval(secs => p_lease_seconds)
      ),
      result = NULL,
      error_code = NULL,
      updated_at = p_now
    FROM candidate
    WHERE command.tenant_id = p_tenant_id
      AND command.id = candidate.id
    RETURNING command.*
  ),
  record_attempt AS (
    INSERT INTO command_attempts (
      tenant_id,
      command_id,
      attempt,
      lease_token_digest,
      claimed_at
    )
    SELECT
      tenant_id,
      id,
      attempt_count,
      lease_token_digest,
      p_now
    FROM claimed
    RETURNING command_id
  )
  SELECT
    claimed.id,
    claimed.required_scope,
    claimed.payload,
    claimed.created_by_kind,
    claimed.created_at,
    claimed.not_before,
    claimed.expires_at,
    claimed.attempt_count,
    claimed.lease_expires_at
  FROM claimed
  JOIN record_attempt ON record_attempt.command_id = claimed.id
$$;

CREATE FUNCTION extend_command_lease(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_command_id uuid,
  p_attempt integer,
  p_now timestamptz,
  p_lease_token_digest text,
  p_lease_seconds integer
)
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  UPDATE commands
  SET
    lease_expires_at = GREATEST(
      lease_expires_at,
      LEAST(
        expires_at,
        p_now + make_interval(secs => p_lease_seconds)
      )
    ),
    updated_at = p_now
  WHERE tenant_id = p_tenant_id
    AND connector_id = p_connector_id
    AND id = p_command_id
    AND state = 'leased'
    AND attempt_count = p_attempt
    AND lease_token_digest = p_lease_token_digest
    AND lease_expires_at > p_now
    AND expires_at > p_now
    AND p_lease_seconds BETWEEN 5 AND 300
  RETURNING lease_expires_at
$$;

CREATE FUNCTION complete_command(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_command_id uuid,
  p_attempt integer,
  p_now timestamptz,
  p_lease_token_digest text,
  p_outcome command_state,
  p_result jsonb,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer
)
RETURNS TABLE (
  completion_status text,
  command_state command_state
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  attempt_was_completed boolean;
  next_state command_state;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
    nullif(current_setting('app.tenant_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Command completion tenant does not match the active tenant';
  END IF;
  IF p_outcome NOT IN ('succeeded', 'rejected-by-local-policy', 'failed') THEN
    RAISE EXCEPTION 'Unsupported command outcome';
  END IF;
  IF p_lease_token_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid lease token digest';
  END IF;
  IF p_retryable AND p_outcome <> 'failed' THEN
    RAISE EXCEPTION 'Only failed commands may be retried';
  END IF;
  IF p_outcome = 'succeeded' AND p_error_code IS NOT NULL THEN
    RAISE EXCEPTION 'Succeeded commands cannot include an error code';
  END IF;
  IF p_outcome <> 'succeeded'
    AND (p_error_code IS NULL OR char_length(p_error_code) NOT BETWEEN 1 AND 200)
  THEN
    RAISE EXCEPTION 'Failed or rejected commands require a bounded error code';
  END IF;
  IF p_outcome <> 'succeeded' AND p_result IS NOT NULL THEN
    RAISE EXCEPTION 'Only succeeded commands may include a result';
  END IF;
  IF p_result IS NOT NULL AND pg_column_size(p_result) > 1048576 THEN
    RAISE EXCEPTION 'Command result exceeds the size limit';
  END IF;
  IF p_retry_after_seconds < 0 OR p_retry_after_seconds > 86400 THEN
    RAISE EXCEPTION 'Retry delay is out of range';
  END IF;
  IF p_attempt < 1 THEN
    RAISE EXCEPTION 'Command attempt must be positive';
  END IF;

  IF p_outcome = 'succeeded' AND EXISTS (
    SELECT 1
    FROM commands AS command
    WHERE command.tenant_id = p_tenant_id
      AND command.connector_id = p_connector_id
      AND command.id = p_command_id
      AND command.state = 'leased'
      AND command.attempt_count = p_attempt
      AND command.lease_token_digest = p_lease_token_digest
      AND command.lease_expires_at > p_now
      AND command.expires_at > p_now
      AND command.payload -> 'operation' ->> 'type' IS DISTINCT FROM p_result ->> 'type'
  ) THEN
    RAISE EXCEPTION 'Command result type does not match the leased operation';
  END IF;

  SELECT completed_at IS NOT NULL
  INTO attempt_was_completed
  FROM command_attempts
  WHERE tenant_id = p_tenant_id
    AND command_id = p_command_id
    AND attempt = p_attempt
    AND lease_token_digest = p_lease_token_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 'unknown-lease'::text, command.state
      FROM commands AS command
      WHERE command.tenant_id = p_tenant_id
        AND command.connector_id = p_connector_id
        AND command.id = p_command_id;
    RETURN;
  END IF;

  IF attempt_was_completed THEN
    RETURN QUERY
      SELECT 'duplicate'::text, command.state
      FROM commands AS command
      WHERE command.tenant_id = p_tenant_id
        AND command.connector_id = p_connector_id
        AND command.id = p_command_id;
    RETURN;
  END IF;

  UPDATE commands AS command
  SET
    state = CASE
      WHEN p_outcome = 'failed'
        AND p_retryable
        AND command.attempt_count < command.max_attempts
        AND p_now + make_interval(secs => p_retry_after_seconds) < command.expires_at
        THEN 'pending'::command_state
      WHEN p_outcome = 'failed'
        AND p_retryable
        AND command.attempt_count >= command.max_attempts
        THEN 'dead-lettered'::command_state
      WHEN p_outcome = 'failed'
        AND p_retryable
        THEN 'expired'::command_state
      ELSE p_outcome
    END,
    not_before = CASE
      WHEN p_outcome = 'failed'
        AND p_retryable
        AND command.attempt_count < command.max_attempts
        AND p_now + make_interval(secs => p_retry_after_seconds) < command.expires_at
        THEN p_now + make_interval(secs => p_retry_after_seconds)
      ELSE command.not_before
    END,
    lease_token_digest = NULL,
    lease_expires_at = NULL,
    result = CASE WHEN p_outcome = 'succeeded' THEN p_result ELSE NULL END,
    error_code = p_error_code,
    updated_at = p_now
  WHERE command.tenant_id = p_tenant_id
    AND command.connector_id = p_connector_id
    AND command.id = p_command_id
    AND command.state = 'leased'
    AND command.attempt_count = p_attempt
    AND command.lease_token_digest = p_lease_token_digest
    AND command.lease_expires_at > p_now
    AND command.expires_at > p_now
  RETURNING command.state INTO next_state;

  IF next_state IS NULL THEN
    RETURN QUERY
      SELECT 'stale'::text, command.state
      FROM commands AS command
      WHERE command.tenant_id = p_tenant_id
        AND command.connector_id = p_connector_id
        AND command.id = p_command_id;
    RETURN;
  END IF;

  UPDATE command_attempts
  SET
    completed_at = p_now,
    outcome = p_outcome,
    error_code = p_error_code
  WHERE tenant_id = p_tenant_id
    AND command_id = p_command_id
    AND attempt = p_attempt
    AND lease_token_digest = p_lease_token_digest;

  RETURN QUERY SELECT 'accepted'::text, next_state;
END
$$;

REVOKE ALL ON FUNCTION claim_command(uuid, uuid, scope_name[], timestamptz, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION extend_command_lease(uuid, uuid, uuid, integer, timestamptz, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_command(
  uuid,
  uuid,
  uuid,
  integer,
  timestamptz,
  text,
  command_state,
  jsonb,
  text,
  boolean,
  integer
) FROM PUBLIC;

GRANT knot_resolver TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO knot_resolver;
-- The migration owner must hold ADMIN OPTION on knot_resolver so this function can
-- run with a role that has only tenant-scoped command access.
ALTER FUNCTION complete_command(
  uuid,
  uuid,
  uuid,
  integer,
  timestamptz,
  text,
  command_state,
  jsonb,
  text,
  boolean,
  integer
) OWNER TO knot_resolver;

GRANT SELECT, UPDATE ON commands, command_attempts TO knot_resolver;

GRANT EXECUTE ON FUNCTION claim_command(uuid, uuid, scope_name[], timestamptz, text, integer) TO knot_app;
GRANT EXECUTE ON FUNCTION extend_command_lease(uuid, uuid, uuid, integer, timestamptz, text, integer) TO knot_app;
GRANT EXECUTE ON FUNCTION complete_command(
  uuid,
  uuid,
  uuid,
  integer,
  timestamptz,
  text,
  command_state,
  jsonb,
  text,
  boolean,
  integer
) TO knot_app;

REVOKE knot_resolver FROM CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;
