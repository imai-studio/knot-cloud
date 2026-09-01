-- Public reader isolation and connector-authorized publication controls.
ALTER TABLE publication_versions
  ADD COLUMN source_provenance jsonb,
  ADD COLUMN provenance_bound_at timestamptz,
  ADD CONSTRAINT publication_versions_provenance_pair CHECK (
    (source_provenance IS NULL) = (provenance_bound_at IS NULL)
  );

CREATE TABLE publication_connector_grants (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  permissions text[] NOT NULL CHECK (
    cardinality(permissions) BETWEEN 1 AND 4
    AND permissions <@ ARRAY['read', 'write', 'control', 'unpublish']::text[]
    AND array_position(permissions, NULL) IS NULL
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, publication_id, connector_id),
  FOREIGN KEY (tenant_id, publication_id)
    REFERENCES publications(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE CASCADE
);

INSERT INTO publication_connector_grants (
  tenant_id, publication_id, connector_id, permissions
)
SELECT DISTINCT tenant_id, publication_id, created_by_connector_id,
       ARRAY['read', 'write', 'control', 'unpublish']::text[]
FROM publication_versions;

ALTER TABLE publication_connector_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_connector_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON publication_connector_grants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON publication_connector_grants TO knot_app;

CREATE FUNCTION authorize_publication_write(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_publication_id uuid,
  requested_operation text
)
RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  publication_exists boolean;
BEGIN
  IF active_tenant_id IS NULL OR active_tenant_id <> requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF requested_operation NOT IN ('create', 'update') THEN
    RAISE EXCEPTION 'Invalid publication operation' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connectors
    WHERE tenant_id = requested_tenant_id
      AND id = requested_connector_id
      AND revoked_at IS NULL
      AND 'publications.write'::scope_name = ANY(scopes)
  ) THEN
    RAISE EXCEPTION 'Connector is not authorized to publish' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(requested_tenant_id::text || ':' || requested_publication_id::text, 0)
  );
  SELECT EXISTS (
    SELECT 1 FROM publications
    WHERE tenant_id = requested_tenant_id AND id = requested_publication_id
  ) INTO publication_exists;

  IF NOT publication_exists AND requested_operation <> 'create' THEN
    RAISE EXCEPTION 'Publication not found' USING ERRCODE = 'P0002';
  END IF;
  IF publication_exists AND NOT EXISTS (
    SELECT 1 FROM publication_connector_grants
    WHERE tenant_id = requested_tenant_id
      AND publication_id = requested_publication_id
      AND connector_id = requested_connector_id
      AND 'write' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION 'Connector has no publication grant' USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE FUNCTION grant_publication_creator(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_publication_id uuid,
  requested_version_id uuid
)
RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM publication_versions
    WHERE tenant_id = requested_tenant_id
      AND publication_id = requested_publication_id
      AND id = requested_version_id
      AND created_by_connector_id = requested_connector_id
  ) THEN
    RAISE EXCEPTION 'Publication version not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO publication_connector_grants (
    tenant_id, publication_id, connector_id, permissions
  ) VALUES (
    requested_tenant_id, requested_publication_id, requested_connector_id,
    ARRAY['read', 'write', 'control', 'unpublish']::text[]
  ) ON CONFLICT (tenant_id, publication_id, connector_id) DO NOTHING;
END
$$;

