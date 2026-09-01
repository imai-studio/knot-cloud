-- Durable connector replay protection. Rate-limit stores may remain external,
-- but accepting a signed mutation never depends on cache availability.

CREATE TABLE connector_request_nonces (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL,
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,200}$'),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, nonce),
  UNIQUE (connector_id, nonce),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > claimed_at)
);

CREATE INDEX connector_request_nonces_expiry_idx
  ON connector_request_nonces (tenant_id, connector_id, expires_at);

ALTER TABLE connector_request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_request_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON connector_request_nonces TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON connector_request_nonces TO knot_app;

CREATE FUNCTION claim_connector_request_nonce(
  p_tenant_id uuid,
  p_connector_id uuid,
  p_nonce text,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE claimed_rows bigint;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant context mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_nonce !~ '^[A-Za-z0-9_-]{16,200}$' OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid connector nonce claim' USING ERRCODE = '22023';
  END IF;

  -- Reuse is allowed only after the prior claim expires. Cleanup takes row
  -- locks before INSERT, so concurrent claims still have one winner.
  DELETE FROM connector_request_nonces
  WHERE tenant_id = p_tenant_id
    AND connector_id = p_connector_id
    AND expires_at <= now();

  INSERT INTO connector_request_nonces (
    tenant_id, connector_id, nonce, expires_at
  ) VALUES (
    p_tenant_id, p_connector_id, p_nonce, p_expires_at
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claimed_rows = ROW_COUNT;
  RETURN claimed_rows > 0;
END
$$;

REVOKE ALL ON FUNCTION claim_connector_request_nonce(uuid,uuid,text,timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_connector_request_nonce(uuid,uuid,text,timestamptz)
  TO knot_app;
