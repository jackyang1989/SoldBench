CREATE TABLE collector_detail_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL REFERENCES sources,
 parent_job_id uuid NOT NULL,
 observation_id uuid NOT NULL,
 listing_id uuid NOT NULL,
 sale_event_id uuid NOT NULL,
 external_listing_id text NOT NULL CHECK(external_listing_id ~ '^[0-9]{6,19}$'),
 status text NOT NULL CHECK(status IN ('queued','running','retry','completed','failed','expired')),
 attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 available_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 lease_owner text,
 lease_until timestamptz,
 failure_reason text,
 enriched_fields jsonb,
 created_at timestamptz NOT NULL,
 finished_at timestamptz,
 UNIQUE(source_id,observation_id,listing_id,sale_event_id),
 FOREIGN KEY(parent_job_id,source_id) REFERENCES collector_jobs(id,source_id),
 FOREIGN KEY(sale_event_id,listing_id,source_id,observation_id) REFERENCES sale_event_evidence(sale_event_id,listing_id,source_id,observation_id),
 FOREIGN KEY(sale_event_id,observation_id) REFERENCES listing_record_evidence(sale_event_id,observation_id),
 CHECK(expires_at>created_at),
 CHECK((status='running')=(lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX collector_detail_jobs_ready ON collector_detail_jobs(source_id,status,available_at);
CREATE UNIQUE INDEX collector_detail_parent_lease ON collector_detail_jobs(parent_job_id) WHERE status='running';
ALTER TABLE collector_dispatches DROP CONSTRAINT IF EXISTS collector_dispatches_kind_check;
ALTER TABLE collector_dispatches
 ADD COLUMN detail_task_id uuid REFERENCES collector_detail_jobs,
 ADD CONSTRAINT collector_dispatches_kind_check CHECK(kind IN ('page','image','detail'));
ALTER TABLE collector_supervisor_state DROP CONSTRAINT IF EXISTS collector_supervisor_state_lane_check;
ALTER TABLE collector_supervisor_state
 ADD CONSTRAINT collector_supervisor_state_lane_check CHECK(lane IN ('pages','images','details'));
COMMENT ON TABLE collector_detail_jobs IS 'Persistent offline/bounded item-detail enrichment queue bound to existing observations. Never grants source access.';
