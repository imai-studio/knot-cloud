-- Enforce connector pairing targets inside the server authority boundary.
CREATE OR REPLACE FUNCTION prepare_asset_upload(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_site_id uuid,
  requested_upload_id uuid,
  requested_asset_id uuid,
  requested_sha256 text,
  requested_pathname text,
  requested_content_type text,
  requested_byte_size bigint,
  requested_file_name text,
  requested_idempotency_key text,
  requested_expires_at timestamptz
)
RETURNS TABLE (upload_id uuid, asset_id uuid, expires_at timestamptz, duplicate boolean)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  existing_upload asset_uploads%ROWTYPE;
BEGIN
  IF active_tenant_id IS NULL OR active_tenant_id <> requested_tenant_id THEN
    RAISE EXCEPTION 'Asset tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF requested_sha256 !~ '^[a-f0-9]{64}$'
    OR requested_pathname <> format(
      'tenants/%s/assets/%s/%s', requested_tenant_id,
      left(requested_sha256, 2), requested_sha256
    )
    OR requested_byte_size NOT BETWEEN 1 AND 104857600
    OR requested_expires_at <= now()
    OR requested_expires_at > now() + interval '15 minutes'
  THEN
    RAISE EXCEPTION 'Invalid asset upload' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connectors
    WHERE tenant_id = requested_tenant_id
      AND id = requested_connector_id
      AND revoked_at IS NULL
      AND 'publications.write'::scope_name = ANY(scopes)
  ) THEN
    RAISE EXCEPTION 'Connector is not authorized to upload assets' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connector_site_grants
    WHERE tenant_id = requested_tenant_id
      AND connector_id = requested_connector_id
      AND site_id = requested_site_id
  ) THEN
    RAISE EXCEPTION 'Connector has no grant for the requested site' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sites
    WHERE tenant_id = requested_tenant_id AND id = requested_site_id
  ) THEN
    RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing_upload
  FROM asset_uploads
  WHERE tenant_id = requested_tenant_id
    AND connector_id = requested_connector_id
    AND idempotency_key = requested_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF existing_upload.sha256 <> requested_sha256
      OR existing_upload.site_id <> requested_site_id
      OR existing_upload.content_type <> requested_content_type
      OR existing_upload.byte_size <> requested_byte_size
      OR existing_upload.file_name <> requested_file_name
    THEN
      RAISE EXCEPTION 'Idempotency key conflicts with another asset request'
        USING ERRCODE = '23505';
    END IF;
    IF existing_upload.verified_at IS NULL
      AND existing_upload.expires_at < requested_expires_at
    THEN
      UPDATE asset_uploads
      SET expires_at = requested_expires_at
      WHERE tenant_id = requested_tenant_id AND id = existing_upload.id
      RETURNING asset_uploads.expires_at INTO existing_upload.expires_at;
    END IF;
    PERFORM schedule_publication_maintenance(
      requested_tenant_id, existing_upload.expires_at
    );
    RETURN QUERY SELECT existing_upload.id, existing_upload.asset_id,
                        existing_upload.expires_at, true;
    RETURN;
  END IF;

  INSERT INTO asset_uploads (
    id, tenant_id, site_id, connector_id, asset_id, sha256, pathname,
    content_type, byte_size, file_name, idempotency_key, expires_at
  ) VALUES (
    requested_upload_id, requested_tenant_id, requested_site_id,
    requested_connector_id, requested_asset_id, requested_sha256,
    requested_pathname, requested_content_type, requested_byte_size,
    requested_file_name, requested_idempotency_key, requested_expires_at
  );
  PERFORM schedule_publication_maintenance(
    requested_tenant_id, requested_expires_at
  );
  RETURN QUERY SELECT requested_upload_id, requested_asset_id,
                      requested_expires_at, false;
END
$$;

CREATE OR REPLACE FUNCTION prepare_publication_version_authorized(
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
  IF NOT EXISTS (
    SELECT 1 FROM connector_site_grants
    WHERE tenant_id = requested_tenant_id
      AND connector_id = requested_connector_id
      AND site_id = requested_site_id
  ) THEN
    RAISE EXCEPTION 'Connector has no grant for the requested site' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connector_slug_grants
    WHERE tenant_id = requested_tenant_id
      AND connector_id = requested_connector_id
      AND (
        slug_grant = requested_slug
        OR (
          right(slug_grant, 1) = '*'
          AND strpos(requested_slug, left(slug_grant, length(slug_grant) - 1)) = 1
        )
      )
  ) THEN
    RAISE EXCEPTION 'Connector has no grant for the requested slug' USING ERRCODE = '42501';
  END IF;
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
