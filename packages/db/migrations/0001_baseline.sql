-- SoldBench contract 1.1. PostgreSQL 16 isolated design baseline, not a deployed migration.
BEGIN;
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, password_hash text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','deleted')),
 email_verified_at timestamptz, deleted_at timestamptz, free_anchor_at timestamptz,
 terms_version text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status='deleted' OR (email IS NOT NULL AND password_hash IS NOT NULL))
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 authenticated_at timestamptz NOT NULL, mfa_at timestamptz, device_label text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE TABLE auth_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 token_hash text NOT NULL UNIQUE, purpose text NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 key_hash text NOT NULL UNIQUE, key_prefix text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 scopes text[] NOT NULL CHECK(scopes <@ ARRAY['sold:read','jobs:read','usage:read']),
 created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz, UNIQUE(id,user_id)
);
CREATE TABLE admin_roles (
 user_id uuid PRIMARY KEY REFERENCES users, role text NOT NULL CHECK(role IN ('support','admin')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_mfa (
 user_id uuid PRIMARY KEY REFERENCES users, encrypted_totp_secret text NOT NULL, key_version text NOT NULL,
 enabled_at timestamptz NOT NULL, last_used_step bigint, recovery_code_hashes text[] NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE source_clearances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, dataset text NOT NULL,
 revision int NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN ('draft','reviewed','active','suspended','expired','revoked')),
 allowed_access_methods text[] NOT NULL DEFAULT '{}', permitted_fields jsonb NOT NULL DEFAULT '{}',
 can_store_raw boolean NOT NULL DEFAULT false, can_store_derived boolean NOT NULL DEFAULT false,
 can_redistribute_comp boolean NOT NULL DEFAULT false, can_publish_stats boolean NOT NULL DEFAULT false,
 can_share boolean NOT NULL DEFAULT false, rights_scope jsonb NOT NULL DEFAULT '{}',
 retention_days int CHECK(retention_days>0), jurisdiction text, effective_at timestamptz, expires_at timestamptz,
 document_ref text, document_hash text, termination_policy_ref text,
 reviewed_by text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,dataset,revision), UNIQUE(id,revision),
 CHECK(status <> 'active' OR (document_ref IS NOT NULL AND document_hash IS NOT NULL AND reviewed_by IS NOT NULL AND effective_at IS NOT NULL AND expires_at IS NOT NULL)),
 CHECK(expires_at IS NULL OR expires_at>effective_at)
);
CREATE TABLE sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_clearance_id uuid NOT NULL REFERENCES source_clearances,
 marketplace text NOT NULL CHECK(marketplace='ebay_us'), access_method text NOT NULL CHECK(access_method IN ('offline_fixture','approved_http','approved_browser')),
 collector_version text NOT NULL, entrypoint_id text NOT NULL, status text NOT NULL CHECK(status IN ('disabled','active','suspended','revoked')),
 permission_epoch bigint NOT NULL DEFAULT 1 CHECK(permission_epoch>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collector_configs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources,
 collector_version text NOT NULL, allowed_entrypoints jsonb NOT NULL, access_method text NOT NULL,
 rate_cap int NOT NULL CHECK(rate_cap>0), concurrency_cap int NOT NULL CHECK(concurrency_cap>0),
 max_pages int NOT NULL CHECK(max_pages>0), max_bytes_per_job bigint NOT NULL CHECK(max_bytes_per_job>0),
 enabled boolean NOT NULL DEFAULT false, last_approval_ref text, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,source_id)
);
CREATE TABLE collector_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources, config_id uuid NOT NULL,
 query_hash text NOT NULL, collector_version text NOT NULL, parser_version text NOT NULL,
 permission_snapshot_hash text NOT NULL, request_count int NOT NULL DEFAULT 0 CHECK(request_count>=0),
 page_count int NOT NULL DEFAULT 0 CHECK(page_count>=0), bytes_in bigint NOT NULL DEFAULT 0 CHECK(bytes_in>=0),
 cpu_ms bigint NOT NULL DEFAULT 0 CHECK(cpu_ms>=0), compute_cost_cents bigint NOT NULL DEFAULT 0 CHECK(compute_cost_cents>=0),
 network_cost_cents bigint NOT NULL DEFAULT 0 CHECK(network_cost_cents>=0), started_at timestamptz NOT NULL,
 completed_at timestamptz, outcome text, stop_reason text, checkpoint jsonb,
 FOREIGN KEY(config_id,source_id) REFERENCES collector_configs(id,source_id), UNIQUE(id,source_id)
);
CREATE TABLE source_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources,
 collector_run_id uuid NOT NULL, captured_at timestamptz NOT NULL, source_as_of timestamptz,
 raw_hash text NOT NULL, raw_object_key text, retention_until timestamptz, parser_version text NOT NULL,
 record_count int NOT NULL CHECK(record_count>=0), permitted_visibility jsonb NOT NULL,
 FOREIGN KEY(collector_run_id,source_id) REFERENCES collector_runs(id,source_id),
 UNIQUE(id,source_id), UNIQUE(collector_run_id,raw_hash)
);
CREATE TABLE sold_listings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources,
 marketplace text NOT NULL, external_listing_id text NOT NULL, title text, url text,
 condition_raw text, condition_std text NOT NULL DEFAULT 'unknown', category_path text,
 first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
 UNIQUE(source_id,external_listing_id), UNIQUE(id,source_id)
);
CREATE TABLE sale_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_id uuid NOT NULL, source_id uuid NOT NULL REFERENCES sources,
 observation_id uuid NOT NULL, source_event_key text, identity_fingerprint text,
 event_identity_status text NOT NULL CHECK(event_identity_status IN ('verified','uncertain')),
 sold_at timestamptz, sold_date_raw text, sold_date_precision text NOT NULL CHECK(sold_date_precision IN ('second','day','unknown')),
 source_timezone text, sale_format text NOT NULL CHECK(sale_format IN ('fixed_price','auction','best_offer','unknown')),
 sale_price_status text NOT NULL CHECK(sale_price_status IN ('verified_actual','displayed_only','unknown')),
 item_price_cents bigint CHECK(item_price_cents BETWEEN 0 AND 9007199254740991),
 observed_shipping_cents bigint CHECK(observed_shipping_cents BETWEEN 0 AND 9007199254740991),
 observed_shipping_status text NOT NULL CHECK(observed_shipping_status IN ('observed','verified_free_shipping','unknown')),
 currency char(3) NOT NULL, item_price_usd_cents bigint CHECK(item_price_usd_cents BETWEEN 0 AND 9007199254740991),
 shipping_usd_cents bigint CHECK(shipping_usd_cents BETWEEN 0 AND 9007199254740991),
 fx_rate_source text, evidence_kind text, evidence_ref text, first_seen_at timestamptz NOT NULL,
 FOREIGN KEY(listing_id,source_id) REFERENCES sold_listings(id,source_id),
 FOREIGN KEY(observation_id,source_id) REFERENCES source_observations(id,source_id),
 UNIQUE(id,listing_id,source_id,observation_id),
 CHECK(sale_price_status<>'verified_actual' OR (item_price_cents IS NOT NULL AND evidence_kind IS NOT NULL AND evidence_ref IS NOT NULL)),
 CHECK((observed_shipping_status='unknown' AND observed_shipping_cents IS NULL AND shipping_usd_cents IS NULL) OR
       (observed_shipping_status='observed' AND observed_shipping_cents IS NOT NULL) OR
       (observed_shipping_status='verified_free_shipping' AND observed_shipping_cents=0 AND shipping_usd_cents=0)),
 CHECK(event_identity_status<>'verified' OR (evidence_ref IS NOT NULL AND (source_event_key IS NOT NULL OR identity_fingerprint IS NOT NULL)))
);
CREATE UNIQUE INDEX event_source_key ON sale_events(source_id,source_event_key) WHERE source_event_key IS NOT NULL;
CREATE UNIQUE INDEX event_fingerprint ON sale_events(source_id,identity_fingerprint) WHERE source_event_key IS NULL AND identity_fingerprint IS NOT NULL;
CREATE INDEX event_time ON sale_events(source_id,sold_at DESC,id);
CREATE TABLE listing_attributes (
 listing_id uuid PRIMARY KEY REFERENCES sold_listings, brand text, model text, edition text, year int,
 grade_company text, grade_value text, variant_attrs jsonb NOT NULL DEFAULT '{}', extractor_version text NOT NULL
);
CREATE TABLE listing_flags (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_id uuid NOT NULL REFERENCES sold_listings,
 rule_id text NOT NULL, flag text NOT NULL, cleaner_version text NOT NULL, evidence jsonb NOT NULL,
 UNIQUE(listing_id,rule_id,cleaner_version,flag)
);
CREATE TABLE collector_circuits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources,
 category_key text NOT NULL DEFAULT '*', status text NOT NULL CHECK(status IN ('closed','open','half_open')),
 opened_reason text, opened_at timestamptz, last_probe_at timestamptz, resume_approval_ref text, UNIQUE(source_id,category_key)
);
CREATE TABLE collector_health_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources,
 captured_at timestamptz NOT NULL, last_success_at timestamptz, metrics jsonb NOT NULL
);
CREATE TABLE collector_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources,
 collector_run_id uuid, reason text NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','expired')),
 dedupe_key text NOT NULL, attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, lease_owner text, lease_until timestamptz, version int NOT NULL DEFAULT 1,
 checkpoint jsonb, error_code text, stopped_reason text, started_at timestamptz, finished_at timestamptz,
 FOREIGN KEY(collector_run_id,source_id) REFERENCES collector_runs(id,source_id)
);
CREATE UNIQUE INDEX collector_active_dedupe ON collector_jobs(dedupe_key) WHERE status IN ('queued','running');
CREATE TABLE category_taxonomy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), marketplace text NOT NULL, category_path text NOT NULL,
 name text NOT NULL, parent_id uuid REFERENCES category_taxonomy, active boolean NOT NULL DEFAULT false,
 attribute_schema jsonb NOT NULL, supported_windows int[] NOT NULL DEFAULT '{30,90}', UNIQUE(marketplace,category_path)
);
CREATE TABLE data_availability (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources, category_path text NOT NULL,
 last_successful_observation_at timestamptz, freshness_state text NOT NULL CHECK(freshness_state IN ('fresh','stale_acceptable','expired','forbidden','never_observed')),
 collector_status text NOT NULL, can_serve_history boolean NOT NULL DEFAULT false, last_transition_at timestamptz NOT NULL,
 UNIQUE(source_id,category_path)
);
CREATE TABLE queries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users, anonymous_owner_hash text,
 api_key_id uuid, canonical_query_hash text NOT NULL, normalizer_version text NOT NULL,
 normalized_query text NOT NULL, filters jsonb NOT NULL, marketplace text NOT NULL,
 window_days int NOT NULL CHECK(window_days IN (30,90,180,365)),
 price_basis text NOT NULL CHECK(price_basis IN ('item','item_plus_observed_shipping')),
 requested_limit int NOT NULL CHECK(requested_limit BETWEEN 1 AND 200), allow_stale boolean NOT NULL DEFAULT false,
 as_of timestamptz NOT NULL, billing_policy_version text NOT NULL,
 compute_status text NOT NULL CHECK(compute_status IN ('queued','running','completed','failed','expired','cancelled')),
 settlement_status text NOT NULL CHECK(settlement_status IN ('pending','not_required','charged','refunded')),
 result_state text NOT NULL CHECK(result_state IN ('absent','ready','available','expired','forbidden')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, delivered_at timestamptz,
 version int NOT NULL DEFAULT 1, UNIQUE(id,user_id),
 CHECK((user_id IS NULL)<>(anonymous_owner_hash IS NULL)),
 CHECK(api_key_id IS NULL OR user_id IS NOT NULL),
 FOREIGN KEY(api_key_id,user_id) REFERENCES api_keys(id,user_id)
);
CREATE INDEX queries_reuse ON queries(user_id,canonical_query_hash,created_at DESC);
CREATE TABLE query_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), query_id uuid NOT NULL UNIQUE REFERENCES queries,
 dedupe_key text NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed','expired','cancelled')),
 retries int NOT NULL DEFAULT 0 CHECK(retries>=0), available_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 lease_owner text, lease_until timestamptz, version int NOT NULL DEFAULT 1,
 status_message text, error_code text, retryable boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX query_active_dedupe ON query_jobs(dedupe_key) WHERE status IN ('queued','running');
