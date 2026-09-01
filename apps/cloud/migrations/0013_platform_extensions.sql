-- Reader access, custom domains, bounded platform quotas, and future provider jobs.

ALTER TABLE sites
  ADD COLUMN reader_access text NOT NULL DEFAULT 'public'
    CHECK (reader_access IN ('public', 'authenticated'));

CREATE TABLE tenant_platform_limits (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_sites integer NOT NULL DEFAULT 25 CHECK (max_sites BETWEEN 1 AND 1000),
  max_custom_domains integer NOT NULL DEFAULT 5 CHECK (max_custom_domains BETWEEN 0 AND 100),
  max_reader_grants integer NOT NULL DEFAULT 100 CHECK (max_reader_grants BETWEEN 0 AND 10000),
  max_api_keys integer NOT NULL DEFAULT 25 CHECK (max_api_keys BETWEEN 1 AND 1000),
  max_connectors integer NOT NULL DEFAULT 25 CHECK (max_connectors BETWEEN 1 AND 1000),
  max_storage_bytes bigint NOT NULL DEFAULT 1073741824
    CHECK (max_storage_bytes BETWEEN 1048576 AND 1099511627776),
  max_derivative_jobs_per_month integer NOT NULL DEFAULT 0
    CHECK (max_derivative_jobs_per_month BETWEEN 0 AND 1000000),
  media_derivatives_enabled boolean NOT NULL DEFAULT false,
  hosted_connectors_enabled boolean NOT NULL DEFAULT false,
  billing_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custom_domains (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  hostname text NOT NULL CHECK (
    hostname = lower(hostname)
    AND char_length(hostname) BETWEEN 4 AND 253
    AND hostname ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$'
  ),
  challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[a-f0-9]{64}$'),
  challenge_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'failed', 'disabled')),
  last_error_code text CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 100
  ),
  verified_at timestamptz,
  last_checked_at timestamptz,
  disabled_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)
    REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CHECK (challenge_expires_at > created_at)
);

CREATE TABLE reader_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  max_redemptions integer NOT NULL DEFAULT 1 CHECK (max_redemptions BETWEEN 1 AND 100),
  redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)
    REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (redemption_count <= max_redemptions)
);

CREATE TABLE reader_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id)
    REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, grant_id)
    REFERENCES reader_grants(tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE TABLE media_derivative_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_asset_id uuid NOT NULL,
  output_asset_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('thumbnail', 'preview')),
  output_content_type text NOT NULL
    CHECK (output_content_type IN ('image/avif', 'image/webp')),
  max_width integer NOT NULL CHECK (max_width BETWEEN 16 AND 4096),
  max_height integer NOT NULL CHECK (max_height BETWEEN 16 AND 4096),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  last_error_code text CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 100
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_asset_id)
    REFERENCES assets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, output_asset_id)
    REFERENCES assets(tenant_id, id) ON DELETE RESTRICT,
  CHECK (output_asset_id IS NULL OR output_asset_id <> source_asset_id),
  CHECK ((state = 'succeeded') = (output_asset_id IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (completed_at IS NOT NULL))
);

CREATE INDEX custom_domains_site_idx ON custom_domains (tenant_id, site_id, created_at);
CREATE UNIQUE INDEX custom_domains_active_tenant_hostname_idx
  ON custom_domains (tenant_id, hostname) WHERE status <> 'disabled';
CREATE UNIQUE INDEX custom_domains_verified_hostname_idx ON custom_domains (hostname)
  WHERE status = 'verified';
