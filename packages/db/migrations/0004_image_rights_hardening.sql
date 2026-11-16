BEGIN;

-- Never silently discard cleartext URLs from a populated deployment. A future
-- populated upgrade must run the application-side encryption migration first.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM listing_images WHERE source_url IS NOT NULL) THEN
  RAISE EXCEPTION 'listing_images contains cleartext source URLs; run npm run db:encrypt-image-urls and verify the report before applying migration 0004';
 END IF;
END $$;
ALTER TABLE listing_images DROP COLUMN source_url;

ALTER TABLE listing_images DROP CONSTRAINT listing_images_state_check;
ALTER TABLE listing_images ADD CONSTRAINT listing_images_state_check
 CHECK(state IN ('pending','available','missing','failed','not_permitted','revoked','expired'));

COMMIT;
