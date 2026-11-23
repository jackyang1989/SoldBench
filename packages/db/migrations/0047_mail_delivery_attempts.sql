CREATE TABLE auth_mail_delivery_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mail_id uuid NOT NULL REFERENCES auth_mail_outbox(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('resend','smtp')),
 status text NOT NULL CHECK(status IN ('sent','retryable','failed')),
 attempt_number int NOT NULL CHECK(attempt_number>0),
 provider_message_id text,
 error_code text,
 next_retry_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(mail_id,attempt_number),
 CHECK(status<>'sent' OR provider_message_id IS NOT NULL),
 CHECK(status<>'retryable' OR next_retry_at IS NOT NULL)
);

CREATE INDEX auth_mail_delivery_attempts_mail_idx
 ON auth_mail_delivery_attempts(mail_id,created_at DESC);