CREATE TABLE query_results (
 query_id uuid PRIMARY KEY REFERENCES queries, stats jsonb NOT NULL, quality jsonb NOT NULL,
 snapshot_version text NOT NULL, engine_version text NOT NULL, cleaner_version text NOT NULL,
 parser_versions jsonb NOT NULL, candidate_set_hash text NOT NULL, source_scope jsonb NOT NULL,
 data_as_of timestamptz, coverage_status text NOT NULL CHECK(coverage_status IN ('complete','partial','unknown')),
 archive_coverage numeric CHECK(archive_coverage BETWEEN 0 AND 1),
 source_window_start timestamptz, source_window_end timestamptz,
 CHECK(coverage_status<>'unknown' OR archive_coverage IS NULL)
);
CREATE TABLE query_result_sources (
 query_id uuid NOT NULL REFERENCES queries, source_id uuid NOT NULL REFERENCES sources,
 clearance_id uuid NOT NULL REFERENCES source_clearances, permission_epoch bigint NOT NULL,
 PRIMARY KEY(query_id,source_id)
);
CREATE INDEX result_source_invalidation ON query_result_sources(source_id,query_id);
CREATE TABLE query_comparables (
 query_id uuid NOT NULL REFERENCES queries, sale_event_id uuid NOT NULL REFERENCES sale_events,
 match_rule_version text NOT NULL, match_score numeric CHECK(match_score BETWEEN 0 AND 1),
 is_comparable boolean NOT NULL, include_in_price_stats boolean NOT NULL,
 primary_exclusion_reason text, exclusion_reasons jsonb NOT NULL DEFAULT '[]',
 outlier_candidate boolean NOT NULL DEFAULT false, candidate_set_hash text NOT NULL,
 PRIMARY KEY(query_id,sale_event_id), CHECK(NOT include_in_price_stats OR is_comparable)
);
CREATE TABLE query_result_items (
 query_id uuid NOT NULL REFERENCES queries, sale_event_id uuid NOT NULL REFERENCES sale_events,
 presentation_order int NOT NULL CHECK(presentation_order>=0), visible_payload jsonb NOT NULL,
 PRIMARY KEY(query_id,sale_event_id), UNIQUE(query_id,presentation_order)
);
CREATE TABLE query_calculation_inputs (
 query_id uuid NOT NULL REFERENCES queries, sale_event_id uuid NOT NULL REFERENCES sale_events,
 price_usd_cents bigint NOT NULL CHECK(price_usd_cents BETWEEN 0 AND 9007199254740991),
 sold_at timestamptz NOT NULL, sale_format text NOT NULL, PRIMARY KEY(query_id,sale_event_id)
);
CREATE TABLE plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, policy_version text NOT NULL,
 price_usd_cents bigint NOT NULL CHECK(price_usd_cents>=0), monthly_credits int NOT NULL CHECK(monthly_credits>=0),
 rate_limit_per_min int NOT NULL CHECK(rate_limit_per_min>0), features jsonb NOT NULL, UNIQUE(code,policy_version)
);
CREATE TABLE subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, plan_id uuid NOT NULL REFERENCES plans,
 provider text NOT NULL, provider_subscription_id text NOT NULL, status text NOT NULL,
 current_period_start timestamptz NOT NULL, current_period_end timestamptz NOT NULL,
 cancel_at_period_end boolean NOT NULL DEFAULT false, last_provider_event_at timestamptz, version int NOT NULL DEFAULT 1,
 UNIQUE(provider,provider_subscription_id), CHECK(current_period_end>current_period_start)
);
CREATE TABLE payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 provider text NOT NULL, provider_payment_id text NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>=0),
 refunded_cents bigint NOT NULL DEFAULT 0 CHECK(refunded_cents>=0 AND refunded_cents<=amount_cents),
 currency char(3) NOT NULL CHECK(currency='USD'), state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,provider_payment_id), UNIQUE(id,user_id)
);
CREATE TABLE payment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, provider_event_id text NOT NULL,
 event_type text NOT NULL, payload_ref text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz, status text NOT NULL CHECK(status IN ('received','processing','applied','retryable','failed')),
 UNIQUE(provider,provider_event_id)
);
CREATE TABLE credit_wallets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 bucket_identity text NOT NULL, bucket_type text NOT NULL CHECK(bucket_type IN ('subscription','purchased','promo')),
 period_start timestamptz, period_end timestamptz, expires_at timestamptz, balance int NOT NULL CHECK(balance>=0),
 status text NOT NULL CHECK(status IN ('active','expired','frozen','revoked')), version int NOT NULL DEFAULT 1,
 UNIQUE(user_id,bucket_identity), UNIQUE(id,user_id),
 CHECK(bucket_type<>'purchased' OR expires_at IS NULL),
 CHECK(bucket_type='purchased' OR expires_at IS NOT NULL)
);
CREATE TABLE billing_charges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), query_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL,
 charged_credits int NOT NULL CHECK(charged_credits=1), policy_version text NOT NULL, result_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('charged','refunded')), created_at timestamptz NOT NULL DEFAULT now(), refunded_at timestamptz,
 FOREIGN KEY(query_id,user_id) REFERENCES queries(id,user_id), UNIQUE(id,user_id)
);
CREATE TABLE credit_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, wallet_id uuid NOT NULL,
 grant_identity text NOT NULL UNIQUE, amount int NOT NULL CHECK(amount>0), payment_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(wallet_id,user_id) REFERENCES credit_wallets(id,user_id),
 FOREIGN KEY(payment_id,user_id) REFERENCES payments(id,user_id), UNIQUE(id,user_id), UNIQUE(id,wallet_id,user_id)
);
CREATE TABLE credit_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet_id uuid NOT NULL, user_id uuid NOT NULL,
 delta int NOT NULL CHECK(delta<>0), balance_after int NOT NULL CHECK(balance_after>=0),
 kind text NOT NULL CHECK(kind IN ('grant','consume','refund','expire','adjust')),
 charge_id uuid, grant_id uuid, refund_of uuid,
 ref_type text NOT NULL, ref_id text NOT NULL, idempotency_key text NOT NULL UNIQUE,
 actor_id uuid REFERENCES users, reason text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(wallet_id,user_id) REFERENCES credit_wallets(id,user_id),
 FOREIGN KEY(charge_id,user_id) REFERENCES billing_charges(id,user_id),
 FOREIGN KEY(grant_id,wallet_id,user_id) REFERENCES credit_grants(id,wallet_id,user_id),
 UNIQUE(id,user_id,charge_id),
 FOREIGN KEY(refund_of,user_id,charge_id) REFERENCES credit_ledger(id,user_id,charge_id),
 CHECK(kind<>'consume' OR (delta=-1 AND charge_id IS NOT NULL)),
 CHECK(kind<>'refund' OR (delta=1 AND charge_id IS NOT NULL AND refund_of IS NOT NULL)),
 CHECK(kind<>'grant' OR (delta>0 AND grant_id IS NOT NULL)),
 CHECK(kind<>'expire' OR delta<0)
);
CREATE UNIQUE INDEX one_consumption ON credit_ledger(charge_id) WHERE kind='consume';
CREATE UNIQUE INDEX one_refund ON credit_ledger(charge_id) WHERE kind='refund';
CREATE INDEX ledger_history ON credit_ledger(user_id,created_at DESC,id);
CREATE TABLE credit_recoveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL, user_id uuid NOT NULL,
 credits int NOT NULL CHECK(credits>0), status text NOT NULL CHECK(status IN ('open','waived','resolved')),
 reason text NOT NULL, resolution_ref text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(payment_id,user_id) REFERENCES payments(id,user_id), UNIQUE(payment_id)
);
CREATE TABLE shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), query_id uuid NOT NULL, user_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, field_scope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 FOREIGN KEY(query_id,user_id) REFERENCES queries(id,user_id), CHECK(expires_at>created_at)
);
CREATE TABLE category_pages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, filters jsonb NOT NULL,
 query_id uuid REFERENCES queries, source_scope jsonb NOT NULL, content text NOT NULL,
 quality_status text NOT NULL, refreshed_at timestamptz, indexable boolean NOT NULL DEFAULT false
);
CREATE TABLE anonymous_quota (
 rotating_identity text NOT NULL, day date NOT NULL, used_count int NOT NULL DEFAULT 0 CHECK(used_count BETWEEN 0 AND 5),
 PRIMARY KEY(rotating_identity,day)
);
CREATE TABLE source_daily_budget (
 source_id uuid NOT NULL REFERENCES sources, day date NOT NULL, budget_kind text NOT NULL CHECK(budget_kind IN ('jobs','pages','bytes')),
 cap bigint NOT NULL CHECK(cap>=0), reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),
 used bigint NOT NULL DEFAULT 0 CHECK(used>=0), PRIMARY KEY(source_id,day,budget_kind), CHECK(reserved+used<=cap)
);
CREATE TABLE outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text NOT NULL UNIQUE, kind text NOT NULL,
 payload jsonb NOT NULL, attempts int NOT NULL DEFAULT 0, available_at timestamptz NOT NULL,
 processed_at timestamptz, dead_letter_reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inbox (
 consumer text NOT NULL, event_key text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer,event_key)
);
CREATE TABLE idempotency_records (
 owner_scope text NOT NULL, operation text NOT NULL, key_hash text NOT NULL, request_hash text NOT NULL,
 resource_id uuid, status text NOT NULL CHECK(status IN ('running','committed')), expires_at timestamptz NOT NULL,
 PRIMARY KEY(owner_scope,operation,key_hash)
);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES users, action text NOT NULL,
 object_type text NOT NULL, object_id text NOT NULL, reason text, request_id text NOT NULL,
 safe_diff jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deletion_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users, source_id uuid REFERENCES sources,
 state text NOT NULL CHECK(state IN ('requested','running','completed','failed')),
 scope jsonb NOT NULL, checkpoint jsonb, receipt_hash text UNIQUE, receipt_expires_at timestamptz,
 requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK((user_id IS NULL)<>(source_id IS NULL))
);
CREATE TABLE tombstones (
 subject_type text NOT NULL, subject_hash text NOT NULL, scope jsonb NOT NULL, effective_at timestamptz NOT NULL,
 PRIMARY KEY(subject_type,subject_hash)
);
CREATE TABLE support_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users, category text NOT NULL,
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 4000), request_ref text,
 status text NOT NULL DEFAULT 'received', retention_until timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable audit/ledger record' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE FUNCTION check_wallet_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; stored_balance int; ledger_balance bigint;
