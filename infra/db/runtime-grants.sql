BEGIN;
SELECT pg_advisory_xact_lock(hashtext('soldbench:migrations'));

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, soldbench_runtime, soldbench_collector, soldbench_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, soldbench_runtime, soldbench_collector, soldbench_backup;
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The API and query worker run the same auth/query/finance/operations domain
-- services. Application authorisation remains responsible for owner isolation.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO soldbench_runtime, soldbench_backup;
GRANT INSERT ON
  alert_events, anonymous_cache_deliveries, anonymous_cache_publications, anonymous_quota,
  anonymous_rate_windows, api_keys, auction_lot_records, auction_sessions, audit_events,
  auth_mail_delivery_attempts, auth_mail_outbox, auth_rate_windows, auth_tokens, batch_queries,
  batch_query_items, best_offer_verifications, billing_charges, card_grading_populations,
  card_sale_records, collector_circuits, credit_grants, credit_ledger, credit_recoveries,
  credit_wallets, deletion_requests, idempotency_records, inventory_valuation_items,
  inventory_valuations, lookup_candidates, lookup_sessions, oauth_authorization_codes,
  oauth_clients, oauth_grants, oauth_tokens, operator_account_approvals, operator_account_notes,
  operator_incidents, operator_alert_settings, outbox, passkey_challenges, payment_checkout_intents,
  payment_events, payment_fixture_facts, payments, plans, promo_redemptions, queries,
  query_calculation_inputs, query_comparables, query_evidence_revisions, query_jobs,
  query_request_audit, query_result_items, query_result_sources, query_results, query_snapshot_records,
  saved_research, second_marketplace_records, sessions, shares, site_content_entries,
  site_content_revisions, site_content_schedules, subscriptions, support_requests, tombstones,
  user_mfa, user_passkeys, users, watchlists, webhook_deliveries, webhook_endpoints, worker_heartbeats
  TO soldbench_runtime;
GRANT UPDATE ON
  anonymous_quota, anonymous_rate_windows, api_keys, auth_mail_outbox, auth_rate_windows, auth_tokens,
  batch_queries, best_offer_verifications, billing_charges, category_pages, collector_detail_jobs,
  collector_image_jobs, collector_jobs, credit_recoveries, credit_wallets, deletion_requests,
  inventory_valuations, listing_images, lookup_sessions, oauth_authorization_codes, oauth_clients,
  oauth_grants, oauth_tokens, operator_account_approvals, operator_alert_settings, operator_incidents,
  outbox, passkey_challenges, payment_checkout_intents, payment_events, payments, promo_campaigns,
  queries, query_jobs, query_request_audit, query_snapshot_records, saved_research,
  second_marketplace_records, sessions, shares, site_content_entries, site_content_revisions,
  site_content_schedules, sources, subscriptions, support_requests, user_mfa, user_passkeys,
  users, watchlists, webhook_deliveries, webhook_endpoints, worker_heartbeats
  TO soldbench_runtime;
GRANT DELETE ON
  admin_mfa, admin_roles, anonymous_cache_deliveries, anonymous_cache_publications, anonymous_quota,
  anonymous_rate_windows, api_keys, auth_mail_outbox, auth_rate_windows, auth_tokens,
  idempotency_records, operator_account_notes, query_calculation_inputs, query_comparables,
  query_request_audit, query_result_items, query_result_sources, query_results, query_snapshot_records,
  saved_research, sessions, shares, support_requests, user_mfa, watchlists, webhook_endpoints
  TO soldbench_runtime;

-- A row-locking read requires UPDATE on at least one column in PostgreSQL.
GRANT UPDATE (id) ON source_clearances TO soldbench_runtime, soldbench_collector;
GRANT UPDATE (day) ON anonymous_cache_deliveries TO soldbench_runtime;
GRANT UPDATE (expires_at) ON idempotency_records TO soldbench_runtime;

GRANT SELECT ON
  archive_coverage_spans, collector_circuits, collector_configs, collector_daily_budget_policies,
  collector_detail_jobs, collector_dispatches, collector_health_snapshots, collector_image_jobs,
  collector_jobs, collector_pages, collector_quarantines, collector_rate_windows,
  collector_refresh_occurrences, collector_refresh_plans, collector_runs, collector_supervisor_state,
  collector_watermarks, listing_images, listing_record_evidence, outbox, sale_event_evidence,
  sale_events, sold_listings, soldbench_migrations, source_clearances, source_daily_budget,
  source_observations, sources TO soldbench_collector;
GRANT INSERT ON
  archive_coverage_spans, collector_circuits, collector_detail_jobs, collector_dispatches,
  collector_health_snapshots, collector_image_jobs, collector_jobs, collector_pages,
  collector_quarantines, collector_rate_windows, collector_refresh_occurrences, collector_runs,
  collector_supervisor_state, collector_watermarks, listing_images, listing_record_evidence,
  outbox, sale_event_evidence, sale_events, sold_listings, source_daily_budget, source_observations
  TO soldbench_collector;
GRANT UPDATE ON
  collector_circuits, collector_detail_jobs, collector_dispatches, collector_image_jobs, collector_jobs,
  collector_rate_windows, collector_refresh_occurrences, collector_runs, collector_supervisor_state,
  collector_watermarks, listing_images, listing_record_evidence, sold_listings, source_daily_budget,
  source_observations, sources TO soldbench_collector;
GRANT UPDATE (id) ON collector_configs, collector_refresh_plans TO soldbench_collector;
GRANT UPDATE (source_id) ON collector_daily_budget_policies TO soldbench_collector;
GRANT UPDATE (processed_at) ON outbox TO soldbench_collector;

-- The shared Outbox contains user and billing events as well as collector
-- events. The Collector must only read/acknowledge its own kinds.
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS soldbench_runtime_outbox ON outbox;
DROP POLICY IF EXISTS soldbench_collector_outbox ON outbox;
DROP POLICY IF EXISTS soldbench_backup_outbox ON outbox;
CREATE POLICY soldbench_runtime_outbox ON outbox TO soldbench_runtime USING (true);
CREATE POLICY soldbench_collector_outbox ON outbox TO soldbench_collector
  USING (kind LIKE 'collector.%') WITH CHECK (kind LIKE 'collector.%');
CREATE POLICY soldbench_backup_outbox ON outbox FOR SELECT TO soldbench_backup USING (true);
COMMIT;
