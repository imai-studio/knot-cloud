CREATE INDEX audit_events_tenant_cursor_idx
  ON audit_events (tenant_id, created_at DESC, id DESC);

CREATE INDEX audit_events_tenant_action_created_idx
  ON audit_events (tenant_id, action, created_at DESC, id DESC);

CREATE INDEX audit_events_tenant_outcome_created_idx
  ON audit_events (tenant_id, outcome, created_at DESC, id DESC);
