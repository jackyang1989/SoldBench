CREATE TABLE saved_research (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 query_id uuid NOT NULL,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 name_key text NOT NULL CHECK (length(name_key) BETWEEN 1 AND 240),
 excluded_sale_event_ids uuid[] NOT NULL DEFAULT '{}' CHECK (
  cardinality(excluded_sale_event_ids)<=2000 AND array_position(excluded_sale_event_ids,NULL) IS NULL
 ),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 UNIQUE (user_id,name_key),
 FOREIGN KEY (query_id,user_id) REFERENCES queries(id,user_id) ON DELETE CASCADE
);
CREATE INDEX saved_research_latest ON saved_research(user_id,updated_at DESC,id);