CREATE FUNCTION bind_publication_provenance(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_publication_id uuid,
  requested_version_id uuid,
  requested_provenance jsonb
)
RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_provenance jsonb;
  existing_bound_at timestamptz;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF pg_column_size(requested_provenance) > 4096 THEN
    RAISE EXCEPTION 'Publication provenance is too large' USING ERRCODE = '22023';
  END IF;
  SELECT source_provenance, provenance_bound_at
  INTO existing_provenance, existing_bound_at
  FROM publication_versions
  WHERE tenant_id = requested_tenant_id
    AND publication_id = requested_publication_id
    AND id = requested_version_id
    AND created_by_connector_id = requested_connector_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication version not found' USING ERRCODE = 'P0002';
  END IF;
  IF existing_bound_at IS NOT NULL THEN
    IF existing_provenance <> requested_provenance THEN
      RAISE EXCEPTION 'Idempotency key conflicts with publication provenance'
        USING ERRCODE = '23505';
    END IF;
    RETURN;
  END IF;

  UPDATE publication_versions
  SET source_provenance = requested_provenance,
      provenance_bound_at = now()
  WHERE tenant_id = requested_tenant_id AND id = requested_version_id;

  IF requested_provenance <> '{}'::jsonb THEN
    INSERT INTO audit_events (
      tenant_id, principal_kind, principal_id, action, target_kind,
      target_id, outcome, metadata
    ) VALUES (
      requested_tenant_id, 'connector-key', requested_connector_id,
      'publication.source.attested', 'publication-version',
      requested_version_id, 'accepted', requested_provenance
    );
  END IF;
END
$$;

CREATE FUNCTION prepare_publication_version_authorized(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_site_id uuid,
  requested_publication_id uuid,
  requested_version_id uuid,
  requested_slug text,
  requested_operation text,
  requested_schema_version text,
  requested_content_sha256 text,
  requested_bundle_path text,
  requested_document jsonb,
  requested_provenance jsonb,
  requested_idempotency_key text
)
RETURNS TABLE (
  publication_id uuid,
  version_id uuid,
  bundle_path text,
  version_state publication_state,
  duplicate boolean
)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  prepared record;
BEGIN
  PERFORM authorize_publication_write(
    requested_tenant_id, requested_connector_id, requested_publication_id,
    requested_operation
  );
  SELECT * INTO prepared
  FROM prepare_publication_version(
    requested_tenant_id, requested_connector_id, requested_site_id,
    requested_publication_id, requested_version_id, requested_slug,
    requested_operation, requested_schema_version, requested_content_sha256,
    requested_bundle_path, requested_document, requested_idempotency_key
  );
  PERFORM grant_publication_creator(
    requested_tenant_id, requested_connector_id, prepared.publication_id,
    prepared.version_id
  );
  PERFORM bind_publication_provenance(
    requested_tenant_id, requested_connector_id, prepared.publication_id,
    prepared.version_id, requested_provenance
  );
  RETURN QUERY SELECT prepared.publication_id, prepared.version_id,
                      prepared.bundle_path, prepared.version_state,
                      prepared.duplicate;
END
$$;

CREATE FUNCTION get_connector_publication_status(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_publication_id uuid
)
RETURNS TABLE (
  publication_id uuid,
  site_id uuid,
  slug text,
  publication_status text,
  current_version_id uuid,
  updated_at timestamptz
)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connectors
    WHERE tenant_id = requested_tenant_id
      AND id = requested_connector_id
      AND revoked_at IS NULL
      AND 'publications.read'::scope_name = ANY(scopes)
  ) OR NOT EXISTS (
    SELECT 1 FROM publication_connector_grants AS connector_grant
    WHERE connector_grant.tenant_id = requested_tenant_id
      AND connector_grant.publication_id = requested_publication_id
      AND connector_grant.connector_id = requested_connector_id
      AND 'read' = ANY(connector_grant.permissions)
  ) THEN
    RAISE EXCEPTION 'Connector has no publication read grant' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT publication.id, publication.site_id, publication.slug,
         CASE
           WHEN publication.unpublished_at IS NOT NULL THEN 'unpublished'
           WHEN publication.disabled_at IS NOT NULL THEN 'disabled'
           WHEN publication.current_version_id IS NULL THEN 'draft'
           ELSE 'ready'
         END,
         publication.current_version_id, publication.updated_at
  FROM publications AS publication
  WHERE publication.tenant_id = requested_tenant_id
    AND publication.id = requested_publication_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication not found' USING ERRCODE = 'P0002';
  END IF;
END
$$;

