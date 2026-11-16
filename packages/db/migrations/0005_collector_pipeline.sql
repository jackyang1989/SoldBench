BEGIN;
ALTER TABLE collector_runs ADD COLUMN bytes_unconfirmed bigint NOT NULL DEFAULT 0 CHECK(bytes_unconfirmed>=0);
-- Extend the existing queue; do not create a second job or circuit authority.
ALTER TABLE collector_jobs DROP CONSTRAINT collector_jobs_status_check;
ALTER TABLE collector_jobs ADD CONSTRAINT collector_jobs_status_check
 CHECK(status IN ('queued','running','retry','completed','failed','cancelled','expired'));
ALTER TABLE collector_jobs
 ADD COLUMN config_id uuid,
 ADD COLUMN run_key text,
 ADD COLUMN request_hash text,
 ADD COLUMN query_hash text,
 ADD COLUMN as_of timestamptz,
 ADD COLUMN permission_epoch bigint,
 ADD COLUMN lease_count int NOT NULL DEFAULT 0 CHECK(lease_count>=0),
 ADD COLUMN cursor text NOT NULL DEFAULT 'start',
 ADD COLUMN visited_cursors jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN page_count int NOT NULL DEFAULT 0 CHECK(page_count>=0),
 ADD COLUMN request_count int NOT NULL DEFAULT 0 CHECK(request_count>=0),
 ADD COLUMN bytes_used bigint NOT NULL DEFAULT 0 CHECK(bytes_used>=0),
 ADD COLUMN bytes_reserved bigint NOT NULL DEFAULT 0 CHECK(bytes_reserved>=0),
 ADD COLUMN min_page_as_of timestamptz,
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
 ADD CONSTRAINT collector_job_config_source FOREIGN KEY(config_id,source_id) REFERENCES collector_configs(id,source_id),
 ADD CONSTRAINT collector_job_identity_source UNIQUE(id,source_id);
CREATE UNIQUE INDEX collector_run_key_unique ON collector_jobs(source_id,run_key) WHERE run_key IS NOT NULL;
DROP INDEX collector_active_dedupe;
CREATE UNIQUE INDEX collector_active_dedupe ON collector_jobs(dedupe_key) WHERE status IN ('queued','running','retry');
CREATE INDEX collector_jobs_ready ON collector_jobs(source_id,status,available_at);
CREATE TABLE collector_rate_windows (
 source_id uuid NOT NULL REFERENCES sources, minute timestamptz NOT NULL,
 used int NOT NULL CHECK(used>=0), PRIMARY KEY(source_id,minute)
);
CREATE TABLE collector_dispatches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, source_id uuid NOT NULL,
 lease_owner text NOT NULL, kind text NOT NULL CHECK(kind IN ('page','image')),
 budget_day date NOT NULL, max_bytes bigint NOT NULL CHECK(max_bytes>0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','abandoned')),
 response_hash text, committed_observation_id uuid REFERENCES source_observations,
 actual_bytes bigint CHECK(actual_bytes>=0 AND actual_bytes<=max_bytes),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(job_id,source_id) REFERENCES collector_jobs(id,source_id),
 FOREIGN KEY(committed_observation_id,source_id) REFERENCES source_observations(id,source_id)
);
CREATE TABLE collector_pages (
 job_id uuid NOT NULL, source_id uuid NOT NULL, observation_id uuid NOT NULL,
 cursor text NOT NULL, next_cursor text, raw_hash text NOT NULL,
 payload jsonb NOT NULL, page_as_of timestamptz NOT NULL,
 PRIMARY KEY(job_id,cursor), UNIQUE(job_id,raw_hash),
 FOREIGN KEY(job_id,source_id) REFERENCES collector_jobs(id,source_id),
 FOREIGN KEY(observation_id,source_id) REFERENCES source_observations(id,source_id)
);
CREATE TABLE sale_event_evidence (
 sale_event_id uuid NOT NULL REFERENCES sale_events, listing_id uuid NOT NULL,
 source_id uuid NOT NULL, observation_id uuid NOT NULL, facts_hash text NOT NULL,
 candidate jsonb NOT NULL, external_listing_id text NOT NULL,
 PRIMARY KEY(sale_event_id,listing_id,source_id,observation_id),
 FOREIGN KEY(listing_id,source_id) REFERENCES sold_listings(id,source_id),
 FOREIGN KEY(observation_id,source_id) REFERENCES source_observations(id,source_id)
);
-- Every existing image keeps its original valid evidence link on upgrade.
INSERT INTO sale_event_evidence(sale_event_id,listing_id,source_id,observation_id,facts_hash,candidate,external_listing_id)
 SELECT e.id,e.listing_id,e.source_id,e.observation_id,'legacy-not-reconstructed','{}',l.external_listing_id
 FROM sale_events e JOIN sold_listings l ON l.id=e.listing_id;
-- Evidence must reference the same event/listing/source, not just a valid UUID.
ALTER TABLE sale_events ADD CONSTRAINT event_listing_source_unique UNIQUE(id,listing_id,source_id);
ALTER TABLE sale_event_evidence ADD CONSTRAINT event_evidence_identity
 FOREIGN KEY(sale_event_id,listing_id,source_id) REFERENCES sale_events(id,listing_id,source_id);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='listing_images'::regclass AND confrelid='sale_events'::regclass LOOP
  EXECUTE format('ALTER TABLE listing_images DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE listing_images DROP CONSTRAINT listing_images_listing_id_observation_id_role_key;
ALTER TABLE listing_images ADD CONSTRAINT image_event_observation_primary_unique UNIQUE(sale_event_id,listing_id,observation_id,role);
ALTER TABLE listing_images ADD CONSTRAINT image_observed_event_evidence
 FOREIGN KEY(sale_event_id,listing_id,source_id,observation_id)
 REFERENCES sale_event_evidence(sale_event_id,listing_id,source_id,observation_id);
CREATE TABLE collector_watermarks (
 source_id uuid NOT NULL REFERENCES sources, query_hash text NOT NULL,
 run_id uuid NOT NULL REFERENCES collector_runs, data_as_of timestamptz NOT NULL,
 PRIMARY KEY(source_id,query_hash)
);
COMMENT ON COLUMN collector_pages.payload IS 'Synthetic offline evidence only. Never store production raw data here without a separately reviewed retention and permission contract.';
COMMIT;
