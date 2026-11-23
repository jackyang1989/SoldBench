ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_marketplace_check;
ALTER TABLE sources ADD CONSTRAINT sources_marketplace_check CHECK (
 marketplace IN (
  'ebay_us','ebay_uk','ebay_de','ebay_fr','ebay_it','ebay_es','ebay_ca','ebay_au',
  'mercari_us','tcgplayer_us','psa_registry','goldin_us'
 )
);

ALTER TABLE marketplace_sites DROP CONSTRAINT IF EXISTS marketplace_sites_site_id_check;
ALTER TABLE marketplace_sites ADD CONSTRAINT marketplace_sites_site_id_check CHECK (
 site_id IN ('ebay_us','ebay_uk','ebay_de','ebay_fr','ebay_it','ebay_es','ebay_ca','ebay_au')
);

ALTER TABLE marketplace_sites DROP CONSTRAINT IF EXISTS marketplace_sites_default_currency_check;
ALTER TABLE marketplace_sites ADD CONSTRAINT marketplace_sites_default_currency_check CHECK (
 default_currency IN ('USD','GBP','EUR','CAD','AUD')
);

ALTER TABLE fx_rate_snapshots DROP CONSTRAINT IF EXISTS fx_rate_snapshots_base_currency_check;
ALTER TABLE fx_rate_snapshots ADD CONSTRAINT fx_rate_snapshots_base_currency_check CHECK (
 base_currency IN ('USD','GBP','EUR','CAD','AUD')
);

ALTER TABLE fx_rate_snapshots DROP CONSTRAINT IF EXISTS fx_rate_snapshots_quote_currency_check;
ALTER TABLE fx_rate_snapshots ADD CONSTRAINT fx_rate_snapshots_quote_currency_check CHECK (
 quote_currency IN ('USD','GBP','EUR','CAD','AUD')
);

INSERT INTO marketplace_sites(
 site_id,country_code,display_name,default_currency,timezone,required_locales,shipping_tax_semantics,condition_mapping_version,
 source_gate_passed,translation_gate_passed,legal_gate_passed,economics_gate_passed,status
) VALUES
 ('ebay_fr','FR','eBay France','EUR','Europe/Paris',ARRAY['fr','en','zh-CN'],
  '{"currency":"EUR","shipping_label":"Livraison","tax_model":"tva_as_observed","postage_isolated":true}'::jsonb,'1.1.0',
  false,false,false,false,'preview_offline'),
 ('ebay_it','IT','eBay Italia','EUR','Europe/Rome',ARRAY['it','en','zh-CN'],
  '{"currency":"EUR","shipping_label":"Spedizione","tax_model":"iva_as_observed","postage_isolated":true}'::jsonb,'1.1.0',
  false,false,false,false,'preview_offline'),
 ('ebay_es','ES','eBay España','EUR','Europe/Madrid',ARRAY['es','en','zh-CN'],
  '{"currency":"EUR","shipping_label":"Envío","tax_model":"iva_as_observed","postage_isolated":true}'::jsonb,'1.1.0',
  false,false,false,false,'preview_offline'),
 ('ebay_ca','CA','eBay Canada','CAD','America/Toronto',ARRAY['en-CA','fr-CA','en','zh-CN'],
  '{"currency":"CAD","shipping_label":"Shipping / Livraison","tax_model":"gst_hst_qst_excluded_unless_observed","postage_isolated":true}'::jsonb,'1.1.0',
  false,false,false,false,'preview_offline'),
 ('ebay_au','AU','eBay Australia','AUD','Australia/Sydney',ARRAY['en-AU','en','zh-CN'],
  '{"currency":"AUD","shipping_label":"Postage","tax_model":"gst_as_observed","postage_isolated":true}'::jsonb,'1.1.0',
  false,false,false,false,'preview_offline');
