CREATE TABLE collector_daily_budget_policies (
 source_id uuid PRIMARY KEY REFERENCES sources, policy_hash text NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
 jobs_cap bigint NOT NULL CHECK(jobs_cap>=0), pages_cap bigint NOT NULL CHECK(pages_cap>=0), bytes_cap bigint NOT NULL CHECK(bytes_cap>=0),
 approval_ref text NOT NULL, valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL, CHECK(valid_until>valid_from), UNIQUE(source_id,policy_hash)
);
ALTER TABLE sources ADD COLUMN daily_budget_policy_hash text;
ALTER TABLE sources ADD CONSTRAINT source_daily_policy_binding FOREIGN KEY(id,daily_budget_policy_hash) REFERENCES collector_daily_budget_policies(source_id,policy_hash);
CREATE FUNCTION protect_collector_daily_budget_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'frozen collector daily budget policy cannot be changed or deleted' USING ERRCODE='23514';
END $$;
CREATE TRIGGER protect_collector_daily_budget_policy BEFORE UPDATE OR DELETE ON collector_daily_budget_policies FOR EACH ROW EXECUTE FUNCTION protect_collector_daily_budget_policy();
COMMENT ON TABLE collector_daily_budget_policies IS 'Offline synthetic fixed daily caps. Not approval for real network access or measured costs.';
