CREATE TABLE site_content_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK (kind IN ('announcement','faq','guide')),
 slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=70),
 version integer NOT NULL DEFAULT 0 CHECK (version>=0),
 latest_revision integer,
 published_revision integer,
 published_at timestamptz,
 updated_at timestamptz NOT NULL,
 UNIQUE (kind,slug),
 CHECK ((published_revision IS NULL)=(published_at IS NULL))
);

CREATE TABLE site_content_revisions (
 entry_id uuid NOT NULL REFERENCES site_content_entries,
 revision integer NOT NULL CHECK (revision>0),
 body jsonb NOT NULL CHECK (jsonb_typeof(body)='object' AND body ?& ARRAY['en','zh-CN']),
 state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','approved')),
 author_id uuid REFERENCES users ON DELETE SET NULL,
 reviewer_id uuid REFERENCES users ON DELETE SET NULL,
 first_published_at timestamptz,
 created_at timestamptz NOT NULL,
 PRIMARY KEY (entry_id,revision),
 CHECK (reviewer_id IS NULL OR reviewer_id<>author_id)
);

ALTER TABLE site_content_entries ADD FOREIGN KEY (id,latest_revision) REFERENCES site_content_revisions(entry_id,revision);
ALTER TABLE site_content_entries ADD FOREIGN KEY (id,published_revision) REFERENCES site_content_revisions(entry_id,revision);

CREATE FUNCTION protect_site_content_revision_body() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.body IS DISTINCT FROM OLD.body OR NEW.entry_id<>OLD.entry_id OR NEW.revision<>OLD.revision THEN
  RAISE EXCEPTION 'site content revisions are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER protect_site_content_revision_body BEFORE UPDATE ON site_content_revisions
 FOR EACH ROW EXECUTE FUNCTION protect_site_content_revision_body();