CREATE FUNCTION control_publication_as_connector(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_publication_id uuid,
  requested_operation text,
  requested_version_id uuid,
  requested_idempotency_key text,
  requested_request_sha256 text
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  required_scope scope_name;
  required_permission text;
  existing_record idempotency_records%ROWTYPE;
  response_body jsonb;
  operation_time timestamptz;
  resolved_version_id uuid;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF requested_request_sha256 !~ '^[a-f0-9]{64}$'
    OR char_length(requested_idempotency_key) NOT BETWEEN 16 AND 200
  THEN
    RAISE EXCEPTION 'Invalid publication control request' USING ERRCODE = '22023';
  END IF;
  IF requested_operation = 'publication.unpublish' THEN
    required_scope := 'publications.unpublish';
    required_permission := 'unpublish';
  ELSIF requested_operation IN ('publication.disable', 'publication.rollback') THEN
    required_scope := 'publications.write';
    required_permission := 'control';
  ELSE
    RAISE EXCEPTION 'Invalid publication control operation' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connectors
    WHERE tenant_id = requested_tenant_id
      AND id = requested_connector_id
      AND revoked_at IS NULL
      AND required_scope = ANY(scopes)
  ) THEN
    RAISE EXCEPTION 'Connector has no publication control scope' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO existing_record
  FROM idempotency_records
  WHERE tenant_id = requested_tenant_id
    AND credential_kind = 'connector-key'
    AND credential_id = requested_connector_id
    AND idempotency_key = requested_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF existing_record.request_sha256 <> requested_request_sha256 THEN
      RAISE EXCEPTION 'Idempotency key conflicts with another request' USING ERRCODE = '23505';
    END IF;
    RETURN existing_record.response_body;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM publication_connector_grants
    WHERE tenant_id = requested_tenant_id
      AND publication_id = requested_publication_id
      AND connector_id = requested_connector_id
      AND required_permission = ANY(permissions)
  ) THEN
    RAISE EXCEPTION 'Connector has no publication control grant' USING ERRCODE = '42501';
  END IF;

  IF requested_operation = 'publication.disable' THEN
    operation_time := disable_publication(requested_tenant_id, requested_publication_id);
    response_body := jsonb_build_object(
      'type', requested_operation,
      'publicationId', requested_publication_id,
      'disabledAt', floor(extract(epoch FROM operation_time))::bigint
    );
  ELSIF requested_operation = 'publication.rollback' THEN
    IF requested_version_id IS NULL THEN
      RAISE EXCEPTION 'Rollback requires a version' USING ERRCODE = '22023';
    END IF;
    resolved_version_id := rollback_publication(
      requested_tenant_id, requested_publication_id, requested_version_id
    );
    response_body := jsonb_build_object(
      'type', requested_operation,
      'publicationId', requested_publication_id,
      'currentVersionId', resolved_version_id
    );
  ELSE
    operation_time := unpublish_publication(requested_tenant_id, requested_publication_id);
    response_body := jsonb_build_object(
      'type', requested_operation,
      'publicationId', requested_publication_id,
      'unpublishedAt', floor(extract(epoch FROM operation_time))::bigint
    );
  END IF;

  INSERT INTO idempotency_records (
    tenant_id, credential_kind, credential_id, idempotency_key,
    request_sha256, response_status, response_body, expires_at
  ) VALUES (
    requested_tenant_id, 'connector-key', requested_connector_id,
    requested_idempotency_key, requested_request_sha256, 200,
    response_body, now() + interval '7 days'
  );
  INSERT INTO audit_events (
    tenant_id, principal_kind, principal_id, action, target_kind,
    target_id, outcome, metadata
  ) VALUES (
    requested_tenant_id, 'connector-key', requested_connector_id,
    requested_operation, 'publication', requested_publication_id,
    'succeeded', jsonb_build_object('requestSha256', requested_request_sha256)
  );
  RETURN response_body;
END
$$;

