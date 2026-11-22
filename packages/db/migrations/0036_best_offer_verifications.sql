CREATE TABLE best_offer_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 query_id uuid NOT NULL REFERENCES queries,
 user_id uuid NOT NULL REFERENCES users,
 source_id uuid NOT NULL REFERENCES sources,
 sale_event_id uuid NOT NULL,
 listing_id uuid NOT NULL,
 observation_id uuid NOT NULL,
 external_listing_id text NOT NULL,
 currency char(3) NOT NULL DEFAULT 'USD',
 status text NOT NULL CHECK(status IN ('pending','verified','not_available','expired','source_blocked')),
 attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 max_attempts int NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 3),
 verified_price_cents bigint CHECK(verified_price_cents BETWEEN 0 AND 9007199254740991),
 verified_price_usd_cents bigint CHECK(verified_price_usd_cents BETWEEN 0 AND 9007199254740991),
 evidence_kind text,
 evidence_ref text,
 evidence_hash text,
 failure_reason text,
 credit_policy text NOT NULL DEFAULT 'included_post_lookup_zero_credit' CHECK(credit_policy='included_post_lookup_zero_credit'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 verified_at timestamptz,
 UNIQUE(query_id,sale_event_id),
 FOREIGN KEY(query_id,user_id) REFERENCES queries(id,user_id),
 FOREIGN KEY(query_id,sale_event_id) REFERENCES query_snapshot_records(query_id,sale_event_id),
 FOREIGN KEY(sale_event_id,listing_id,source_id,observation_id)
  REFERENCES sale_event_evidence(sale_event_id,listing_id,source_id,observation_id),
 CHECK(attempts<=max_attempts),
 CHECK(expires_at>created_at),
 CHECK(status<>'verified' OR (verified_price_cents IS NOT NULL AND verified_price_usd_cents IS NOT NULL AND evidence_kind IS NOT NULL AND evidence_ref IS NOT NULL AND evidence_hash IS NOT NULL AND verified_at IS NOT NULL)),
 CHECK(status<>'pending' OR verified_at IS NULL)
);
CREATE INDEX best_offer_verifications_queue ON best_offer_verifications(source_id,status,expires_at,updated_at,id);
CREATE INDEX best_offer_verifications_query ON best_offer_verifications(query_id,created_at,id);
CREATE TABLE query_evidence_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 query_id uuid NOT NULL REFERENCES queries,
 user_id uuid NOT NULL REFERENCES users,
 revision_number int NOT NULL CHECK(revision_number>=1),
 parent_revision_number int CHECK(parent_revision_number>=1 AND parent_revision_number<revision_number),
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('delivered_baseline','best_offer_verification')),
 candidate_set_hash text NOT NULL,
 engine_version text NOT NULL,
 cleaner_version text NOT NULL,
 verified_offer_count int NOT NULL DEFAULT 0 CHECK(verified_offer_count>=0),
 pending_offer_count int NOT NULL DEFAULT 0 CHECK(pending_offer_count>=0),
 not_available_offer_count int NOT NULL DEFAULT 0 CHECK(not_available_offer_count>=0),
 stats jsonb NOT NULL,
 quality jsonb NOT NULL,
 records jsonb NOT NULL,
 source_verifications jsonb NOT NULL DEFAULT '[]'::jsonb,
 credits_charged int NOT NULL DEFAULT 0 CHECK(credits_charged=0),
 created_at timestamptz NOT NULL,
 UNIQUE(query_id,revision_number),
 FOREIGN KEY(query_id,user_id) REFERENCES queries(id,user_id),
 CHECK((revision_number=1 AND parent_revision_number IS NULL AND trigger_kind='delivered_baseline') OR (revision_number>1 AND parent_revision_number IS NOT NULL AND trigger_kind='best_offer_verification'))
);
CREATE INDEX query_evidence_revisions_lookup ON query_evidence_revisions(query_id,revision_number DESC);
COMMENT ON TABLE best_offer_verifications IS 'Post-lookup Best Offer verification attempts linked to existing delivered query snapshot observations without mutating baseline statistics.';
COMMENT ON TABLE query_evidence_revisions IS 'Versioned snapshot calculation revisions preserving the original delivered baseline (revision 1) alongside verified post-lookup revisions.';
