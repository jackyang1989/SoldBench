ALTER TABLE sources ADD COLUMN ops_version int NOT NULL DEFAULT 1 CHECK(ops_version>0);
CREATE INDEX ops_query_jobs_order ON query_jobs(updated_at DESC,id DESC);
CREATE INDEX ops_charges_order ON billing_charges(created_at DESC,id DESC);
CREATE INDEX ops_audit_order ON audit_events(created_at DESC,id DESC);
CREATE INDEX support_requests_retention ON support_requests(retention_until,id);
CREATE INDEX auth_rate_windows_retention ON auth_rate_windows(window_start);
CREATE INDEX support_idempotency_expiry ON idempotency_records(expires_at) WHERE operation='support.submit';
