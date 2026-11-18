CREATE INDEX account_deletion_queue ON deletion_requests(requested_at,id)
 WHERE user_id IS NOT NULL AND state IN ('requested','running');
CREATE INDEX account_deletion_requests_owner ON deletion_requests(user_id,requested_at DESC)
 WHERE user_id IS NOT NULL;