CREATE FUNCTION resolve_public_reader_page(
  requested_site_slug text,
  requested_publication_slug text
)
RETURNS TABLE (
  tenant_id uuid,
  site_id uuid,
  publication_id uuid,
  version_id uuid,
  document jsonb,
  content_sha256 text,
  updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT publication.tenant_id, publication.site_id, publication.id,
         version.id, version.document, version.content_sha256,
         publication.updated_at
  FROM public.sites AS site
  JOIN public.publications AS publication
    ON publication.tenant_id = site.tenant_id
   AND publication.site_id = site.id
  JOIN public.publication_versions AS version
    ON version.tenant_id = publication.tenant_id
   AND version.publication_id = publication.id
   AND version.id = publication.current_version_id
  WHERE site.slug = requested_site_slug
    AND publication.slug = requested_publication_slug
    AND publication.disabled_at IS NULL
    AND publication.unpublished_at IS NULL
    AND version.state = 'ready'
  ORDER BY publication.updated_at DESC, publication.id, version.id
  LIMIT 1
$$;

CREATE FUNCTION resolve_public_reader_asset(
  requested_site_slug text,
  requested_publication_id uuid,
  requested_sha256 text
)
RETURNS TABLE (
  tenant_id uuid,
  publication_id uuid,
  version_id uuid,
  sha256 text,
  content_type text,
  byte_size bigint
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT publication.tenant_id, publication.id, version.id, asset.sha256,
         asset.content_type, asset.byte_size
  FROM public.sites AS site
  JOIN public.publications AS publication
    ON publication.tenant_id = site.tenant_id
   AND publication.site_id = site.id
  JOIN public.publication_versions AS version
    ON version.tenant_id = publication.tenant_id
   AND version.publication_id = publication.id
   AND version.id = publication.current_version_id
  JOIN public.publication_assets AS link
    ON link.tenant_id = version.tenant_id
   AND link.publication_version_id = version.id
  JOIN public.assets AS asset
    ON asset.tenant_id = link.tenant_id
   AND asset.id = link.asset_id
  WHERE site.slug = requested_site_slug
    AND publication.id = requested_publication_id
    AND asset.sha256 = requested_sha256
    AND publication.disabled_at IS NULL
    AND publication.unpublished_at IS NULL
    AND version.state = 'ready'
    AND asset.verified_at IS NOT NULL
    AND asset.deleted_at IS NULL
  ORDER BY publication.updated_at DESC, publication.id, version.id, asset.id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION authorize_publication_write(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION grant_publication_creator(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bind_publication_provenance(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_publication_version_authorized(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_connector_publication_status(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_publication_as_connector(uuid, uuid, uuid, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_public_reader_page(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_public_reader_asset(text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION authorize_publication_write(uuid, uuid, uuid, text) TO knot_app;
GRANT EXECUTE ON FUNCTION grant_publication_creator(uuid, uuid, uuid, uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION bind_publication_provenance(uuid, uuid, uuid, uuid, jsonb) TO knot_app;
GRANT EXECUTE ON FUNCTION prepare_publication_version_authorized(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, text
) TO knot_app;
GRANT EXECUTE ON FUNCTION get_connector_publication_status(uuid, uuid, uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION control_publication_as_connector(uuid, uuid, uuid, text, uuid, text, text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_public_reader_page(text, text) TO knot_app;
GRANT EXECUTE ON FUNCTION resolve_public_reader_asset(text, uuid, text) TO knot_app;

GRANT knot_resolver TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO knot_resolver;
GRANT SELECT ON sites, publications, publication_versions, publication_assets, assets TO knot_resolver;
CREATE POLICY resolver_public_select ON sites FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_public_select ON publications FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_public_select ON publication_versions FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_public_select ON publication_assets FOR SELECT TO knot_resolver USING (true);
CREATE POLICY resolver_public_select ON assets FOR SELECT TO knot_resolver USING (true);
ALTER FUNCTION resolve_public_reader_page(text, text) OWNER TO knot_resolver;
ALTER FUNCTION resolve_public_reader_asset(text, uuid, text) OWNER TO knot_resolver;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER;
