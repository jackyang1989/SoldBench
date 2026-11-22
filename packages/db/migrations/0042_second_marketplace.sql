ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_marketplace_check;
ALTER TABLE sources ADD CONSTRAINT sources_marketplace_check CHECK (marketplace IN ('ebay_us','ebay_uk','ebay_de','mercari_us'));

CREATE TABLE second_marketplace_catalog (
 marketplace_id text PRIMARY KEY CHECK (marketplace_id IN ('mercari_us','poshmark_us','grailed','depop')),
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
 selection_status text NOT NULL CHECK (selection_status IN ('selected_first_vertical','deferred_candidate')),
 default_currency char(3) NOT NULL CHECK (default_currency IN ('USD','GBP','EUR')),
 supports_sold boolean NOT NULL,
 supports_active boolean NOT NULL,
 sold_vs_active_policy text NOT NULL CHECK (length(sold_vs_active_policy) BETWEEN 1 AND 400),
 selection_rationale text NOT NULL CHECK (length(selection_rationale) BETWEEN 1 AND 400),
 source_gate_passed boolean NOT NULL DEFAULT false,
 media_gate_passed boolean NOT NULL DEFAULT false,
 quality_gate_passed boolean NOT NULL DEFAULT false,
 economics_gate_passed boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'preview_offline' CHECK (status IN ('preview_offline','gated','active')),
 updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO second_marketplace_catalog(
 marketplace_id,display_name,selection_status,default_currency,supports_sold,supports_active,sold_vs_active_policy,selection_rationale
) VALUES
 ('mercari_us','Mercari US','selected_first_vertical','USD',true,true,
  'Only listing_state=sold with verified_actual price enters sold_stats; active listings stay isolated in active_listings.',
  'Selected for first second-marketplace vertical closed loop: US consumer electronics/collectibles overlap, clear sold-status badge, single USD native currency, zero multi-platform scope creep.'),
 ('poshmark_us','Poshmark US','deferred_candidate','USD',true,true,
  'Requires dedicated apparel condition and bundle semantics; out of scope for first vertical package.',
  'Deferred candidate for follow-up standalone estimate after first vertical acceptance.'),
 ('grailed','Grailed','deferred_candidate','USD',true,true,
  'Requires designer authentication/category schema; out of scope for first vertical package.',
  'Deferred candidate requiring standalone rights and fashion schema scoping.'),
 ('depop','Depop','deferred_candidate','USD',false,true,
  'Active-listing-only candidate unless independent sold clearance is granted; active listings NEVER enter sold statistics.',
  'Deferred active-only candidate; explicitly forbidden from populating sold statistics without verified sold authority.');

CREATE TABLE second_marketplace_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 marketplace_id text NOT NULL REFERENCES second_marketplace_catalog(marketplace_id),
 source_id uuid NOT NULL REFERENCES sources(id),
 permission_epoch bigint NOT NULL CHECK (permission_epoch >= 1),
 listing_id text NOT NULL CHECK (length(listing_id) BETWEEN 1 AND 120),
 event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 160),
 listing_state text NOT NULL CHECK (listing_state IN ('sold','active','ended_unsold')),
 query_keyword text NOT NULL CHECK (length(query_keyword) BETWEEN 1 AND 120),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 item_minor bigint CHECK (item_minor BETWEEN 0 AND 9007199254740991),
 shipping_minor bigint CHECK (shipping_minor BETWEEN 0 AND 9007199254740991),
 shipping_status text NOT NULL CHECK (shipping_status IN ('observed','verified_free_shipping','unknown')),
 sale_price_status text NOT NULL CHECK (sale_price_status IN ('verified_actual','displayed_only','unknown')),
 condition_raw text,
 condition_std text,
 observed_at timestamptz NOT NULL,
 sold_at timestamptz,
 comparable boolean NOT NULL DEFAULT true,
 primary_image_sha256 text CHECK (primary_image_sha256 ~ '^[0-9a-f]{64}$'),
 primary_image_mime text CHECK (primary_image_mime IN ('image/webp','image/png','image/jpeg')),
 primary_image_bytes bytea CHECK (octet_length(primary_image_bytes) BETWEEN 1 AND 5242880),
 media_rights_status text NOT NULL DEFAULT 'missing' CHECK (media_rights_status IN ('authorized','missing','revoked')),
 retention_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(marketplace_id, source_id, event_key),
 CHECK (
  (primary_image_bytes IS NULL AND primary_image_sha256 IS NULL AND primary_image_mime IS NULL)
  OR (primary_image_bytes IS NOT NULL AND primary_image_sha256 IS NOT NULL AND primary_image_mime IS NOT NULL)
 )
);

CREATE INDEX second_marketplace_records_lookup
 ON second_marketplace_records(marketplace_id, lower(query_keyword), listing_state, observed_at DESC);

COMMENT ON TABLE second_marketplace_catalog IS 'Candidate selection and strict sold-vs-active isolation policies for second marketplace onboarding (TASK-052).';
COMMENT ON TABLE second_marketplace_records IS 'Normalized second-marketplace sold and active observations with deduplicated event identity and local image bytes.';