CREATE INDEX reader_grants_site_idx ON reader_grants (tenant_id, site_id, created_at DESC);
CREATE INDEX reader_sessions_expiry_idx ON reader_sessions (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX media_derivative_jobs_ready_idx
  ON media_derivative_jobs (tenant_id, state, created_at)
  WHERE state = 'pending';

ALTER TABLE tenant_platform_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_platform_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_domains FORCE ROW LEVEL SECURITY;
ALTER TABLE reader_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE reader_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE reader_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reader_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE media_derivative_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_derivative_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_platform_limits TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON custom_domains TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON reader_grants TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON reader_sessions TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON media_derivative_jobs TO knot_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY resolver_select ON custom_domains FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_select ON reader_grants FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_update ON reader_grants FOR UPDATE TO knot_resolver USING (true) WITH CHECK (true);
CREATE POLICY resolver_select ON reader_sessions FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_insert ON reader_sessions FOR INSERT TO knot_resolver WITH CHECK (true);
CREATE POLICY resolver_update ON reader_sessions FOR UPDATE TO knot_resolver USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant_platform_limits, custom_domains, reader_grants, reader_sessions,
  media_derivative_jobs
TO knot_app;

CREATE FUNCTION platform_limit_value(
  p_tenant_id uuid,
  p_name text
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
  SELECT CASE p_name
    WHEN 'sites' THEN coalesce((SELECT max_sites FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), 25)
    WHEN 'custom-domains' THEN coalesce((SELECT max_custom_domains FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), 5)
    WHEN 'reader-grants' THEN coalesce((SELECT max_reader_grants FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), 100)
    WHEN 'api-keys' THEN coalesce((SELECT max_api_keys FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), 25)
    WHEN 'connectors' THEN coalesce((SELECT max_connectors FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), 25)
    WHEN 'storage-bytes' THEN coalesce((SELECT max_storage_bytes FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), 1073741824)
    WHEN 'derivative-jobs' THEN coalesce((SELECT max_derivative_jobs_per_month FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), 0)
    ELSE NULL
  END
$$;

CREATE FUNCTION enforce_site_platform_quota()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':sites', 0));
  IF (SELECT count(*) FROM sites WHERE tenant_id = NEW.tenant_id) >=
     platform_limit_value(NEW.tenant_id, 'sites') THEN
    RAISE EXCEPTION 'site quota exceeded' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION enforce_api_key_platform_quota()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':api-keys', 0));
  IF (SELECT count(*) FROM api_keys WHERE tenant_id = NEW.tenant_id AND revoked_at IS NULL) >=
     platform_limit_value(NEW.tenant_id, 'api-keys') THEN
    RAISE EXCEPTION 'api key quota exceeded' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION enforce_connector_platform_quota()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':connectors', 0));
  IF (SELECT count(*) FROM connectors WHERE tenant_id = NEW.tenant_id AND revoked_at IS NULL) >=
     platform_limit_value(NEW.tenant_id, 'connectors') THEN
    RAISE EXCEPTION 'connector quota exceeded' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION enforce_asset_platform_quota()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_current bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':storage', 0));
  SELECT coalesce(sum(byte_size), 0) INTO v_current
  FROM assets
  WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL
    AND (TG_OP <> 'UPDATE' OR id <> NEW.id);
  IF v_current + NEW.byte_size > platform_limit_value(NEW.tenant_id, 'storage-bytes') THEN
    RAISE EXCEPTION 'storage quota exceeded' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION enforce_derivative_job_platform_quota()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT coalesce((
    SELECT media_derivatives_enabled
    FROM tenant_platform_limits
    WHERE tenant_id = NEW.tenant_id
  ), false) THEN
    RAISE EXCEPTION 'media derivatives are not enabled' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':derivative-jobs', 0));
  IF (SELECT count(*) FROM media_derivative_jobs
      WHERE tenant_id = NEW.tenant_id
        AND created_at >= date_trunc('month', now())) >=
     platform_limit_value(NEW.tenant_id, 'derivative-jobs') THEN
    RAISE EXCEPTION 'media derivative job quota exceeded' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sites_platform_quota BEFORE INSERT ON sites
  FOR EACH ROW EXECUTE FUNCTION enforce_site_platform_quota();
CREATE TRIGGER api_keys_platform_quota BEFORE INSERT ON api_keys
  FOR EACH ROW EXECUTE FUNCTION enforce_api_key_platform_quota();
CREATE TRIGGER connectors_platform_quota BEFORE INSERT ON connectors
  FOR EACH ROW EXECUTE FUNCTION enforce_connector_platform_quota();
CREATE TRIGGER assets_platform_quota BEFORE INSERT OR UPDATE OF byte_size, deleted_at ON assets
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL)
  EXECUTE FUNCTION enforce_asset_platform_quota();
CREATE TRIGGER media_derivative_jobs_platform_quota BEFORE INSERT ON media_derivative_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_derivative_job_platform_quota();

