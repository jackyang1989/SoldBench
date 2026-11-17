ALTER TABLE credit_grants ADD COLUMN grant_kind text, ADD COLUMN provider text, ADD COLUMN provider_ref text,
 ADD COLUMN policy_version text;
CREATE UNIQUE INDEX credit_grant_business_identity ON credit_grants(user_id,grant_kind,provider,provider_ref)
 WHERE grant_kind IS NOT NULL AND provider IS NOT NULL AND provider_ref IS NOT NULL;
CREATE UNIQUE INDEX credit_grant_payment_kind ON credit_grants(user_id,grant_kind,payment_id) WHERE payment_id IS NOT NULL AND grant_kind IS NOT NULL;
ALTER TABLE queries ADD COLUMN collector_job_id uuid REFERENCES collector_jobs;
ALTER TABLE query_jobs ADD COLUMN attempt_count int NOT NULL DEFAULT 0 CHECK(attempt_count>=0);
ALTER TABLE query_results ADD COLUMN supplemental_stats jsonb, ADD COLUMN diagnostics jsonb,
 ADD COLUMN query_parameters jsonb, ADD COLUMN collector_job_id uuid REFERENCES collector_jobs;
CREATE TABLE query_snapshot_records (
 query_id uuid NOT NULL REFERENCES queries,
 source_id uuid NOT NULL, sale_event_id uuid NOT NULL, listing_id uuid NOT NULL, observation_id uuid NOT NULL,
 candidate jsonb NOT NULL,
 PRIMARY KEY(query_id,sale_event_id),
 FOREIGN KEY(sale_event_id,listing_id,source_id,observation_id)
  REFERENCES sale_event_evidence(sale_event_id,listing_id,source_id,observation_id)
);
