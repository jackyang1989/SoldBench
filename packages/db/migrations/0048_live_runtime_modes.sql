ALTER TABLE payment_checkout_intents
 DROP CONSTRAINT IF EXISTS payment_checkout_intents_environment_check;
ALTER TABLE payment_checkout_intents
 ADD CONSTRAINT payment_checkout_intents_environment_check
 CHECK(environment IN ('offline_fixture','sandbox','live'));