CREATE FUNCTION create_custom_domain(
  p_tenant_id uuid,
  p_user_id uuid,
  p_site_id uuid,
  p_domain_id uuid,
  p_hostname text,
  p_challenge_digest text,
  p_challenge_expires_at timestamptz
)
RETURNS custom_domains
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE v_domain custom_domains%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':custom-domains', 0));
  IF (SELECT count(*) FROM custom_domains WHERE tenant_id = p_tenant_id AND status <> 'disabled') >=
     platform_limit_value(p_tenant_id, 'custom-domains') THEN
    RAISE EXCEPTION 'custom domain quota exceeded' USING ERRCODE = 'P0001';
  END IF;
  IF p_challenge_expires_at <= now() OR p_challenge_expires_at > now() + interval '7 days' THEN
    RAISE EXCEPTION 'invalid domain challenge expiry' USING ERRCODE = '22023';
  END IF;
  INSERT INTO custom_domains (
    id, tenant_id, site_id, hostname, challenge_digest, challenge_expires_at, created_by
  ) VALUES (
    p_domain_id, p_tenant_id, p_site_id, p_hostname, p_challenge_digest,
    p_challenge_expires_at, p_user_id
  ) RETURNING * INTO v_domain;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome,
    metadata
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, 'custom-domain.create',
    'custom-domain', p_domain_id, 'succeeded', jsonb_build_object('hostname', p_hostname)
  );
  RETURN v_domain;
END
$$;

CREATE FUNCTION record_custom_domain_check(
  p_tenant_id uuid,
  p_user_id uuid,
  p_domain_id uuid,
  p_challenge_digest text,
  p_verified boolean,
  p_error_code text
)
RETURNS custom_domains
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE v_domain custom_domains%ROWTYPE;
BEGIN
  UPDATE custom_domains
  SET status = CASE WHEN p_verified THEN 'verified' ELSE 'failed' END,
      verified_at = CASE WHEN p_verified THEN coalesce(verified_at, now()) ELSE NULL END,
      disabled_at = NULL,
      last_checked_at = now(),
      last_error_code = CASE WHEN p_verified THEN NULL ELSE p_error_code END,
      updated_at = now()
  WHERE tenant_id = p_tenant_id AND id = p_domain_id
    AND status <> 'disabled' AND challenge_digest = p_challenge_digest
    AND challenge_expires_at > now()
  RETURNING * INTO v_domain;
  IF NOT FOUND THEN RAISE EXCEPTION 'custom domain not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome,
    metadata
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, 'custom-domain.verify',
    'custom-domain', p_domain_id, CASE WHEN p_verified THEN 'succeeded' ELSE 'failed' END,
    jsonb_build_object('errorCode', p_error_code)
  );
  RETURN v_domain;
END
$$;

CREATE FUNCTION disable_custom_domain(
  p_tenant_id uuid,
  p_user_id uuid,
  p_domain_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE custom_domains
  SET status = 'disabled', disabled_at = now(), verified_at = NULL, updated_at = now()
  WHERE tenant_id = p_tenant_id AND id = p_domain_id AND status <> 'disabled';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, 'custom-domain.disable',
    'custom-domain', p_domain_id, 'succeeded'
  );
  RETURN true;
END
$$;

CREATE FUNCTION create_reader_grant(
  p_tenant_id uuid,
  p_user_id uuid,
  p_site_id uuid,
  p_grant_id uuid,
  p_label text,
  p_token_digest text,
  p_expires_at timestamptz,
  p_max_redemptions integer
)
RETURNS reader_grants
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE v_grant reader_grants%ROWTYPE;
BEGIN
  IF p_expires_at <= now() OR p_expires_at > now() + interval '365 days' THEN
    RAISE EXCEPTION 'invalid reader grant expiry' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':reader-grants', 0));
  IF (SELECT count(*) FROM reader_grants WHERE tenant_id = p_tenant_id AND revoked_at IS NULL AND expires_at > now()) >=
     platform_limit_value(p_tenant_id, 'reader-grants') THEN
    RAISE EXCEPTION 'reader grant quota exceeded' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO reader_grants (
    id, tenant_id, site_id, label, token_digest, expires_at,
    max_redemptions, created_by
  ) VALUES (
    p_grant_id, p_tenant_id, p_site_id, p_label, p_token_digest,
    p_expires_at, p_max_redemptions, p_user_id
  ) RETURNING * INTO v_grant;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome,
    metadata
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, 'reader-grant.create',
    'reader-grant', p_grant_id, 'succeeded',
    jsonb_build_object('siteId', p_site_id, 'maxRedemptions', p_max_redemptions)
  );
  RETURN v_grant;
