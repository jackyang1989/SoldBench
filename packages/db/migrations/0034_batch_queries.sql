CREATE TABLE batch_queries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 status text NOT NULL CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
 total_items integer NOT NULL CHECK (total_items BETWEEN 1 AND 20),
 unique_query_count integer NOT NULL CHECK (unique_query_count BETWEEN 1 AND 20),
 estimated_max_credits integer NOT NULL CHECK (estimated_max_credits BETWEEN 0 AND 20),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 completed_at timestamptz,
 cancelled_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE batch_query_items (
 batch_id uuid NOT NULL REFERENCES batch_queries(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 item_index integer NOT NULL CHECK (item_index BETWEEN 0 AND 19),
 input_query jsonb NOT NULL,
 canonical_query_hash text,
 deduplicated_in_batch boolean NOT NULL DEFAULT false,
 primary_item_index integer CHECK (primary_item_index IS NULL OR primary_item_index BETWEEN 0 AND 19),
 query_id uuid,
 job_id uuid REFERENCES query_jobs(id) ON DELETE SET NULL,
 submit_status text NOT NULL CHECK (submit_status IN ('submitted','reused','failed')),
 error_code text,
 error_message text,
 created_at timestamptz NOT NULL,
 PRIMARY KEY (batch_id, item_index),
 FOREIGN KEY (query_id, user_id) REFERENCES queries(id, user_id) ON DELETE SET NULL (query_id)
);

CREATE INDEX batch_queries_owner_created ON batch_queries(user_id, created_at DESC, id);
CREATE UNIQUE INDEX batch_queries_owner_active ON batch_queries(user_id) WHERE status IN ('queued','running');
CREATE INDEX batch_query_items_query ON batch_query_items(query_id) WHERE query_id IS NOT NULL;
