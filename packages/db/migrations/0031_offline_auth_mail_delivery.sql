ALTER TABLE auth_mail_outbox
 DROP CONSTRAINT auth_mail_outbox_status_check,
 ADD COLUMN offline_ready_at timestamptz,
 ADD COLUMN offline_closed_at timestamptz,
 ADD CONSTRAINT auth_mail_outbox_status_check CHECK(status IN ('queued_offline','ready_offline','cancelled')),
 ADD CONSTRAINT auth_mail_outbox_ready_time CHECK(status<>'ready_offline' OR offline_ready_at IS NOT NULL);
CREATE INDEX auth_mail_outbox_pending_order ON auth_mail_outbox(created_at,id)
 WHERE status IN ('queued_offline','ready_offline');
COMMENT ON COLUMN auth_mail_outbox.offline_ready_at IS 'Local acceptance only. No external delivery or recipient confirmation.';
