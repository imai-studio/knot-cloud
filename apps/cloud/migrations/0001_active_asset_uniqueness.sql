ALTER TABLE assets
  DROP CONSTRAINT assets_tenant_id_sha256_key,
  DROP CONSTRAINT assets_tenant_id_pathname_key;

CREATE UNIQUE INDEX assets_active_sha256_idx
  ON assets (tenant_id, sha256)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX assets_active_pathname_idx
  ON assets (tenant_id, pathname)
  WHERE deleted_at IS NULL;
