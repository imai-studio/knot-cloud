ALTER TABLE publication_versions
  ADD COLUMN document jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN idempotency_key text,
  ADD COLUMN requested_site_id uuid,
  ADD COLUMN requested_slug text,
  ADD COLUMN requested_operation text,
  ADD CONSTRAINT publication_versions_idempotency_length CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 16 AND 200
  ),
  ADD CONSTRAINT publication_versions_request_shape CHECK (
    (idempotency_key IS NULL AND requested_site_id IS NULL
      AND requested_slug IS NULL AND requested_operation IS NULL)
    OR
    (idempotency_key IS NOT NULL AND requested_site_id IS NOT NULL
      AND requested_slug IS NOT NULL
      AND requested_operation IN ('create', 'update'))
  );

CREATE UNIQUE INDEX publication_versions_connector_idempotency_idx
  ON publication_versions (tenant_id, created_by_connector_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE site_assets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  created_by_connector_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, asset_id),
  FOREIGN KEY (tenant_id, site_id)
    REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, asset_id)
    REFERENCES assets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE asset_uploads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  pathname text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 134217728),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 16 AND 200
  ),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, connector_id, idempotency_key),
  FOREIGN KEY (tenant_id, site_id)
    REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES connectors(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE deletion_outbox
  ADD COLUMN tombstoned_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_token_digest text CHECK (
    lease_token_digest IS NULL OR lease_token_digest ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT deletion_outbox_lease_pair CHECK (
    (lease_token_digest IS NULL) = (lease_expires_at IS NULL)
  );

CREATE INDEX deletion_outbox_lease_idx
  ON deletion_outbox (tenant_id, lease_expires_at)
  WHERE completed_at IS NULL AND lease_expires_at IS NOT NULL;

CREATE TABLE publication_maintenance_schedule (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  next_scan_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON publication_maintenance_schedule FROM PUBLIC;

CREATE FUNCTION schedule_publication_maintenance(
  requested_tenant_id uuid,
  requested_next_scan_at timestamptz
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Maintenance tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO publication_maintenance_schedule (tenant_id, next_scan_at)
  VALUES (requested_tenant_id, requested_next_scan_at)
  ON CONFLICT (tenant_id) DO UPDATE
  SET next_scan_at = least(
        publication_maintenance_schedule.next_scan_at,
        excluded.next_scan_at
      ),
      updated_at = now();
END
$$;

ALTER TABLE site_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_assets
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE asset_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_uploads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON site_assets, asset_uploads TO knot_app;

CREATE FUNCTION prepare_asset_upload(
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
    OR requested_byte_size NOT BETWEEN 1 AND 134217728
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

CREATE FUNCTION commit_asset_upload(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_upload_id uuid,
  requested_asset_id uuid,
  observed_sha256 text,
  observed_byte_size bigint,
  observed_content_type text
)
RETURNS TABLE (asset_id uuid, sha256 text, byte_size bigint, verified_at timestamptz)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  target_upload asset_uploads%ROWTYPE;
  resolved_asset_id uuid;
  verification_time timestamptz := now();
BEGIN
  IF active_tenant_id IS NULL OR active_tenant_id <> requested_tenant_id THEN
    RAISE EXCEPTION 'Asset tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target_upload
  FROM asset_uploads AS upload
  WHERE upload.tenant_id = requested_tenant_id
    AND upload.id = requested_upload_id
    AND upload.connector_id = requested_connector_id
    AND upload.asset_id = requested_asset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset upload not found' USING ERRCODE = 'P0002';
  END IF;
  IF target_upload.verified_at IS NULL AND target_upload.expires_at <= verification_time THEN
    RAISE EXCEPTION 'Asset upload expired' USING ERRCODE = '55000';
  END IF;
  IF target_upload.sha256 <> observed_sha256
    OR target_upload.byte_size <> observed_byte_size
    OR target_upload.content_type <> observed_content_type
  THEN
    RAISE EXCEPTION 'Asset verification does not match the upload request'
      USING ERRCODE = '22000';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(requested_tenant_id::text || ':' || target_upload.sha256, 0)
  );
  IF EXISTS (
    SELECT 1 FROM deletion_outbox
    WHERE tenant_id = requested_tenant_id
      AND pathname = target_upload.pathname
      AND completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Asset deletion is still pending' USING ERRCODE = '55000';
  END IF;

  SELECT asset.id INTO resolved_asset_id
  FROM assets AS asset
  WHERE asset.tenant_id = requested_tenant_id
    AND asset.sha256 = target_upload.sha256
  FOR UPDATE;
  IF resolved_asset_id IS NULL THEN
    INSERT INTO assets (
      id, tenant_id, sha256, pathname, content_type, byte_size, verified_at
    ) VALUES (
      target_upload.asset_id, requested_tenant_id, target_upload.sha256,
      target_upload.pathname, target_upload.content_type,
      target_upload.byte_size, verification_time
    ) RETURNING assets.id INTO resolved_asset_id;
  ELSE
    UPDATE assets
    SET pathname = target_upload.pathname,
        content_type = target_upload.content_type,
        byte_size = target_upload.byte_size,
        verified_at = verification_time,
        deleted_at = NULL
    WHERE tenant_id = requested_tenant_id AND id = resolved_asset_id;
  END IF;

  INSERT INTO site_assets (
    tenant_id, site_id, asset_id, created_by_connector_id
  ) VALUES (
    requested_tenant_id, target_upload.site_id, resolved_asset_id,
    requested_connector_id
  ) ON CONFLICT DO NOTHING;
  UPDATE asset_uploads AS upload
  SET verified_at = coalesce(upload.verified_at, verification_time)
  WHERE upload.tenant_id = requested_tenant_id
    AND upload.id = requested_upload_id;

  RETURN QUERY
  SELECT resolved_asset_id, target_upload.sha256, target_upload.byte_size,
         coalesce(target_upload.verified_at, verification_time);
END
$$;

CREATE FUNCTION prepare_publication_version(
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
  active_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  existing_version publication_versions%ROWTYPE;
  existing_publication publications%ROWTYPE;
BEGIN
  IF active_tenant_id IS NULL OR active_tenant_id <> requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF requested_operation NOT IN ('create', 'update') THEN
    RAISE EXCEPTION 'Invalid publication operation' USING ERRCODE = '22023';
  END IF;
  IF requested_content_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid publication digest' USING ERRCODE = '22023';
  END IF;
  IF char_length(requested_idempotency_key) NOT BETWEEN 16 AND 200 THEN
    RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  IF requested_bundle_path !~ format(
    '^tenants/%s/publications/%s/versions/%s/[a-f0-9]{64}[.]json$',
    requested_tenant_id,
    requested_publication_id,
    requested_version_id
  ) THEN
    RAISE EXCEPTION 'Invalid publication bundle path' USING ERRCODE = '22023';
  END IF;
  IF pg_column_size(requested_document) > 1048576 THEN
    RAISE EXCEPTION 'Publication document exceeds one MiB' USING ERRCODE = '22023';
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
  PERFORM 1 FROM sites
  WHERE tenant_id = requested_tenant_id AND id = requested_site_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing_version
  FROM publication_versions
  WHERE tenant_id = requested_tenant_id
    AND created_by_connector_id = requested_connector_id
    AND idempotency_key = requested_idempotency_key;
  IF FOUND THEN
    IF existing_version.publication_id <> requested_publication_id
      OR existing_version.content_sha256 <> requested_content_sha256
      OR existing_version.document <> requested_document
      OR existing_version.requested_site_id <> requested_site_id
      OR existing_version.requested_slug <> requested_slug
      OR existing_version.requested_operation <> requested_operation
    THEN
      RAISE EXCEPTION 'Idempotency key conflicts with another publication request'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing_version.publication_id, existing_version.id,
                        existing_version.bundle_path, existing_version.state,
                        true;
    RETURN;
  END IF;

  SELECT * INTO existing_publication
  FROM publications
  WHERE tenant_id = requested_tenant_id AND id = requested_publication_id
  FOR UPDATE;

  IF requested_operation = 'create' THEN
    IF FOUND THEN
      RAISE EXCEPTION 'Publication already exists' USING ERRCODE = '23505';
    END IF;
    INSERT INTO publications (id, tenant_id, site_id, slug)
    VALUES (
      requested_publication_id, requested_tenant_id, requested_site_id,
      requested_slug
    );
  ELSE
    IF NOT FOUND OR existing_publication.unpublished_at IS NOT NULL THEN
      RAISE EXCEPTION 'Publication not found' USING ERRCODE = 'P0002';
    END IF;
    IF existing_publication.site_id <> requested_site_id THEN
      RAISE EXCEPTION 'Publication belongs to another site' USING ERRCODE = '42501';
    END IF;
    UPDATE publications
    SET slug = requested_slug, updated_at = now()
    WHERE tenant_id = requested_tenant_id AND id = requested_publication_id;
  END IF;

  INSERT INTO publication_versions (
    id, tenant_id, publication_id, state, schema_version, content_sha256,
    bundle_path, document, created_by_connector_id, idempotency_key,
    requested_site_id, requested_slug, requested_operation
  ) VALUES (
    requested_version_id, requested_tenant_id, requested_publication_id,
    'draft', requested_schema_version, requested_content_sha256,
    requested_bundle_path, requested_document, requested_connector_id,
    requested_idempotency_key, requested_site_id, requested_slug,
    requested_operation
  );

  RETURN QUERY SELECT requested_publication_id, requested_version_id,
                      requested_bundle_path, 'draft'::publication_state,
                      false;
END
$$;

CREATE FUNCTION commit_publication_version(
  requested_tenant_id uuid,
  requested_connector_id uuid,
  requested_publication_id uuid,
  requested_version_id uuid,
  requested_asset_digests text[]
)
RETURNS publication_state
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  target_version_state publication_state;
  target_bundle_path text;
  target_site_id uuid;
  expected_assets integer;
  verified_assets integer;
BEGIN
  IF active_tenant_id IS NULL OR active_tenant_id <> requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  SELECT version.state, version.bundle_path, publication.site_id
  INTO target_version_state, target_bundle_path, target_site_id
  FROM publication_versions AS version
  JOIN publications AS publication
    ON publication.tenant_id = version.tenant_id
   AND publication.id = version.publication_id
  WHERE version.tenant_id = requested_tenant_id
    AND version.id = requested_version_id
    AND version.publication_id = requested_publication_id
    AND version.created_by_connector_id = requested_connector_id
    AND publication.unpublished_at IS NULL
  FOR UPDATE OF version, publication;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication version not found' USING ERRCODE = 'P0002';
  END IF;
  IF target_version_state = 'ready' THEN
    RETURN 'ready';
  END IF;
  IF target_version_state <> 'draft' OR target_bundle_path IS NULL THEN
    RAISE EXCEPTION 'Publication version cannot be committed' USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(requested_tenant_id::text || ':' || digest, 0)
  )
  FROM (
    SELECT DISTINCT unnest(requested_asset_digests) AS digest
    ORDER BY digest
  ) AS requested_assets;
  IF EXISTS (
    SELECT 1
    FROM assets AS asset
    JOIN deletion_outbox AS pending
      ON pending.tenant_id = asset.tenant_id
     AND pending.asset_id = asset.id
     AND pending.completed_at IS NULL
    WHERE asset.tenant_id = requested_tenant_id
      AND asset.sha256 = ANY(requested_asset_digests)
  ) THEN
    RAISE EXCEPTION 'One or more publication assets are pending deletion'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(DISTINCT digest)::integer INTO expected_assets
  FROM unnest(requested_asset_digests) AS digest;
  SELECT count(DISTINCT asset.sha256)::integer INTO verified_assets
  FROM assets AS asset
  JOIN site_assets AS site_asset
    ON site_asset.tenant_id = asset.tenant_id
   AND site_asset.asset_id = asset.id
  WHERE asset.tenant_id = requested_tenant_id
    AND site_asset.site_id = target_site_id
    AND asset.sha256 = ANY(requested_asset_digests)
    AND asset.verified_at IS NOT NULL
    AND asset.deleted_at IS NULL;
  IF expected_assets <> verified_assets THEN
    RAISE EXCEPTION 'One or more publication assets are not verified for the site'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO publication_assets (tenant_id, publication_version_id, asset_id)
  SELECT requested_tenant_id, requested_version_id, asset.id
  FROM assets AS asset
  JOIN site_assets AS site_asset
    ON site_asset.tenant_id = asset.tenant_id
   AND site_asset.asset_id = asset.id
  WHERE asset.tenant_id = requested_tenant_id
    AND site_asset.site_id = target_site_id
    AND asset.sha256 = ANY(requested_asset_digests)
  ON CONFLICT DO NOTHING;

  UPDATE publication_versions
  SET state = 'ready', committed_at = now()
  WHERE tenant_id = requested_tenant_id AND id = requested_version_id;
  UPDATE publications
  SET current_version_id = requested_version_id,
      disabled_at = NULL,
      updated_at = now()
  WHERE tenant_id = requested_tenant_id AND id = requested_publication_id;
  RETURN 'ready';
END
$$;

CREATE FUNCTION disable_publication(
  requested_tenant_id uuid,
  requested_publication_id uuid
)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  disabled_time timestamptz := now();
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  UPDATE publications SET disabled_at = disabled_time, updated_at = disabled_time
  WHERE tenant_id = requested_tenant_id
    AND id = requested_publication_id
    AND unpublished_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN disabled_time;
END
$$;

CREATE FUNCTION rollback_publication(
  requested_tenant_id uuid,
  requested_publication_id uuid,
  requested_version_id uuid
)
RETURNS uuid
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
      AND state = 'ready'
  ) THEN
    RAISE EXCEPTION 'Ready publication version not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE publications
  SET current_version_id = requested_version_id,
      disabled_at = NULL,
      updated_at = now()
  WHERE tenant_id = requested_tenant_id
    AND id = requested_publication_id
    AND unpublished_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN requested_version_id;
END
$$;

CREATE FUNCTION unpublish_publication(
  requested_tenant_id uuid,
  requested_publication_id uuid
)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  tombstone_time timestamptz := now();
  existing_unpublished_at timestamptz;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  SELECT publication.unpublished_at INTO existing_unpublished_at
  FROM publications AS publication
  WHERE publication.tenant_id = requested_tenant_id
    AND publication.id = requested_publication_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication not found' USING ERRCODE = 'P0002';
  END IF;
  IF existing_unpublished_at IS NOT NULL THEN
    RETURN existing_unpublished_at;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(requested_tenant_id::text || ':' || asset.sha256, 0)
  )
  FROM (
    SELECT DISTINCT linked_asset.sha256
    FROM assets AS linked_asset
    JOIN publication_assets AS link
      ON link.tenant_id = linked_asset.tenant_id
     AND link.asset_id = linked_asset.id
    JOIN publication_versions AS version
      ON version.tenant_id = link.tenant_id
     AND version.id = link.publication_version_id
    WHERE version.tenant_id = requested_tenant_id
      AND version.publication_id = requested_publication_id
    ORDER BY linked_asset.sha256
  ) AS asset;
  UPDATE publications
  SET current_version_id = NULL,
      disabled_at = tombstone_time,
      unpublished_at = tombstone_time,
      updated_at = tombstone_time
  WHERE tenant_id = requested_tenant_id
    AND id = requested_publication_id
    AND unpublished_at IS NULL;

  INSERT INTO deletion_outbox (
    tenant_id, publication_id, pathname, tombstoned_at
  )
  SELECT requested_tenant_id, requested_publication_id, version.bundle_path,
         tombstone_time
  FROM publication_versions AS version
  WHERE version.tenant_id = requested_tenant_id
    AND version.publication_id = requested_publication_id
    AND version.bundle_path IS NOT NULL
  ON CONFLICT (tenant_id, pathname) WHERE completed_at IS NULL DO NOTHING;

  INSERT INTO deletion_outbox (
    tenant_id, publication_id, asset_id, pathname, tombstoned_at
  )
  SELECT requested_tenant_id, requested_publication_id, asset.id,
         asset.pathname, tombstone_time
  FROM assets AS asset
  JOIN publication_assets AS link
    ON link.tenant_id = asset.tenant_id AND link.asset_id = asset.id
  JOIN publication_versions AS version
    ON version.tenant_id = link.tenant_id
   AND version.id = link.publication_version_id
  WHERE version.tenant_id = requested_tenant_id
    AND version.publication_id = requested_publication_id
    AND asset.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM publication_assets AS other_link
      JOIN publication_versions AS other_version
        ON other_version.tenant_id = other_link.tenant_id
       AND other_version.id = other_link.publication_version_id
      JOIN publications AS other_publication
        ON other_publication.tenant_id = other_version.tenant_id
       AND other_publication.id = other_version.publication_id
      WHERE other_link.tenant_id = asset.tenant_id
        AND other_link.asset_id = asset.id
        AND other_publication.id <> requested_publication_id
        AND other_publication.unpublished_at IS NULL
    )
  ON CONFLICT (tenant_id, pathname) WHERE completed_at IS NULL DO NOTHING;
  PERFORM schedule_publication_maintenance(requested_tenant_id, tombstone_time);
  RETURN tombstone_time;
END
$$;

CREATE FUNCTION claim_deletion_outbox(
  requested_tenant_id uuid,
  requested_now timestamptz,
  requested_lease_token_digest text,
  requested_lease_seconds integer,
  requested_limit integer
)
RETURNS TABLE (
  outbox_id uuid,
  publication_id uuid,
  asset_id uuid,
  pathname text,
  tombstoned_at timestamptz,
  attempt integer,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate record;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Deletion tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF requested_lease_token_digest !~ '^[a-f0-9]{64}$'
    OR requested_lease_seconds NOT BETWEEN 5 AND 300
    OR requested_limit NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'Invalid deletion claim' USING ERRCODE = '22023';
  END IF;

  FOR candidate IN
    SELECT row.id, row.asset_id, asset.sha256
    FROM deletion_outbox AS row
    JOIN assets AS asset
      ON asset.tenant_id = row.tenant_id AND asset.id = row.asset_id
    WHERE row.tenant_id = requested_tenant_id
      AND row.completed_at IS NULL
      AND row.dead_lettered_at IS NULL
      AND row.next_attempt_at <= requested_now
      AND (row.lease_expires_at IS NULL OR row.lease_expires_at <= requested_now)
    ORDER BY row.next_attempt_at, row.created_at, row.id
    LIMIT requested_limit
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended(requested_tenant_id::text || ':' || candidate.sha256, 0)
    );
    IF EXISTS (
      SELECT 1
      FROM publication_assets AS link
      JOIN publication_versions AS version
        ON version.tenant_id = link.tenant_id
       AND version.id = link.publication_version_id
      JOIN publications AS publication
        ON publication.tenant_id = version.tenant_id
       AND publication.id = version.publication_id
      WHERE link.tenant_id = requested_tenant_id
        AND link.asset_id = candidate.asset_id
        AND publication.unpublished_at IS NULL
    ) THEN
      UPDATE deletion_outbox
      SET completed_at = requested_now,
          lease_token_digest = NULL,
          lease_expires_at = NULL,
          last_error_code = 'asset-reused'
      WHERE tenant_id = requested_tenant_id AND id = candidate.id;
    END IF;
  END LOOP;

  RETURN QUERY
  WITH candidates AS (
    SELECT row.id
    FROM deletion_outbox AS row
    WHERE row.tenant_id = requested_tenant_id
      AND row.completed_at IS NULL
      AND row.dead_lettered_at IS NULL
      AND row.next_attempt_at <= requested_now
      AND (row.lease_expires_at IS NULL OR row.lease_expires_at <= requested_now)
    ORDER BY row.next_attempt_at, row.created_at, row.id
    FOR UPDATE SKIP LOCKED
    LIMIT requested_limit
  ), claimed AS (
    UPDATE deletion_outbox AS row
    SET attempts = row.attempts + 1,
        lease_token_digest = requested_lease_token_digest,
        lease_expires_at = requested_now + make_interval(secs => requested_lease_seconds)
    FROM candidates
    WHERE row.id = candidates.id
    RETURNING row.*
  )
  SELECT claimed.id, claimed.publication_id, claimed.asset_id,
         claimed.pathname, claimed.tombstoned_at, claimed.attempts,
         claimed.lease_expires_at
  FROM claimed ORDER BY claimed.next_attempt_at, claimed.created_at, claimed.id;
END
$$;

CREATE FUNCTION complete_deletion_outbox(
  requested_tenant_id uuid,
  requested_outbox_id uuid,
  requested_lease_token_digest text,
  requested_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  completed_asset_id uuid;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Deletion tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  UPDATE deletion_outbox
  SET completed_at = requested_now,
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL
  WHERE tenant_id = requested_tenant_id
    AND id = requested_outbox_id
    AND completed_at IS NULL
    AND lease_token_digest = requested_lease_token_digest
    AND lease_expires_at > requested_now
  RETURNING asset_id INTO completed_asset_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF completed_asset_id IS NOT NULL THEN
    UPDATE assets SET deleted_at = requested_now
    WHERE tenant_id = requested_tenant_id AND id = completed_asset_id;
  END IF;
  RETURN true;
END
$$;

CREATE FUNCTION retry_deletion_outbox(
  requested_tenant_id uuid,
  requested_outbox_id uuid,
  requested_lease_token_digest text,
  requested_now timestamptz,
  requested_delay_seconds integer,
  requested_error_code text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Deletion tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF requested_delay_seconds NOT BETWEEN 1 AND 86400
    OR requested_error_code !~ '^[a-z0-9][a-z0-9-]{0,99}$'
  THEN
    RAISE EXCEPTION 'Invalid deletion retry' USING ERRCODE = '22023';
  END IF;
  UPDATE deletion_outbox
  SET next_attempt_at = requested_now + make_interval(secs => requested_delay_seconds),
      lease_token_digest = NULL,
      lease_expires_at = NULL,
      last_error_code = requested_error_code,
      dead_lettered_at = CASE
        WHEN attempts >= 12 THEN requested_now
        ELSE dead_lettered_at
      END
  WHERE tenant_id = requested_tenant_id
    AND id = requested_outbox_id
    AND completed_at IS NULL
    AND lease_token_digest = requested_lease_token_digest
    AND lease_expires_at > requested_now;
  IF FOUND THEN
    PERFORM schedule_publication_maintenance(
      requested_tenant_id,
      requested_now + make_interval(secs => requested_delay_seconds)
    );
  END IF;
  RETURN FOUND;
END
$$;

CREATE FUNCTION finalize_unpublished_publication(
  requested_tenant_id uuid,
  requested_publication_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Publication tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM deletion_outbox
    WHERE tenant_id = requested_tenant_id
      AND publication_id = requested_publication_id
      AND completed_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  DELETE FROM publications
  WHERE tenant_id = requested_tenant_id
    AND id = requested_publication_id
    AND unpublished_at IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM assets AS asset
  WHERE asset.tenant_id = requested_tenant_id
    AND asset.deleted_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM publication_assets AS link
      WHERE link.tenant_id = asset.tenant_id AND link.asset_id = asset.id
    );
  RETURN true;
END
$$;

CREATE FUNCTION enqueue_publication_orphan_deletions(
  requested_tenant_id uuid,
  requested_now timestamptz,
  requested_grace_seconds integer,
  requested_limit integer
)
RETURNS integer
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  enqueued_count integer := 0;
BEGIN
  IF nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'Maintenance tenant does not match the active tenant' USING ERRCODE = '42501';
  END IF;
  IF requested_grace_seconds NOT BETWEEN 3600 AND 2592000
    OR requested_limit NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Invalid publication maintenance request' USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT upload.pathname
    FROM asset_uploads AS upload
    WHERE upload.tenant_id = requested_tenant_id
      AND upload.verified_at IS NULL
      AND upload.expires_at <= requested_now - make_interval(secs => requested_grace_seconds)
      AND NOT EXISTS (
        SELECT 1 FROM assets AS asset
        WHERE asset.tenant_id = upload.tenant_id
          AND asset.pathname = upload.pathname
          AND asset.deleted_at IS NULL
      )
    ORDER BY upload.expires_at, upload.id
    LIMIT requested_limit
  ), inserted AS (
    INSERT INTO deletion_outbox (tenant_id, pathname, tombstoned_at)
    SELECT requested_tenant_id, pathname, requested_now FROM candidates
    ON CONFLICT (tenant_id, pathname) WHERE completed_at IS NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO enqueued_count FROM inserted;

  DELETE FROM asset_uploads AS upload
  WHERE upload.tenant_id = requested_tenant_id
    AND upload.verified_at IS NULL
    AND upload.expires_at <= requested_now - make_interval(secs => requested_grace_seconds)
    AND EXISTS (
      SELECT 1 FROM deletion_outbox AS queued
      WHERE queued.tenant_id = upload.tenant_id
        AND queued.pathname = upload.pathname
        AND queued.completed_at IS NULL
    );

  WITH candidates AS (
    SELECT asset.id, asset.pathname
    FROM assets AS asset
    WHERE asset.tenant_id = requested_tenant_id
      AND asset.deleted_at IS NULL
      AND asset.verified_at IS NOT NULL
      AND asset.created_at <= requested_now - make_interval(secs => requested_grace_seconds)
      AND NOT EXISTS (
        SELECT 1
        FROM publication_assets AS link
        JOIN publication_versions AS version
          ON version.tenant_id = link.tenant_id
         AND version.id = link.publication_version_id
        JOIN publications AS publication
          ON publication.tenant_id = version.tenant_id
         AND publication.id = version.publication_id
        WHERE link.tenant_id = asset.tenant_id
          AND link.asset_id = asset.id
          AND publication.unpublished_at IS NULL
      )
    ORDER BY asset.created_at, asset.id
    LIMIT requested_limit
  ), inserted AS (
    INSERT INTO deletion_outbox (
      tenant_id, asset_id, pathname, tombstoned_at
    )
    SELECT requested_tenant_id, id, pathname, requested_now FROM candidates
    ON CONFLICT (tenant_id, pathname) WHERE completed_at IS NULL DO NOTHING
    RETURNING 1
  )
  SELECT enqueued_count + count(*)::integer
  INTO enqueued_count
  FROM inserted;

  PERFORM schedule_publication_maintenance(
    requested_tenant_id,
    requested_now + make_interval(secs => requested_grace_seconds)
  );

  RETURN enqueued_count;
END
$$;

CREATE FUNCTION list_publication_maintenance_tenants(
  requested_now timestamptz,
  requested_grace_seconds integer,
  requested_limit integer
)
RETURNS TABLE (tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF requested_grace_seconds NOT BETWEEN 3600 AND 2592000
    OR requested_limit NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Invalid publication maintenance request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT schedule.tenant_id
    FROM publication_maintenance_schedule AS schedule
    WHERE schedule.next_scan_at <= requested_now
    ORDER BY schedule.next_scan_at, schedule.tenant_id
    FOR UPDATE SKIP LOCKED
    LIMIT requested_limit
  )
  UPDATE publication_maintenance_schedule AS schedule
  SET next_scan_at = requested_now + make_interval(secs => requested_grace_seconds),
      updated_at = requested_now
  FROM due
  WHERE schedule.tenant_id = due.tenant_id
  RETURNING schedule.tenant_id;
END
$$;

REVOKE ALL ON FUNCTION prepare_publication_version(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_asset_upload(
  uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION commit_asset_upload(uuid, uuid, uuid, uuid, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION commit_publication_version(uuid, uuid, uuid, uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION disable_publication(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION rollback_publication(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION unpublish_publication(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_deletion_outbox(uuid, timestamptz, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_deletion_outbox(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retry_deletion_outbox(uuid, uuid, text, timestamptz, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_unpublished_publication(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_publication_orphan_deletions(uuid, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_publication_maintenance_tenants(timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION schedule_publication_maintenance(uuid, timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION prepare_publication_version(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb, text
) TO knot_app;
GRANT EXECUTE ON FUNCTION prepare_asset_upload(
  uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, text, text, timestamptz
) TO knot_app;
GRANT EXECUTE ON FUNCTION commit_asset_upload(uuid, uuid, uuid, uuid, text, bigint, text) TO knot_app;
GRANT EXECUTE ON FUNCTION commit_publication_version(uuid, uuid, uuid, uuid, text[]) TO knot_app;
GRANT EXECUTE ON FUNCTION disable_publication(uuid, uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION rollback_publication(uuid, uuid, uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION unpublish_publication(uuid, uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION claim_deletion_outbox(uuid, timestamptz, text, integer, integer) TO knot_app;
GRANT EXECUTE ON FUNCTION complete_deletion_outbox(uuid, uuid, text, timestamptz) TO knot_app;
GRANT EXECUTE ON FUNCTION retry_deletion_outbox(uuid, uuid, text, timestamptz, integer, text) TO knot_app;
GRANT EXECUTE ON FUNCTION finalize_unpublished_publication(uuid, uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION enqueue_publication_orphan_deletions(uuid, timestamptz, integer, integer) TO knot_app;
GRANT EXECUTE ON FUNCTION list_publication_maintenance_tenants(timestamptz, integer, integer) TO knot_app;
GRANT EXECUTE ON FUNCTION schedule_publication_maintenance(uuid, timestamptz) TO knot_app;

GRANT knot_resolver TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO knot_resolver;
GRANT SELECT, INSERT, UPDATE, DELETE ON publication_maintenance_schedule TO knot_resolver;
ALTER FUNCTION schedule_publication_maintenance(uuid, timestamptz)
  OWNER TO knot_resolver;
ALTER FUNCTION list_publication_maintenance_tenants(timestamptz, integer, integer)
  OWNER TO knot_resolver;
REVOKE CREATE ON SCHEMA public FROM knot_resolver;
REVOKE knot_resolver FROM CURRENT_USER;
