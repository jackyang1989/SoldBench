ALTER TABLE users ADD COLUMN credential_version int NOT NULL DEFAULT 0 CHECK(credential_version>=0);
CREATE UNIQUE INDEX user_email_normalized ON users(lower(email)) WHERE email IS NOT NULL;
ALTER TABLE sessions ADD COLUMN csrf_hash text, ADD COLUMN credential_version int NOT NULL DEFAULT 0,
 ADD COLUMN mfa_pending boolean NOT NULL DEFAULT false;
CREATE TABLE auth_rate_windows (
 bucket_hash text NOT NULL, window_start timestamptz NOT NULL, used int NOT NULL CHECK(used>0),
 PRIMARY KEY(bucket_hash,window_start)
);
CREATE TABLE auth_mail_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 token_id uuid NOT NULL REFERENCES auth_tokens,
 purpose text NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
 locale text NOT NULL CHECK(locale IN ('en','zh-CN')), translation_revision text NOT NULL,
 encrypted_payload bytea NOT NULL, status text NOT NULL DEFAULT 'queued_offline' CHECK(status IN ('queued_offline','cancelled')),
 created_at timestamptz NOT NULL, UNIQUE(token_id)
);
CREATE TABLE user_mfa (
 user_id uuid PRIMARY KEY REFERENCES users, encrypted_secret bytea NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','enabled')), pending_expires_at timestamptz,
 enabled_at timestamptz, last_used_step bigint, recovery_code_hashes text[] NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL
);
CREATE INDEX auth_tokens_lookup ON auth_tokens(user_id,purpose,created_at DESC);
