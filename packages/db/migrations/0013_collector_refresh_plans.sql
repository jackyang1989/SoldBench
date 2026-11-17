CREATE TABLE collector_refresh_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources,
 create_key text NOT NULL, request_hash text NOT NULL,
 config_id uuid NOT NULL, query_parameters jsonb NOT NULL, query_hash text NOT NULL,
 permission_epoch bigint NOT NULL, config_hash text NOT NULL,
 collector_version text NOT NULL, parser_version text NOT NULL, profile_hash text,
 start_at timestamptz NOT NULL, interval_seconds int NOT NULL CHECK(interval_seconds BETWEEN 60 AND 86400),
 max_lag_seconds int NOT NULL CHECK(max_lag_seconds BETWEEN 1 AND 86400),
 job_ttl_seconds int NOT NULL CHECK(job_ttl_seconds BETWEEN 1 AND 86400),
 next_due_at timestamptz NOT NULL, retired_at timestamptz, created_at timestamptz NOT NULL,
 FOREIGN KEY(config_id,source_id) REFERENCES collector_configs(id,source_id),
 UNIQUE(id,source_id), UNIQUE(source_id,create_key), CHECK(retired_at IS NULL OR retired_at>=created_at)
);
CREATE UNIQUE INDEX collector_refresh_one_active ON collector_refresh_plans(source_id,query_hash) WHERE retired_at IS NULL;
CREATE TABLE collector_refresh_occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL, source_id uuid NOT NULL,
 scheduled_for timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('planned','dispatching','enqueued','blocked','missed')),
 as_of timestamptz, lease_owner text, lease_until timestamptz, attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 job_id uuid, failure_reason text, created_at timestamptz NOT NULL, finished_at timestamptz,
 FOREIGN KEY(plan_id,source_id) REFERENCES collector_refresh_plans(id,source_id),
 FOREIGN KEY(job_id,source_id) REFERENCES collector_jobs(id,source_id),
 UNIQUE(plan_id,scheduled_for), UNIQUE(job_id),
 CHECK((status='dispatching')=(lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(status<>'enqueued' OR job_id IS NOT NULL)
);
CREATE INDEX collector_refresh_due ON collector_refresh_occurrences(source_id,status,scheduled_for);
COMMENT ON TABLE collector_refresh_plans IS 'Frozen offline scheduling intent. No source license, network access or stability certification.';
CREATE FUNCTION protect_collector_refresh_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'frozen refresh plans cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['next_due_at','retired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['next_due_at','retired_at'])
 OR NEW.next_due_at<OLD.next_due_at OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
 THEN RAISE EXCEPTION 'frozen refresh plan changed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_collector_refresh_plan BEFORE UPDATE OR DELETE ON collector_refresh_plans FOR EACH ROW EXECUTE FUNCTION protect_collector_refresh_plan();
CREATE FUNCTION protect_collector_refresh_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refresh occurrences cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.plan_id,NEW.source_id,NEW.scheduled_for,NEW.deadline_at,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.plan_id,OLD.source_id,OLD.scheduled_for,OLD.deadline_at,OLD.created_at)
 OR (OLD.as_of IS NOT NULL AND NEW.as_of IS DISTINCT FROM OLD.as_of)
 OR (OLD.status IN ('enqueued','blocked','missed') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'frozen refresh occurrence changed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_collector_refresh_occurrence BEFORE UPDATE OR DELETE ON collector_refresh_occurrences FOR EACH ROW EXECUTE FUNCTION protect_collector_refresh_occurrence();
