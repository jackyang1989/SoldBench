ALTER TABLE sources ADD COLUMN retry_after_until timestamptz;
ALTER TABLE collector_dispatches ADD COLUMN image_id uuid REFERENCES listing_images;
ALTER TABLE collector_image_jobs DROP CONSTRAINT collector_image_jobs_attempts_check;
ALTER TABLE collector_image_jobs ADD CONSTRAINT collector_image_jobs_attempts_check CHECK(attempts BETWEEN 0 AND 3);
COMMENT ON COLUMN sources.retry_after_until IS 'Shared source cooldown after Retry-After; never changes accounts or source permissions.';
