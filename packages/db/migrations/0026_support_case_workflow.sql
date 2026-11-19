ALTER TABLE support_requests
 ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
 ADD COLUMN receipt_hash text CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 ADD COLUMN assignee_id uuid REFERENCES users(id),
 ADD COLUMN due_at timestamptz,
 ADD COLUMN reply text CHECK(length(reply) BETWEEN 1 AND 2000),
 ADD COLUMN updated_at timestamptz;
ALTER TABLE support_requests ADD CHECK(status IN ('received','in_progress','resolved','closed'));
CREATE UNIQUE INDEX support_requests_receipt ON support_requests(receipt_hash) WHERE receipt_hash IS NOT NULL;
CREATE INDEX support_requests_queue ON support_requests(created_at DESC,id DESC);
