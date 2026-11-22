ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_marketplace_check;
ALTER TABLE sources ADD CONSTRAINT sources_marketplace_check CHECK (marketplace IN ('ebay_us','ebay_uk','ebay_de'));

CREATE TABLE marketplace_sites (
 site_id text PRIMARY KEY CHECK (site_id IN ('ebay_us','ebay_uk','ebay_de')),
 country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
 default_currency char(3) NOT NULL CHECK (default_currency IN ('USD','GBP','EUR')),
 timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
 required_locales text[] NOT NULL CHECK (cardinality(required_locales) >= 1),
 shipping_tax_semantics jsonb NOT NULL,
 condition_mapping_version text NOT NULL,
 source_gate_passed boolean NOT NULL DEFAULT false,
 translation_gate_passed boolean NOT NULL DEFAULT false,
 legal_gate_passed boolean NOT NULL DEFAULT false,
 economics_gate_passed boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'preview_offline' CHECK (status IN ('preview_offline','gated','active')),
 updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO marketplace_sites(
 site_id,country_code,display_name,default_currency,timezone,required_locales,shipping_tax_semantics,condition_mapping_version
) VALUES
 ('ebay_us','US','eBay United States','USD','America/Los_Angeles',ARRAY['en','zh-CN'],
  '{"currency":"USD","shipping_label":"Shipping","tax_model":"sales_tax_excluded","postage_isolated":true}'::jsonb,'1.0.0'),
 ('ebay_uk','GB','eBay United Kingdom','GBP','Europe/London',ARRAY['en-GB','en','zh-CN'],
  '{"currency":"GBP","shipping_label":"Postage & Packaging (P&P)","tax_model":"vat_as_observed","postage_isolated":true}'::jsonb,'1.0.0'),
 ('ebay_de','DE','eBay Deutschland','EUR','Europe/Berlin',ARRAY['de','en','zh-CN'],
  '{"currency":"EUR","shipping_label":"Versandkosten","tax_model":"mwst_as_observed","postage_isolated":true}'::jsonb,'1.0.0');

CREATE TABLE fx_rate_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 base_currency char(3) NOT NULL CHECK (base_currency IN ('USD','GBP','EUR')),
 quote_currency char(3) NOT NULL CHECK (quote_currency IN ('USD','GBP','EUR')),
 rate_micros bigint NOT NULL CHECK (rate_micros > 0),
 evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 200),
 provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
 captured_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK (expires_at > captured_at),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (base_currency <> quote_currency)
);
CREATE INDEX fx_rate_snapshots_pair ON fx_rate_snapshots(base_currency, quote_currency, captured_at DESC);

CREATE TABLE regional_site_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 site_id text NOT NULL REFERENCES marketplace_sites(site_id),
 source_id uuid NOT NULL REFERENCES sources(id),
 permission_epoch bigint NOT NULL CHECK (permission_epoch >= 1),
 query_keyword text NOT NULL CHECK (length(query_keyword) BETWEEN 1 AND 120),
 event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 160),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 item_minor bigint CHECK (item_minor BETWEEN 0 AND 9007199254740991),
 shipping_minor bigint CHECK (shipping_minor BETWEEN 0 AND 9007199254740991),
 shipping_status text NOT NULL CHECK (shipping_status IN ('observed','verified_free_shipping','unknown')),
 sale_price_status text NOT NULL CHECK (sale_price_status IN ('verified_actual','displayed_only','unknown')),
 sale_format text NOT NULL CHECK (sale_format IN ('fixed_price','auction','best_offer')),
 condition_raw text,
 condition_std text,
 sold_at timestamptz,
 sold_date_precision text NOT NULL CHECK (sold_date_precision IN ('instant','day','unknown')),
 comparable boolean NOT NULL DEFAULT true,
 retention_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(site_id, source_id, event_key)
);
CREATE INDEX regional_site_records_lookup ON regional_site_records(site_id, lower(query_keyword), sold_at DESC);

COMMENT ON TABLE marketplace_sites IS 'Site-level configuration, tax/postage semantics, and release gates for US/UK/DE marketplaces.';
COMMENT ON TABLE fx_rate_snapshots IS 'Auditable FX rate snapshots (micros precision) with explicit expiry windows; never mixed into raw single-currency sums.';
COMMENT ON TABLE regional_site_records IS 'Per-site sold observations enforcing strict site/source/currency isolation and retention windows.';
