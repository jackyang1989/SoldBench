ALTER TABLE site_content_entries DROP CONSTRAINT site_content_entries_kind_check;
ALTER TABLE site_content_entries ADD CONSTRAINT site_content_entries_kind_check CHECK (kind IN (
 'announcement','faq','guide','blog','home','navigation','footer','pricing_copy','billing_copy','offer_copy',
 'category_copy','comparison','changelog','status_copy','status_component','status_incident','about','terms','privacy'
));

ALTER TABLE site_content_revisions ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object');

CREATE OR REPLACE FUNCTION protect_site_content_revision_body() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.body IS DISTINCT FROM OLD.body OR NEW.metadata IS DISTINCT FROM OLD.metadata OR
    NEW.entry_id<>OLD.entry_id OR NEW.revision<>OLD.revision THEN
  RAISE EXCEPTION 'site content revisions are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE INDEX site_content_active_kind_idx ON site_content_entries(kind,published_at DESC,id) WHERE published_revision IS NOT NULL;
