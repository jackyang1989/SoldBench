CREATE INDEX share_owner_created ON shares(user_id,created_at DESC,id DESC);
CREATE TABLE anonymous_cache_publications (
 canonical_query_hash text PRIMARY KEY CHECK(canonical_query_hash ~ '^[0-9a-f]{64}$'),
 query_id uuid NOT NULL,
 user_id uuid NOT NULL,
 published_at timestamptz NOT NULL,
 FOREIGN KEY(query_id,user_id) REFERENCES queries(id,user_id)
);
CREATE TABLE anonymous_cache_deliveries (
 day date NOT NULL,
 visitor_identity text NOT NULL,
 network_identity text NOT NULL,
 canonical_query_hash text NOT NULL,
 query_id uuid NOT NULL REFERENCES queries,
 delivered_at timestamptz NOT NULL,
 PRIMARY KEY(day,visitor_identity,network_identity,canonical_query_hash,query_id)
);
CREATE TABLE anonymous_rate_windows (
 bucket_hash text NOT NULL,
 window_start timestamptz NOT NULL,
 used int NOT NULL CHECK(used BETWEEN 1 AND 20),
 PRIMARY KEY(bucket_hash,window_start)
);
CREATE INDEX anonymous_delivery_day ON anonymous_cache_deliveries(day);
CREATE INDEX anonymous_quota_day ON anonymous_quota(day);
CREATE INDEX anonymous_rate_window_expiry ON anonymous_rate_windows(window_start);
