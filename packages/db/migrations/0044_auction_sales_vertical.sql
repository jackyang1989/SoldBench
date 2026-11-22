ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_marketplace_check;
ALTER TABLE sources ADD CONSTRAINT sources_marketplace_check
 CHECK (marketplace IN ('ebay_us','ebay_uk','ebay_de','mercari_us','tcgplayer_us','psa_registry','goldin_us'));

CREATE TABLE auction_house_catalog (
 house_id text PRIMARY KEY CHECK (house_id IN ('goldin_us','fanatics_collect','pristine_auction','myslabs')),
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
 selection_status text NOT NULL CHECK (selection_status IN ('selected_first_auction','deferred_candidate')),
 default_currency char(3) NOT NULL CHECK (default_currency IN ('USD','GBP','EUR')),
 premium_disclosure text NOT NULL CHECK (length(premium_disclosure) BETWEEN 1 AND 400),
 source_gate_passed boolean NOT NULL DEFAULT false,
 media_gate_passed boolean NOT NULL DEFAULT false,
 quality_gate_passed boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'preview_offline' CHECK (status IN ('preview_offline','gated','active')),
 updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO auction_house_catalog(house_id,display_name,selection_status,default_currency,premium_disclosure) VALUES
 ('goldin_us','Goldin Auctions US','selected_first_auction','USD',
  'Selected first auction source: separates hammer price, buyer premium rate/amount, and all-in total; unknown buyer premium stays null and never mixes hammer vs all-in distributions.'),
 ('fanatics_collect','Fanatics Collect (PWCC)','deferred_candidate','USD',
  'Deferred candidate: requires independent source clearance and estimation outside TASK-054.'),
 ('pristine_auction','Pristine Auction','deferred_candidate','USD',
  'Deferred candidate: requires independent source clearance and consignment premium rules outside TASK-054.'),
 ('myslabs','MySlabs','deferred_candidate','USD',
  'Deferred candidate: requires independent source clearance and fixed/offer vs auction split outside TASK-054.');

CREATE TABLE auction_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 auction_house text NOT NULL REFERENCES auction_house_catalog(house_id),
 session_code text NOT NULL CHECK (length(session_code) BETWEEN 1 AND 80),
 session_name text NOT NULL CHECK (length(session_name) BETWEEN 1 AND 160),
 currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 tax_semantics text NOT NULL CHECK (length(tax_semantics) BETWEEN 1 AND 200),
 closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(auction_house, session_code)
);

CREATE TABLE auction_lot_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 auction_house text NOT NULL REFERENCES auction_house_catalog(house_id),
 session_id uuid NOT NULL REFERENCES auction_sessions(id),
 source_id uuid NOT NULL REFERENCES sources(id),
 permission_epoch bigint NOT NULL CHECK (permission_epoch >= 1),
 lot_number text NOT NULL CHECK (length(lot_number) BETWEEN 1 AND 40),
 event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 160),
 query_keyword text NOT NULL CHECK (length(query_keyword) BETWEEN 1 AND 120),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 grading_company text CHECK (grading_company IN ('PSA','BGS','CGC','SGC','TAG')),
 grade_value text CHECK (grade_value ~ '^[0-9]+(\.[0-9]+)?$'),
 cert_number text CHECK (length(cert_number) BETWEEN 1 AND 64),
 currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 hammer_minor bigint CHECK (hammer_minor BETWEEN 0 AND 9007199254740991),
 buyers_premium_status text NOT NULL CHECK (buyers_premium_status IN ('known','none','unknown')),
 buyers_premium_bps int CHECK (buyers_premium_bps BETWEEN 0 AND 10000),
 buyers_premium_minor bigint CHECK (buyers_premium_minor BETWEEN 0 AND 9007199254740991),
 total_with_premium_minor bigint CHECK (total_with_premium_minor BETWEEN 0 AND 9007199254740991),
 tax_included boolean NOT NULL DEFAULT false,
 sale_status text NOT NULL CHECK (sale_status IN ('sold','unsold','withdrawn')),
 sold_at timestamptz,
 comparable boolean NOT NULL DEFAULT true,
 primary_image_sha256 text CHECK (primary_image_sha256 ~ '^[0-9a-f]{64}$'),
 primary_image_mime text CHECK (primary_image_mime IN ('image/webp','image/png','image/jpeg')),
 primary_image_bytes bytea CHECK (octet_length(primary_image_bytes) BETWEEN 1 AND 5242880),
 media_rights_status text NOT NULL DEFAULT 'missing' CHECK (media_rights_status IN ('authorized','missing','revoked')),
 retention_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(auction_house, source_id, event_key),
 CHECK (
  (buyers_premium_status = 'unknown' AND buyers_premium_minor IS NULL AND buyers_premium_bps IS NULL AND total_with_premium_minor IS NULL)
  OR (buyers_premium_status = 'none' AND buyers_premium_minor = 0 AND coalesce(buyers_premium_bps, 0) = 0 AND (hammer_minor IS NULL OR total_with_premium_minor = hammer_minor))
  OR (buyers_premium_status = 'known' AND buyers_premium_minor IS NOT NULL AND (hammer_minor IS NULL OR total_with_premium_minor = hammer_minor + buyers_premium_minor))
 ),
 CHECK (
  (primary_image_bytes IS NULL AND primary_image_sha256 IS NULL AND primary_image_mime IS NULL)
  OR (primary_image_bytes IS NOT NULL AND primary_image_sha256 IS NOT NULL AND primary_image_mime IS NOT NULL)
 )
);
CREATE INDEX auction_lot_records_lookup
 ON auction_lot_records(auction_house, lower(query_keyword), sale_status, sold_at DESC);

COMMENT ON TABLE auction_house_catalog IS 'Candidate auction house onboarding catalog (goldin_us selected first vertical, deferred candidates gated, TASK-054).';
COMMENT ON TABLE auction_sessions IS 'Auction house catalog sessions carrying currency and tax semantics.';
COMMENT ON TABLE auction_lot_records IS 'Auction lot results with separate hammer, buyer premium, all-in total, grading cert, and private lot image bytes.';
