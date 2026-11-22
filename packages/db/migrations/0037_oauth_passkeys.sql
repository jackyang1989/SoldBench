CREATE TABLE oauth_clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id text NOT NULL UNIQUE CHECK(length(client_id) BETWEEN 8 AND 128),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 client_type text NOT NULL CHECK(client_type IN ('public','confidential')),
 client_secret_hash text,
 redirect_uris jsonb NOT NULL CHECK(jsonb_typeof(redirect_uris)='array' AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 10),
 allowed_scopes text[] NOT NULL CHECK(cardinality(allowed_scopes)>=1 AND allowed_scopes<@ARRAY['sold:read','jobs:read','usage:read']),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((client_type='public' AND client_secret_hash IS NULL) OR (client_type='confidential' AND client_secret_hash IS NOT NULL))
);
CREATE TABLE oauth_authorization_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code_hash text NOT NULL UNIQUE,
 client_id text NOT NULL REFERENCES oauth_clients(client_id),
 user_id uuid NOT NULL REFERENCES users,
 redirect_uri text NOT NULL,
 scopes text[] NOT NULL CHECK(cardinality(scopes)>=1 AND scopes<@ARRAY['sold:read','jobs:read','usage:read']),
 code_challenge text NOT NULL CHECK(length(code_challenge) BETWEEN 43 AND 128),
 code_challenge_method text NOT NULL CHECK(code_challenge_method='S256'),
 resource text NOT NULL,
 state_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at>created_at)
);
CREATE TABLE oauth_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 client_id text NOT NULL REFERENCES oauth_clients(client_id),
 scopes text[] NOT NULL CHECK(cardinality(scopes)>=1 AND scopes<@ARRAY['sold:read','jobs:read','usage:read']),
 resource text NOT NULL,
 status text NOT NULL CHECK(status IN ('active','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 UNIQUE(user_id,client_id)
);
CREATE TABLE oauth_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 grant_id uuid NOT NULL REFERENCES oauth_grants,
 user_id uuid NOT NULL REFERENCES users,
 client_id text NOT NULL REFERENCES oauth_clients(client_id),
 token_family_id uuid NOT NULL,
 access_token_hash text NOT NULL UNIQUE,
 refresh_token_hash text UNIQUE,
 scopes text[] NOT NULL CHECK(cardinality(scopes)>=1 AND scopes<@ARRAY['sold:read','jobs:read','usage:read']),
 resource text NOT NULL,
 access_expires_at timestamptz NOT NULL,
 refresh_expires_at timestamptz NOT NULL,
 rotated_at timestamptz,
 revoked_at timestamptz,
 last_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(access_expires_at>created_at AND refresh_expires_at>=access_expires_at)
);
CREATE INDEX oauth_tokens_user_active ON oauth_tokens(user_id,client_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_tokens_family ON oauth_tokens(token_family_id);
CREATE TABLE user_passkeys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 credential_id text NOT NULL UNIQUE CHECK(length(credential_id) BETWEEN 8 AND 512),
 public_key_spki_pem text NOT NULL,
 algorithm text NOT NULL CHECK(algorithm IN ('ES256','Ed25519')),
 sign_count bigint NOT NULL DEFAULT 0 CHECK(sign_count>=0),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 transports text[] NOT NULL DEFAULT ARRAY[]::text[],
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX user_passkeys_owner ON user_passkeys(user_id,created_at DESC) WHERE revoked_at IS NULL;
CREATE TABLE passkey_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 challenge_hash text NOT NULL UNIQUE,
 purpose text NOT NULL CHECK(purpose IN ('register','login')),
 user_id uuid REFERENCES users,
 rp_id text NOT NULL,
 origin text NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at>created_at)
);
COMMENT ON TABLE oauth_tokens IS 'Hashed short-lived OAuth 2.1 access tokens and rotating refresh token families isolated by client_id.';
COMMENT ON TABLE user_passkeys IS 'WebAuthn public-key passkeys; never override source rights or downgrade MFA.';
