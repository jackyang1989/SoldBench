ALTER TABLE collector_runs ADD COLUMN fixture_artifact_hash text
 CHECK(fixture_artifact_hash IS NULL OR fixture_artifact_hash ~ '^[a-f0-9]{64}$');
COMMENT ON COLUMN collector_runs.fixture_artifact_hash IS
 'Immutable synthetic response artifact identity for offline process replay. Not a source permission or online verification.';

ALTER TABLE collector_dispatches
 ADD COLUMN fixture_key_hash text CHECK(fixture_key_hash IS NULL OR fixture_key_hash ~ '^[a-f0-9]{64}$'),
 ADD COLUMN fixture_response_index int NOT NULL DEFAULT 0 CHECK(fixture_response_index>=0);
ALTER TABLE collector_dispatches ADD COLUMN dispatched_at timestamptz;
CREATE UNIQUE INDEX collector_fixture_response_sequence ON collector_dispatches(job_id,fixture_key_hash,fixture_response_index)
 WHERE fixture_key_hash IS NOT NULL AND dispatched_at IS NOT NULL;
