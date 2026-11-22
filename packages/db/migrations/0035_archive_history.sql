CREATE TABLE archive_coverage_spans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 query_hash text NOT NULL,
 collector_run_id uuid NOT NULL,
 permission_epoch bigint NOT NULL CHECK (permission_epoch > 0),
 window_start timestamptz NOT NULL,
 window_end timestamptz NOT NULL,
 retention_until timestamptz NOT NULL,
 completeness text NOT NULL CHECK (completeness IN ('complete','partial')),
 observed_event_count integer NOT NULL DEFAULT 0 CHECK (observed_event_count >= 0),
 multi_unit_listing_row_count integer NOT NULL DEFAULT 0 CHECK (multi_unit_listing_row_count >= 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (window_end > window_start),
 UNIQUE (source_id, query_hash, collector_run_id),
 FOREIGN KEY (collector_run_id, source_id) REFERENCES collector_runs(id, source_id) ON DELETE CASCADE
);

CREATE INDEX archive_coverage_lookup ON archive_coverage_spans(query_hash, source_id, window_start, window_end);
CREATE INDEX archive_coverage_retention ON archive_coverage_spans(retention_until);

ALTER TABLE sale_events
 ADD COLUMN listing_aggregation_kind text NOT NULL DEFAULT 'single_sale'
 CHECK (listing_aggregation_kind IN ('single_sale','multi_unit_listing_average','listing_summary_only'));
