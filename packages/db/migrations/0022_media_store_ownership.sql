ALTER TABLE sources ADD COLUMN media_store_identity text
 CHECK (media_store_identity IS NULL OR media_store_identity ~ '^[0-9a-f]{64}$');

CREATE INDEX collector_media_cleanup_pending_by_source ON outbox ((payload->>'sourceId'))
 WHERE kind='collector.media_cleanup' AND processed_at IS NULL;
CREATE INDEX collector_media_dispatch_history ON collector_dispatches(source_id) WHERE kind='image';

CREATE FUNCTION protect_source_media_store_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.media_store_identity IS NOT NULL
   AND NEW.media_store_identity IS DISTINCT FROM OLD.media_store_identity
 THEN
  RAISE EXCEPTION 'source media store binding cannot be cleared or replaced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER protect_source_media_store_identity
 BEFORE UPDATE OF media_store_identity ON sources
 FOR EACH ROW EXECUTE FUNCTION protect_source_media_store_identity();
