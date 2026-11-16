ALTER TABLE collector_dispatches ADD CONSTRAINT collector_dispatch_identity UNIQUE(id,job_id,source_id);
ALTER TABLE collector_jobs ADD CONSTRAINT collector_job_run_identity UNIQUE(id,source_id,collector_run_id);
ALTER TABLE sale_events ADD CONSTRAINT collector_event_source_identity UNIQUE(id,source_id);
CREATE TABLE collector_quarantines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL REFERENCES sources,
 job_id uuid NOT NULL, collector_run_id uuid NOT NULL,
 dispatch_id uuid NOT NULL UNIQUE,
 parser_version text NOT NULL,
 cursor text NOT NULL CHECK(length(cursor) BETWEEN 1 AND 160),
 reason text NOT NULL CHECK(reason IN ('page_content_type_invalid','page_structure_invalid','pagination_loop','event_identity_conflict','page_event_conflict','page_evidence_invalid')),
 raw_hash text NOT NULL CHECK(raw_hash ~ '^[a-f0-9]{64}$'),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 0 AND 1048576),
 affected_event_id uuid,
 captured_at timestamptz NOT NULL,
 FOREIGN KEY(dispatch_id,job_id,source_id) REFERENCES collector_dispatches(id,job_id,source_id),
 FOREIGN KEY(job_id,source_id,collector_run_id) REFERENCES collector_jobs(id,source_id,collector_run_id),
 FOREIGN KEY(affected_event_id,source_id) REFERENCES sale_events(id,source_id),
 CHECK((reason='event_identity_conflict')=(affected_event_id IS NOT NULL))
);
CREATE INDEX collector_quarantine_event ON collector_quarantines(affected_event_id) WHERE affected_event_id IS NOT NULL;
COMMENT ON TABLE collector_quarantines IS 'Immutable bounded offline incident metadata; no raw page, URL, credentials or automatic recovery. Not source approval.';
