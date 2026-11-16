-- Expand-only step for a populated database. The application-side backfill
-- must encrypt and verify every non-null source_url before migration 0004.
ALTER TABLE listing_images ADD COLUMN source_url_ciphertext bytea;

COMMENT ON COLUMN listing_images.source_url_ciphertext IS
 'Application-encrypted source URL bytes only; encryption keys must remain outside PostgreSQL.';
