CREATE FUNCTION protect_source_daily_budget_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.daily_budget_policy_hash IS NOT NULL AND NEW.daily_budget_policy_hash IS DISTINCT FROM OLD.daily_budget_policy_hash
 THEN RAISE EXCEPTION 'frozen source daily budget binding cannot be cleared or replaced' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_source_daily_budget_binding BEFORE UPDATE OF daily_budget_policy_hash ON sources FOR EACH ROW EXECUTE FUNCTION protect_source_daily_budget_binding();
