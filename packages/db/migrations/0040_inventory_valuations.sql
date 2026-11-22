CREATE TABLE inventory_valuations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 status text NOT NULL CHECK (status IN ('draft_mapping','queued','running','ready_to_claim','completed','partial','cancelled','failed')),
 batch_id uuid REFERENCES batch_queries,
 billing_consent_accepted boolean NOT NULL DEFAULT false,
 estimated_max_credits int NOT NULL DEFAULT 0 CHECK (estimated_max_credits >= 0),
 total_rows int NOT NULL CHECK (total_rows BETWEEN 1 AND 20),
 total_units int NOT NULL CHECK (total_units >= 1),
 revaluation_of_id uuid REFERENCES inventory_valuations,
 idempotency_key text,
 request_hash text,
 version int NOT NULL DEFAULT 1 CHECK (version >= 1),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 cancelled_at timestamptz,
 UNIQUE(id, user_id),
 UNIQUE(user_id, idempotency_key)
);
CREATE INDEX inventory_valuations_owner ON inventory_valuations(user_id, created_at DESC, id);
CREATE TABLE inventory_valuation_items (
 valuation_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users,
 row_index int NOT NULL CHECK (row_index BETWEEN 0 AND 19),
 sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 80),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
 quantity int NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
 declared_currency text NOT NULL DEFAULT 'USD' CHECK (declared_currency ~ '^[A-Z]{3}$'),
 cost_basis_cents bigint CHECK (cost_basis_cents BETWEEN 0 AND 9007199254740991),
 mapped_q text CHECK (mapped_q IS NULL OR length(mapped_q) BETWEEN 1 AND 120),
 mapped_category text,
 mapped_brand text,
 mapped_model text,
 mapped_condition text,
 window_days int NOT NULL DEFAULT 90 CHECK (window_days IN (30, 90, 180, 365)),
 price_basis text NOT NULL DEFAULT 'item_plus_observed_shipping' CHECK (price_basis IN ('item','item_plus_observed_shipping')),
 mapping_status text NOT NULL CHECK (mapping_status IN ('mapped','unmapped_missing_model','currency_unsupported','invalid_parameters')),
 mapping_note text,
 canonical_query_hash text,
 batch_item_index int,
 query_id uuid REFERENCES queries,
 PRIMARY KEY(valuation_id, row_index),
 FOREIGN KEY(valuation_id, user_id) REFERENCES inventory_valuations(id, user_id) ON DELETE CASCADE
);
COMMENT ON TABLE inventory_valuations IS 'Portfolio inventory valuation runs coordinating mapping confirmation, explicit billing consent, and batch sold-price snapshots.';
COMMENT ON TABLE inventory_valuation_items IS 'Per-SKU inventory valuation items linking declared stock quantities to canonical sold-price query evidence without zero-filling unknowns.';
