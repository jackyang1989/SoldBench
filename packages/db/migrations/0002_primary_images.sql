CREATE TABLE listing_images (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 listing_id uuid NOT NULL, source_id uuid NOT NULL REFERENCES sources,
 observation_id uuid NOT NULL, sale_event_id uuid NOT NULL,
 role text NOT NULL DEFAULT 'primary' CHECK(role='primary'),
 source_url text, source_url_hash text,
 state text NOT NULL CHECK(state IN ('pending','available','missing','failed','revoked','expired')),
 object_key text, content_hash text, mime_type text, width int, height int, byte_size int,
 permission_epoch bigint NOT NULL CHECK(permission_epoch>0), retention_until timestamptz,
 failure_reason text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(listing_id,source_id) REFERENCES sold_listings(id,source_id),
 FOREIGN KEY(observation_id,source_id) REFERENCES source_observations(id,source_id),
 FOREIGN KEY(sale_event_id,listing_id,source_id,observation_id)
   REFERENCES sale_events(id,listing_id,source_id,observation_id),
 UNIQUE(listing_id,observation_id,role), UNIQUE(id,source_id),
 CHECK(state<>'available' OR (object_key IS NOT NULL AND content_hash IS NOT NULL AND mime_type='image/webp'
   AND width>0 AND height>0 AND byte_size>0 AND retention_until IS NOT NULL)),
 CHECK(source_url IS NULL OR source_url LIKE 'https://%')
);
CREATE INDEX images_source_retention ON listing_images(source_id,retention_until);
CREATE INDEX images_listing ON listing_images(listing_id,created_at DESC);
