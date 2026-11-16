ALTER TABLE collector_runs ADD COLUMN parser_profile_hash text
 CHECK(parser_profile_hash IS NULL OR parser_profile_hash ~ '^[a-f0-9]{64}$');
CREATE TABLE listing_record_evidence (
 sale_event_id uuid NOT NULL, listing_id uuid NOT NULL, source_id uuid NOT NULL, observation_id uuid NOT NULL,
 profile_hash text NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
 record_index int NOT NULL CHECK(record_index BETWEEN 0 AND 1000),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND pg_column_size(evidence)<=30000),
 PRIMARY KEY(sale_event_id,observation_id),
 FOREIGN KEY(sale_event_id,listing_id,source_id,observation_id)
   REFERENCES sale_event_evidence(sale_event_id,listing_id,source_id,observation_id)
);
COMMENT ON TABLE listing_record_evidence IS 'Private synthetic HTML record metadata. No customer distribution or actual eBay field approval.';
