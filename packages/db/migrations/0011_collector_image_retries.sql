CREATE TABLE collector_image_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 image_id uuid NOT NULL UNIQUE REFERENCES listing_images,
 source_id uuid NOT NULL REFERENCES sources,
 parent_job_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('retry','running','completed','failed','expired')),
 attempts int NOT NULL CHECK(attempts BETWEEN 1 AND 3),
 available_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 lease_owner text, lease_until timestamptz,
 failure_reason text, created_at timestamptz NOT NULL, finished_at timestamptz,
 FOREIGN KEY(parent_job_id,source_id) REFERENCES collector_jobs(id,source_id),
 FOREIGN KEY(image_id,source_id) REFERENCES listing_images(id,source_id),
 CHECK(expires_at>created_at),
 CHECK((status='running')=(lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX collector_image_jobs_ready ON collector_image_jobs(source_id,status,available_at);
CREATE UNIQUE INDEX collector_image_parent_lease ON collector_image_jobs(parent_job_id) WHERE status='running';
COMMENT ON TABLE collector_image_jobs IS 'Bounded offline primary-image recovery. Does not authorize a source or reopen completed page jobs.';
