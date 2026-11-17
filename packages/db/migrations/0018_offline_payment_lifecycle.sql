CREATE TABLE payment_checkout_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users,
 plan_id uuid NOT NULL REFERENCES plans,
 provider text NOT NULL CHECK(provider IN ('stripe','paypal')),
 environment text NOT NULL CHECK(environment='offline_fixture'),
 merchant_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('subscription','purchased')),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency char(3) NOT NULL CHECK(currency='USD'),
 credits int NOT NULL CHECK(credits>0),
 state text NOT NULL CHECK(state IN ('pending','confirmed','expired')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE (id,user_id), CHECK (expires_at>created_at)
);
CREATE UNIQUE INDEX payment_checkout_one_subscription_pending
 ON payment_checkout_intents(user_id) WHERE kind='subscription' AND state='pending';
ALTER TABLE payments ADD COLUMN checkout_intent_id uuid,
 ADD COLUMN provider_revision int NOT NULL DEFAULT 0 CHECK(provider_revision>=0),
 ADD COLUMN payment_subscription_id uuid,
 ADD COLUMN provider_subscription_ref text,
 ADD COLUMN period_start timestamptz,
 ADD COLUMN period_end timestamptz,
 ADD CONSTRAINT payment_intent_owner_fk FOREIGN KEY(checkout_intent_id,user_id) REFERENCES payment_checkout_intents(id,user_id),
 ADD CONSTRAINT payment_period_valid CHECK((period_start IS NULL AND period_end IS NULL) OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end>period_start));
CREATE UNIQUE INDEX payment_confirmed_subscription_cycle
 ON payments(payment_subscription_id,period_start)
 WHERE payment_subscription_id IS NOT NULL AND state IN ('confirmed','disputed','refunded');
CREATE UNIQUE INDEX payment_confirmed_purchased_intent
 ON payments(checkout_intent_id)
 WHERE checkout_intent_id IS NOT NULL AND period_start IS NULL AND state IN ('confirmed','disputed','refunded');
ALTER TABLE subscriptions ADD COLUMN checkout_intent_id uuid UNIQUE,
 ADD CONSTRAINT subscription_intent_user_identity UNIQUE(id,checkout_intent_id,user_id),
 ADD CONSTRAINT subscription_intent_owner_fk FOREIGN KEY(checkout_intent_id,user_id) REFERENCES payment_checkout_intents(id,user_id);
ALTER TABLE payments ADD CONSTRAINT payment_subscription_owner_fk
 FOREIGN KEY(payment_subscription_id,checkout_intent_id,user_id) REFERENCES subscriptions(id,checkout_intent_id,user_id);
ALTER TABLE payment_events ADD COLUMN fixture_envelope jsonb,
 ADD COLUMN fixture_digest text,
 ADD COLUMN fixture_attempts int NOT NULL DEFAULT 0,
 ADD COLUMN fixture_retry_at timestamptz,
 ADD COLUMN fixture_error text;
CREATE INDEX payment_fixture_event_due
 ON payment_events(fixture_retry_at, received_at,id) WHERE fixture_envelope IS NOT NULL AND status IN ('received','retryable');
CREATE TABLE payment_fixture_facts (
 provider text NOT NULL CHECK(provider IN ('stripe','paypal')),
 merchant_id text NOT NULL,
 object_id text NOT NULL,
 revision int NOT NULL CHECK(revision>0),
 fact jsonb NOT NULL CHECK(jsonb_typeof(fact)='object'),
 PRIMARY KEY(provider,merchant_id,object_id,revision)
);
