ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_marketplace_check;
ALTER TABLE sources ADD CONSTRAINT sources_marketplace_check
 CHECK (marketplace IN ('ebay_us','ebay_uk','ebay_de','mercari_us','tcgplayer_us','psa_registry'));

CREATE TABLE card_products (
 product_id text PRIMARY KEY CHECK (product_id ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
 tcg_game text NOT NULL CHECK (tcg_game IN ('pokemon','mtg','yugioh','sports','other')),
 set_code text NOT NULL CHECK (length(set_code) BETWEEN 1 AND 40),
 set_name text NOT NULL CHECK (length(set_name) BETWEEN 1 AND 120),
 card_number text NOT NULL CHECK (length(card_number) BETWEEN 1 AND 40),
 card_name text NOT NULL CHECK (length(card_name) BETWEEN 1 AND 160),
 edition text NOT NULL CHECK (edition IN ('1st_edition','unlimited','shadowless','holo','reverse_holo','promo','standard')),
 language char(2) NOT NULL CHECK (language ~ '^[a-z]{2}$'),
 finish text NOT NULL CHECK (length(finish) BETWEEN 1 AND 40),
 release_year int CHECK (release_year BETWEEN 1900 AND 2100),
 source_gate_passed boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'preview_offline' CHECK (status IN ('preview_offline','gated','active')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tcg_game, set_code, card_number, edition, language, finish)
);

INSERT INTO card_products(
 product_id,tcg_game,set_code,set_name,card_number,card_name,edition,language,finish,release_year
) VALUES
 ('tcg-pkmn-base-4-1st','pokemon','BS1','Base Set','4/102','Charizard','1st_edition','en','holo',1999),
 ('tcg-pkmn-base-4-unlim','pokemon','BS1','Base Set','4/102','Charizard','unlimited','en','holo',1999),
 ('tcg-mtg-lea-232-std','mtg','LEA','Limited Edition Alpha','232','Black Lotus','standard','en','non_foil',1993);

CREATE TABLE card_sale_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id text NOT NULL REFERENCES card_products(product_id),
 source_id uuid NOT NULL REFERENCES sources(id),
 permission_epoch bigint NOT NULL CHECK (permission_epoch >= 1),
 event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 160),
 grading_state text NOT NULL CHECK (grading_state IN ('raw','graded')),
 grading_company text CHECK (grading_company IN ('PSA','BGS','CGC','SGC','TAG')),
 grade_value text CHECK (grade_value ~ '^[0-9]+(\.[0-9]+)?$'),
 raw_condition text CHECK (raw_condition IN ('near_mint','lightly_played','moderately_played','heavily_played','damaged')),
 edition text NOT NULL CHECK (edition IN ('1st_edition','unlimited','shadowless','holo','reverse_holo','promo','standard')),
 currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 item_minor bigint CHECK (item_minor BETWEEN 0 AND 9007199254740991),
 shipping_minor bigint CHECK (shipping_minor BETWEEN 0 AND 9007199254740991),
 shipping_status text NOT NULL CHECK (shipping_status IN ('observed','verified_free_shipping','unknown')),
 sale_price_status text NOT NULL CHECK (sale_price_status IN ('verified_actual','displayed_only','unknown')),
 sold_at timestamptz,
 comparable boolean NOT NULL DEFAULT true,
 retention_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_id, source_id, event_key),
 CHECK (
  (grading_state = 'raw' AND grading_company IS NULL AND grade_value IS NULL)
  OR (grading_state = 'graded' AND grading_company IS NOT NULL AND grade_value IS NOT NULL AND raw_condition IS NULL)
 )
);
CREATE INDEX card_sale_records_lookup
 ON card_sale_records(product_id, grading_state, edition, sold_at DESC);

CREATE TABLE card_grading_populations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id text NOT NULL REFERENCES card_products(product_id),
 source_id uuid NOT NULL REFERENCES sources(id),
 permission_epoch bigint NOT NULL CHECK (permission_epoch >= 1),
 grading_company text NOT NULL CHECK (grading_company IN ('PSA','BGS','CGC','SGC','TAG')),
 grade_value text NOT NULL CHECK (grade_value ~ '^[0-9]+(\.[0-9]+)?$'),
 pop_count int NOT NULL CHECK (pop_count >= 0),
 pop_higher_count int NOT NULL CHECK (pop_higher_count >= 0),
 as_of timestamptz NOT NULL,
 retention_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_id, source_id, grading_company, grade_value)
);

COMMENT ON TABLE card_products IS 'Canonical TCG and sports card product identities (never replaced by free-text listing titles, TASK-053).';
COMMENT ON TABLE card_sale_records IS 'Card sale comparables enforcing strict raw-vs-graded isolation, edition fidelity, and source epochs.';
COMMENT ON TABLE card_grading_populations IS 'Grading registry census metadata explicitly isolated from sold transaction pricing/volume.';
