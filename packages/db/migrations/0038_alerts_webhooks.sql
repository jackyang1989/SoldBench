CREATE TABLE watchlists (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 canonical_query_hash text NOT NULL,
 query_params jsonb NOT NULL,
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('price_below','price_above','low_credits','job_completed')),
 threshold_cents bigint CHECK(threshold_cents BETWEEN 0 AND 9007199254740991),
 low_credits_threshold int CHECK(low_credits_threshold BETWEEN 0 AND 100000),
 schedule_mode text NOT NULL CHECK(schedule_mode IN ('passive_reuse','scheduled_refresh')),
 billing_consent_accepted boolean NOT NULL DEFAULT false,
 max_credits_per_month int NOT NULL DEFAULT 0 CHECK(max_credits_per_month BETWEEN 0 AND 1000),
 credits_used_this_period int NOT NULL DEFAULT 0 CHECK(credits_used_this_period >= 0),
 budget_period_key text NOT NULL DEFAULT '1970-01',
 locale text NOT NULL DEFAULT 'en' CHECK(locale IN ('en','zh-CN')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','unsubscribed')),
 unsubscribe_token_hash text NOT NULL UNIQUE,
 last_evaluated_at timestamptz,
 last_query_id uuid REFERENCES queries,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),
 CHECK(schedule_mode <> 'scheduled_refresh' OR (billing_consent_accepted = true AND max_credits_per_month >= 1)),
 CHECK((trigger_kind IN ('price_below','price_above') AND threshold_cents IS NOT NULL AND low_credits_threshold IS NULL)
    OR (trigger_kind='low_credits' AND low_credits_threshold IS NOT NULL AND threshold_cents IS NULL)
    OR (trigger_kind='job_completed' AND threshold_cents IS NULL AND low_credits_threshold IS NULL))
);
CREATE INDEX watchlists_owner ON watchlists(user_id,created_at DESC,id);
CREATE TABLE webhook_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 target_url text NOT NULL,
 signing_secret_ciphertext bytea NOT NULL,
 secret_prefix text NOT NULL,
 event_types text[] NOT NULL CHECK(cardinality(event_types) >= 1 AND event_types <@ ARRAY['price_alert','low_credits','job_completed']),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 UNIQUE(id,user_id)
);
CREATE INDEX webhook_endpoints_owner ON webhook_endpoints(user_id,created_at DESC,id);
CREATE TABLE alert_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 watchlist_id uuid NOT NULL,
 query_id uuid REFERENCES queries,
 event_type text NOT NULL CHECK(event_type IN ('price_alert','low_credits','job_completed')),
 dedupe_key text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,dedupe_key),
 UNIQUE(id,user_id),
 FOREIGN KEY(watchlist_id,user_id) REFERENCES watchlists(id,user_id) ON DELETE CASCADE
);
CREATE TABLE webhook_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 endpoint_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users,
 alert_event_id uuid NOT NULL,
 query_id uuid REFERENCES queries,
 status text NOT NULL CHECK(status IN ('pending','retry','delivered','dead_letter','cancelled_rights_revoked')),
 attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 max_attempts int NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
 next_attempt_at timestamptz NOT NULL,
 last_http_status int,
 last_error text,
 delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(endpoint_id,alert_event_id),
 FOREIGN KEY(endpoint_id,user_id) REFERENCES webhook_endpoints(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(alert_event_id,user_id) REFERENCES alert_events(id,user_id) ON DELETE CASCADE,
 CHECK(attempts <= max_attempts)
);
CREATE INDEX webhook_deliveries_queue ON webhook_deliveries(status,next_attempt_at,id);
CREATE INDEX webhook_deliveries_owner ON webhook_deliveries(user_id,created_at DESC,id);
COMMENT ON TABLE watchlists IS 'Saved query watchlists and alert rules enforcing explicit billing consent for scheduled refreshes.';
COMMENT ON TABLE webhook_deliveries IS 'Bounded signed webhook delivery queue that rechecks source rights and opt-out before every send.';