END
$$;

CREATE FUNCTION revoke_reader_grant(
  p_tenant_id uuid,
  p_user_id uuid,
  p_grant_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE reader_grants SET revoked_at = now()
  WHERE tenant_id = p_tenant_id AND id = p_grant_id AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE reader_sessions SET revoked_at = now()
  WHERE tenant_id = p_tenant_id AND grant_id = p_grant_id AND revoked_at IS NULL;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind, target_id, outcome
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, 'reader-grant.revoke',
    'reader-grant', p_grant_id, 'succeeded'
  );
  RETURN true;
END
$$;

CREATE FUNCTION redeem_reader_grant(
  p_grant_digest text,
  p_session_id uuid,
  p_session_digest text,
  p_session_expires_at timestamptz
)
RETURNS TABLE (tenant_id uuid, site_id uuid, site_slug text, session_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_grant reader_grants%ROWTYPE;
DECLARE v_expiry timestamptz;
BEGIN
  SELECT * INTO v_grant FROM reader_grants
  WHERE token_digest = p_grant_digest FOR UPDATE;
  IF NOT FOUND OR v_grant.revoked_at IS NOT NULL OR v_grant.expires_at <= now()
    OR v_grant.redemption_count >= v_grant.max_redemptions THEN
    RETURN;
  END IF;
  v_expiry := least(v_grant.expires_at, p_session_expires_at);
  IF v_expiry <= now() OR v_expiry > now() + interval '30 days' THEN RETURN; END IF;
  UPDATE reader_grants SET redemption_count = redemption_count + 1
  WHERE id = v_grant.id;
  INSERT INTO reader_sessions (
    id, tenant_id, site_id, grant_id, token_digest, expires_at
  ) VALUES (
    p_session_id, v_grant.tenant_id, v_grant.site_id, v_grant.id,
    p_session_digest, v_expiry
  );
  RETURN QUERY
  SELECT v_grant.tenant_id, v_grant.site_id, site.slug, v_expiry
  FROM sites AS site
  WHERE site.tenant_id = v_grant.tenant_id AND site.id = v_grant.site_id;
END
$$;

CREATE FUNCTION reader_session_authorizes(
  p_site_id uuid,
  p_session_digest text
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM reader_sessions AS session
    JOIN reader_grants AS reader_grant
      ON reader_grant.tenant_id = session.tenant_id AND reader_grant.id = session.grant_id
    WHERE session.site_id = p_site_id AND session.token_digest = p_session_digest
      AND session.revoked_at IS NULL AND session.expires_at > now()
      AND reader_grant.revoked_at IS NULL AND reader_grant.expires_at > now()
  )
$$;

-- The public reader functions shipped in 0009a are owned by the deliberately
-- constrained resolver role. Temporarily assume that role to narrow their
-- policy without transferring ownership back to the migration role.
GRANT knot_resolver TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO knot_resolver;
SET ROLE knot_resolver;

CREATE OR REPLACE FUNCTION resolve_public_reader_page(
  requested_site_slug text,
  requested_publication_slug text
)
RETURNS TABLE (
  tenant_id uuid, site_id uuid, publication_id uuid, version_id uuid,
  document jsonb, content_sha256 text, updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT publication.tenant_id, publication.site_id, publication.id,
         version.id, version.document, version.content_sha256, publication.updated_at
  FROM public.sites AS site
  JOIN public.publications AS publication
    ON publication.tenant_id = site.tenant_id AND publication.site_id = site.id
  JOIN public.publication_versions AS version
    ON version.tenant_id = publication.tenant_id
   AND version.publication_id = publication.id
   AND version.id = publication.current_version_id
  WHERE site.slug = requested_site_slug AND site.reader_access = 'public'
    AND publication.slug = requested_publication_slug
    AND publication.disabled_at IS NULL AND publication.unpublished_at IS NULL
    AND version.state = 'ready'
$$;

CREATE OR REPLACE FUNCTION resolve_public_reader_asset(
  requested_site_slug text,
  requested_publication_id uuid,
  requested_sha256 text
)
RETURNS TABLE (
  tenant_id uuid, publication_id uuid, version_id uuid,
  sha256 text, content_type text, byte_size bigint
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT publication.tenant_id, publication.id, version.id, asset.sha256,
         asset.content_type, asset.byte_size
  FROM public.sites AS site
  JOIN public.publications AS publication
    ON publication.tenant_id = site.tenant_id AND publication.site_id = site.id
  JOIN public.publication_versions AS version
    ON version.tenant_id = publication.tenant_id
   AND version.publication_id = publication.id
   AND version.id = publication.current_version_id
  JOIN public.publication_assets AS link
    ON link.tenant_id = version.tenant_id AND link.publication_version_id = version.id
  JOIN public.assets AS asset
    ON asset.tenant_id = link.tenant_id AND asset.id = link.asset_id
  WHERE site.slug = requested_site_slug AND site.reader_access = 'public'
    AND publication.id = requested_publication_id AND asset.sha256 = requested_sha256
    AND publication.disabled_at IS NULL AND publication.unpublished_at IS NULL
    AND version.state = 'ready' AND asset.verified_at IS NOT NULL AND asset.deleted_at IS NULL
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER;

CREATE FUNCTION resolve_reader_page(
  requested_site_slug text,
  requested_publication_slug text,
  requested_session_digest text
)
RETURNS TABLE (
  tenant_id uuid, site_id uuid, publication_id uuid, version_id uuid,
  document jsonb, content_sha256 text, updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT publication.tenant_id, publication.site_id, publication.id,
         version.id, version.document, version.content_sha256, publication.updated_at
  FROM public.sites AS site
  JOIN public.publications AS publication
    ON publication.tenant_id = site.tenant_id AND publication.site_id = site.id
  JOIN public.publication_versions AS version
    ON version.tenant_id = publication.tenant_id
   AND version.publication_id = publication.id
   AND version.id = publication.current_version_id
  WHERE site.slug = requested_site_slug
    AND (site.reader_access = 'public' OR public.reader_session_authorizes(site.id, requested_session_digest))
    AND publication.slug = requested_publication_slug
    AND publication.disabled_at IS NULL AND publication.unpublished_at IS NULL
    AND version.state = 'ready'
$$;

CREATE FUNCTION resolve_reader_asset(
  requested_site_slug text,
  requested_publication_id uuid,
  requested_sha256 text,
  requested_session_digest text
)
RETURNS TABLE (
  tenant_id uuid, publication_id uuid, version_id uuid,
  sha256 text, content_type text, byte_size bigint
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT publication.tenant_id, publication.id, version.id, asset.sha256,
         asset.content_type, asset.byte_size
  FROM public.sites AS site
  JOIN public.publications AS publication
    ON publication.tenant_id = site.tenant_id AND publication.site_id = site.id
  JOIN public.publication_versions AS version
    ON version.tenant_id = publication.tenant_id
   AND version.publication_id = publication.id
   AND version.id = publication.current_version_id
  JOIN public.publication_assets AS link
    ON link.tenant_id = version.tenant_id AND link.publication_version_id = version.id
  JOIN public.assets AS asset
    ON asset.tenant_id = link.tenant_id AND asset.id = link.asset_id
  WHERE site.slug = requested_site_slug
    AND (site.reader_access = 'public' OR public.reader_session_authorizes(site.id, requested_session_digest))
    AND publication.id = requested_publication_id AND asset.sha256 = requested_sha256
    AND publication.disabled_at IS NULL AND publication.unpublished_at IS NULL
    AND version.state = 'ready' AND asset.verified_at IS NOT NULL AND asset.deleted_at IS NULL
$$;

CREATE FUNCTION resolve_custom_domain_reader_page(
  requested_hostname text,
  requested_publication_slug text,
  requested_session_digest text
)
RETURNS TABLE (
  tenant_id uuid, site_id uuid, site_slug text, publication_id uuid, version_id uuid,
  document jsonb, content_sha256 text, updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT publication.tenant_id, publication.site_id, site.slug, publication.id,
         version.id, version.document, version.content_sha256, publication.updated_at
  FROM public.custom_domains AS domain
  JOIN public.sites AS site
    ON site.tenant_id = domain.tenant_id AND site.id = domain.site_id
  JOIN public.publications AS publication
    ON publication.tenant_id = site.tenant_id AND publication.site_id = site.id
  JOIN public.publication_versions AS version
    ON version.tenant_id = publication.tenant_id
   AND version.publication_id = publication.id
   AND version.id = publication.current_version_id
  WHERE domain.hostname = requested_hostname AND domain.status = 'verified'
    AND (site.reader_access = 'public' OR public.reader_session_authorizes(site.id, requested_session_digest))
    AND publication.slug = requested_publication_slug
    AND publication.disabled_at IS NULL AND publication.unpublished_at IS NULL
    AND version.state = 'ready'
$$;

CREATE FUNCTION resolve_custom_domain_site(requested_hostname text)
RETURNS TABLE (site_slug text, reader_access text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT site.slug, site.reader_access
  FROM public.custom_domains AS domain
  JOIN public.sites AS site
    ON site.tenant_id = domain.tenant_id AND site.id = domain.site_id
  WHERE domain.hostname = requested_hostname AND domain.status = 'verified'
$$;

CREATE FUNCTION resolve_reader_site_access(requested_site_slug text)
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT site.reader_access FROM public.sites AS site
  WHERE site.slug = requested_site_slug
$$;

CREATE FUNCTION get_platform_usage(p_tenant_id uuid)
RETURNS TABLE (
  sites_used bigint, sites_limit bigint,
  domains_used bigint, domains_limit bigint,
  reader_grants_used bigint, reader_grants_limit bigint,
  api_keys_used bigint, api_keys_limit bigint,
  connectors_used bigint, connectors_limit bigint,
  storage_bytes_used bigint, storage_bytes_limit bigint,
  derivative_jobs_used bigint, derivative_jobs_limit bigint,
  media_derivatives_enabled boolean,
  hosted_connectors_enabled boolean,
  billing_enabled boolean
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM sites WHERE tenant_id = p_tenant_id),
    platform_limit_value(p_tenant_id, 'sites'),
    (SELECT count(*) FROM custom_domains WHERE tenant_id = p_tenant_id AND status <> 'disabled'),
    platform_limit_value(p_tenant_id, 'custom-domains'),
    (SELECT count(*) FROM reader_grants WHERE tenant_id = p_tenant_id AND revoked_at IS NULL AND expires_at > now()),
    platform_limit_value(p_tenant_id, 'reader-grants'),
    (SELECT count(*) FROM api_keys WHERE tenant_id = p_tenant_id AND revoked_at IS NULL),
    platform_limit_value(p_tenant_id, 'api-keys'),
    (SELECT count(*) FROM connectors WHERE tenant_id = p_tenant_id AND revoked_at IS NULL),
    platform_limit_value(p_tenant_id, 'connectors'),
    coalesce((SELECT sum(byte_size) FROM assets WHERE tenant_id = p_tenant_id AND deleted_at IS NULL), 0),
    platform_limit_value(p_tenant_id, 'storage-bytes'),
    (SELECT count(*) FROM media_derivative_jobs WHERE tenant_id = p_tenant_id
       AND created_at >= date_trunc('month', now())),
    platform_limit_value(p_tenant_id, 'derivative-jobs'),
    coalesce((SELECT media_derivatives_enabled FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), false),
    coalesce((SELECT hosted_connectors_enabled FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), false),
    coalesce((SELECT billing_enabled FROM tenant_platform_limits WHERE tenant_id = p_tenant_id), false)
$$;

CREATE FUNCTION control_publication_as_human(
  p_tenant_id uuid,
  p_user_id uuid,
  p_publication_id uuid,
  p_operation text,
  p_version_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE v_at timestamptz;
DECLARE v_version uuid;
DECLARE v_result jsonb;
BEGIN
  IF p_operation = 'publication.disable' THEN
    v_at := disable_publication(p_tenant_id, p_publication_id);
    v_result := jsonb_build_object(
      'type', p_operation, 'publicationId', p_publication_id,
      'disabledAt', floor(extract(epoch from v_at))::bigint
    );
  ELSIF p_operation = 'publication.rollback' AND p_version_id IS NOT NULL THEN
    v_version := rollback_publication(p_tenant_id, p_publication_id, p_version_id);
    v_result := jsonb_build_object(
      'type', p_operation, 'publicationId', p_publication_id,
      'currentVersionId', v_version
    );
  ELSIF p_operation = 'publication.unpublish' THEN
    v_at := unpublish_publication(p_tenant_id, p_publication_id);
    v_result := jsonb_build_object(
      'type', p_operation, 'publicationId', p_publication_id,
      'unpublishedAt', floor(extract(epoch from v_at))::bigint
    );
  ELSE
    RAISE EXCEPTION 'invalid human publication control' USING ERRCODE = '22023';
  END IF;
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind,
    target_id, outcome, metadata
  ) VALUES (
    p_tenant_id, 'human-session', p_user_id, p_operation, 'publication',
    p_publication_id, 'succeeded',
    CASE WHEN p_version_id IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('versionId', p_version_id) END
  );
  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION platform_limit_value(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_derivative_job_platform_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION create_custom_domain(uuid,uuid,uuid,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_custom_domain_check(uuid,uuid,uuid,text,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION disable_custom_domain(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_reader_grant(uuid,uuid,uuid,uuid,text,text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_reader_grant(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION redeem_reader_grant(text,uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION reader_session_authorizes(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_reader_page(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_reader_asset(text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_custom_domain_reader_page(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_custom_domain_site(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_reader_site_access(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_platform_usage(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_publication_as_human(uuid,uuid,uuid,text,uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION platform_limit_value(uuid, text) TO knot_app;
GRANT EXECUTE ON FUNCTION create_custom_domain(uuid,uuid,uuid,uuid,text,text,timestamptz) TO knot_app;
GRANT EXECUTE ON FUNCTION record_custom_domain_check(uuid,uuid,uuid,text,boolean,text) TO knot_app;
GRANT EXECUTE ON FUNCTION disable_custom_domain(uuid,uuid,uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION create_reader_grant(uuid,uuid,uuid,uuid,text,text,timestamptz,integer) TO knot_app;
GRANT EXECUTE ON FUNCTION revoke_reader_grant(uuid,uuid,uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION redeem_reader_grant(text,uuid,text,timestamptz) TO knot_app;
GRANT EXECUTE ON FUNCTION reader_session_authorizes(uuid,text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_reader_page(text,text,text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_reader_asset(text,uuid,text,text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_custom_domain_reader_page(text,text,text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_custom_domain_site(text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_reader_site_access(text) TO knot_app;
GRANT EXECUTE ON FUNCTION get_platform_usage(uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION control_publication_as_human(uuid,uuid,uuid,text,uuid) TO knot_app;

-- Public reader token exchange and resolution deliberately run as the narrow
-- resolver role, never as the migration owner.
GRANT knot_resolver TO CURRENT_USER;
GRANT SELECT ON custom_domains, reader_grants, reader_sessions TO knot_resolver;
GRANT UPDATE ON reader_grants, reader_sessions TO knot_resolver;
GRANT INSERT ON reader_sessions TO knot_resolver;
ALTER FUNCTION redeem_reader_grant(text,uuid,text,timestamptz) OWNER TO knot_resolver;
ALTER FUNCTION reader_session_authorizes(uuid,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_reader_page(text,text,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_reader_asset(text,uuid,text,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_custom_domain_reader_page(text,text,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_custom_domain_site(text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_reader_site_access(text) OWNER TO knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER;

GRANT knot_resolver TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO knot_resolver;
GRANT SELECT ON custom_domains, reader_grants, reader_sessions TO knot_resolver;
GRANT UPDATE ON reader_grants, reader_sessions TO knot_resolver;
GRANT INSERT ON reader_sessions TO knot_resolver;
ALTER FUNCTION redeem_reader_grant(text,uuid,text,timestamptz) OWNER TO knot_resolver;
ALTER FUNCTION reader_session_authorizes(uuid,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_reader_page(text,text,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_reader_asset(text,uuid,text,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_custom_domain_reader_page(text,text,text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_custom_domain_site(text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_reader_site_access(text) OWNER TO knot_resolver;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER;
