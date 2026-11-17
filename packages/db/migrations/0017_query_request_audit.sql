CREATE TABLE query_request_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users,
 operation text NOT NULL CHECK(operation ~ '^[a-z_]{1,64}$'), channel text NOT NULL CHECK(channel IN ('web','api','mcp')),
 query_id uuid, job_id uuid, http_status int NOT NULL CHECK(http_status BETWEEN 100 AND 599),
 error_code text CHECK(error_code ~ '^[a-z_]{1,80}$'), duration_ms int NOT NULL CHECK(duration_ms>=0),
 credits_charged int NOT NULL CHECK(credits_charged BETWEEN 0 AND 1), charge_id uuid REFERENCES billing_charges,
 ledger_ids uuid[] NOT NULL DEFAULT '{}', reused boolean, stale boolean,
 created_at timestamptz NOT NULL, retention_until timestamptz NOT NULL CHECK(retention_until>created_at)
);
CREATE INDEX query_request_audit_owner_time ON query_request_audit(user_id,created_at DESC,id DESC);
CREATE INDEX query_request_audit_expiry ON query_request_audit(retention_until);