BEGIN
 IF TG_TABLE_NAME='credit_wallets' THEN target := NEW.id; ELSE target := NEW.wallet_id; END IF;
 SELECT balance INTO stored_balance FROM credit_wallets WHERE id=target FOR UPDATE;
 SELECT coalesce(sum(delta),0) INTO ledger_balance FROM credit_ledger WHERE wallet_id=target;
 IF stored_balance IS DISTINCT FROM ledger_balance THEN
   RAISE EXCEPTION 'wallet/ledger mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER wallet_ledger_consistency AFTER INSERT OR UPDATE ON credit_wallets
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_balance();
CREATE CONSTRAINT TRIGGER ledger_wallet_consistency AFTER INSERT ON credit_ledger
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_balance();
CREATE FUNCTION check_refund_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='refund' AND NOT EXISTS (
  SELECT 1 FROM credit_ledger WHERE id=NEW.refund_of AND kind='consume'
   AND user_id=NEW.user_id AND charge_id=NEW.charge_id
 ) THEN RAISE EXCEPTION 'refund must reverse the original consumption' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER refund_reference BEFORE INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION check_refund_reference();
CREATE INDEX jobs_dispatch ON query_jobs(status,available_at);
CREATE INDEX outbox_dispatch ON outbox(available_at) WHERE processed_at IS NULL;
CREATE INDEX clearances_expiry ON source_clearances(status,expires_at);
COMMIT;
