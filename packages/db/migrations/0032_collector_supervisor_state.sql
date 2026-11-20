CREATE TABLE collector_supervisor_state (
 source_id uuid PRIMARY KEY REFERENCES sources,
 phase text NOT NULL CHECK (phase IN ('scanning','dispatching','waiting','stopped')),
 checked_at timestamptz NOT NULL,
 expected_progress_at timestamptz,
 last_cycle_at timestamptz,
 job_id uuid,
 lane text CHECK (lane IN ('pages','images')),
 cycle_summary jsonb,
 CONSTRAINT collector_supervisor_job_scope FOREIGN KEY (job_id,source_id) REFERENCES collector_jobs(id,source_id),
 CHECK ((phase='dispatching')=(job_id IS NOT NULL)),
 CHECK ((phase='dispatching')=(lane IS NOT NULL)),
 CHECK ((phase='stopped')=(expected_progress_at IS NULL)),
 CHECK ((last_cycle_at IS NULL)=(cycle_summary IS NULL))
);
COMMENT ON TABLE collector_supervisor_state IS 'Latest offline supervisor position, updated only by its source advisory-lock session. No source payloads or file paths.';
