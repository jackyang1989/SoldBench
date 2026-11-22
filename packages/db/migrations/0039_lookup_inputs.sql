CREATE TABLE lookup_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 input_kind text NOT NULL CHECK (input_kind IN ('image','barcode')),
 status text NOT NULL CHECK (status IN ('candidates_ready','fallback_text_required','confirmed','recognition_failed','expired','deleted')),
 barcode_value text,
 barcode_format text CHECK (barcode_format IN ('upc_a','ean_13','ean_8','gtin_14','isbn_13')),
 detected_mime_type text,
 image_sha256 text,
 image_width int CHECK (image_width BETWEEN 1 AND 5000),
 image_height int CHECK (image_height BETWEEN 1 AND 5000),
 image_bytes int CHECK (image_bytes BETWEEN 1 AND 5242880),
 original_had_exif boolean NOT NULL DEFAULT false,
 exif_stripped boolean NOT NULL DEFAULT false,
 storage_key text,
 confidence_threshold numeric(4,3) NOT NULL DEFAULT 0.700 CHECK (confidence_threshold BETWEEN 0 AND 1),
 top_confidence numeric(4,3) CHECK (top_confidence BETWEEN 0 AND 1),
 ambiguity_reason text,
 fallback_to_text boolean NOT NULL DEFAULT false,
 failure_code text,
 identification_credits_charged int NOT NULL DEFAULT 0 CHECK (identification_credits_charged = 0),
 confirmed_candidate_id uuid,
 confirmed_query_id uuid REFERENCES queries,
 confirmed_query_params jsonb,
 confirm_idempotency_key text,
 confirm_request_hash text,
 confirmed_at timestamptz,
 retention_expires_at timestamptz NOT NULL,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id, user_id),
 UNIQUE(user_id, id, confirm_idempotency_key)
);
CREATE INDEX lookup_sessions_owner ON lookup_sessions(user_id, created_at DESC, id);
CREATE INDEX lookup_sessions_retention ON lookup_sessions(retention_expires_at) WHERE storage_key IS NOT NULL;
CREATE TABLE lookup_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users,
 rank int NOT NULL CHECK (rank BETWEEN 1 AND 10),
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
 suggested_q text NOT NULL CHECK (length(suggested_q) BETWEEN 1 AND 120),
 category text,
 brand text,
 model text,
 variant text,
 suggested_condition text,
 confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
 requires_confirmation boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(session_id, rank),
 UNIQUE(id, session_id, user_id),
 FOREIGN KEY(session_id, user_id) REFERENCES lookup_sessions(id, user_id) ON DELETE CASCADE
);
ALTER TABLE lookup_sessions
 ADD CONSTRAINT lookup_sessions_confirmed_candidate_fk
 FOREIGN KEY(confirmed_candidate_id, id, user_id)
 REFERENCES lookup_candidates(id, session_id, user_id);
COMMENT ON TABLE lookup_sessions IS 'Image upload and barcode identification lookup sessions enforcing EXIF stripping, retention expiry, and explicit confirmation before paid sold queries.';
COMMENT ON TABLE lookup_candidates IS 'Ranked candidate interpretations produced during image or barcode recognition prior to user confirmation.';
