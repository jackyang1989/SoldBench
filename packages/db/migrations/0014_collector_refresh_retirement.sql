-- 0013 is already exercised on isolated PG16; preserve its checksum.
CREATE FUNCTION protect_collector_refresh_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL AND EXISTS(
  SELECT 1 FROM collector_refresh_occurrences WHERE plan_id=NEW.id AND scheduled_for>=NEW.retired_at
 ) THEN RAISE EXCEPTION 'refresh retirement cannot remove historical slots' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_collector_refresh_retirement BEFORE UPDATE ON collector_refresh_plans FOR EACH ROW EXECUTE FUNCTION protect_collector_refresh_retirement();
