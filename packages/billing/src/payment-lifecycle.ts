import { createHash, randomUUID } from "node:crypto";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import { BILLING_VERSION, type BillingService } from "./index.ts";
import {
  type Envelope,
  type FixtureKeys,
  factSchema,
  merchant,
  type PaymentFact,
  type Provider,
  providers,
  verifyFixture,
} from "./payment-fixtures.ts";

export const offerVersion = "offline-v1";
const offers = {
  starter: { amount: 900, credits: 2000, rate: 60, kind: "subscription" },
  pro: { amount: 2900, credits: 10000, rate: 300, kind: "subscription" },
  purchased_1500: { amount: 1000, credits: 1500, rate: 30, kind: "purchased" },
} as const;
const fail = (code: string, status: number, message: string): never => {
  throw new AppError(code, status, message);
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const at = (now: Date, ms: number) => new Date(now.getTime() + ms);
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const idempotency = (value: string | undefined) =>
  value && /^[\x21-\x7e]{16,128}$/.test(value)
    ? hash(value)
    : fail("invalid_parameter", 400, "A valid Idempotency-Key is required.");

type PaymentActor =
  | string
  | {
      userId: string;
      assertCurrent: (c: Transaction, now: Date) => Promise<unknown>;
    };

type Intent = {
  id: string;
  user_id: string;
  plan_id: string;
  provider: Provider;
  merchant_id: string;
  kind: "subscription" | "purchased";
  amount_cents: string;
  credits: number;
  state: "pending" | "confirmed" | "expired";
  expires_at: Date;
  created_at: Date;
};
type Receipt = { id: string; provider: Provider; fixture_envelope: Envelope; fixture_attempts: number };
type Subscription = {
  id: string;
  user_id: string;
  provider: Provider;
  provider_subscription_id: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  version: number;
  status: string;
  code: string;
};
class Review extends Error {
  constructor(
    readonly code: string,
    readonly retry = false,
  ) {
    super(code);
  }
}
function inspectMatch(fact: PaymentFact, envelope: Envelope) {
  const { kind, provider } = fact;
  if (kind === "checkout_expired") return envelope.type === "checkout_expired";
  if (fact.status === "disputed") return envelope.type === "dispute_changed";
  if (fact.status === "refunded")
    return ["charge_refunded", "capture_refunded", "dispute_changed"].includes(envelope.type);
  if (fact.status === "failed")
    return envelope.type === (provider === "stripe" ? "payment_intent_failed" : "capture_denied");
  if (envelope.type === "dispute_changed") return true;
  if (fact.subscription_id)
    return envelope.type === (provider === "stripe" ? "invoice_paid" : "sale_completed");
  return envelope.type === (provider === "stripe" ? "payment_intent_succeeded" : "capture_completed");
}

export class PaymentLifecycle {
  constructor(
    readonly billing: BillingService,
    readonly origin: string,
    private readonly keys: FixtureKeys,
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("offline_payment_origin_required");
    if (keys.stripe === keys.paypal || providers.some((p) => !/^[0-9a-f]{64}$/.test(keys[p])))
      throw new Error("distinct_payment_fixture_keys_required");
  }
  checkoutOffers() {
    return {
      offer_version: offerVersion,
      data_mode: "offline_fixture" as const,
      providers: [...providers],
      offers: Object.entries(offers).map(([plan_code, offer]) => ({
        plan_code,
        amount_cents: offer.amount,
        credits: offer.credits,
        kind: offer.kind,
        currency: "USD" as const,
      })),
    };
  }
  private async owner(c: Transaction, actor: PaymentActor) {
    const now = await this.billing.now(c);
    // A bare owner id is used by trusted in-process fixture tooling only.
    if (typeof actor === "string") {
      await this.billing.lockOwner(c, actor);
      return { userId: actor, now };
    }
    await actor.assertCurrent(c, now);
    return { userId: actor.userId, now };
  }
  async checkout(
    actor: PaymentActor,
    input: { plan_code: string; offer_version: string; provider?: string },
    key?: string,
  ) {
    const provider = input.provider ?? "stripe";
    if (!providers.some((p) => p === provider))
      fail("invalid_parameter", 400, "Unsupported payment provider.");
    if (!Object.hasOwn(offers, input.plan_code)) fail("invalid_parameter", 400, "Invalid plan.");
    if (input.offer_version !== offerVersion)
      fail("state_conflict", 409, "Refresh the current offline offer.");
    const offer = offers[input.plan_code as keyof typeof offers],
      keyHash = idempotency(key);
    const requestHash = hash(JSON.stringify([provider, input.plan_code, input.offer_version]));
    return transaction(this.billing.db, async (c) => {
      const { userId, now } = await this.owner(c, actor),
        prior = (
          await c.query(
            "SELECT request_hash,resource_id FROM idempotency_records WHERE owner_scope=$1 AND operation='payment.checkout' AND key_hash=$2",
            [userId, keyHash],
          )
        ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail("idempotency_conflict", 409, "This checkout key has different terms.");
        const intent = await this.intent(c, userId, prior.resource_id);
        if (intent?.state !== "pending" || intent.expires_at <= now)
          return fail("state_conflict", 409, "The prior checkout is no longer payable.");
        return this.checkoutView(intent);
      }
      if (offer.kind === "subscription") {
        const occupied = (
          await c.query(
            "SELECT EXISTS(SELECT 1 FROM payment_checkout_intents WHERE user_id=$1 AND kind='subscription' AND state='pending') OR EXISTS(SELECT 1 FROM subscriptions WHERE user_id=$1 AND status IN ('active','past_due','trialing','disputed','cancelled') AND (current_period_end>$2 OR (NOT cancel_at_period_end AND status<>'cancelled'))) AS occupied",
            [userId, now],
          )
        ).rows[0].occupied;
        if (occupied)
          fail("state_conflict", 409, "An existing subscription or checkout must be reconciled first.");
      }
      await c.query(
        "INSERT INTO plans(code,policy_version,price_usd_cents,monthly_credits,rate_limit_per_min,features) VALUES($1,$2,$3,$4,$5,'{\"offline_fixture\":true}') ON CONFLICT(code,policy_version) DO NOTHING",
        [input.plan_code, offerVersion, offer.amount, offer.credits, offer.rate],
      );
      const plan = (
        await c.query(
          "SELECT id,price_usd_cents,monthly_credits FROM plans WHERE code=$1 AND policy_version=$2",
          [input.plan_code, offerVersion],
        )
      ).rows[0];
      if (Number(plan.price_usd_cents) !== offer.amount || plan.monthly_credits !== offer.credits)
        throw new Error("offline_offer_integrity");
      const intent = (
        await c.query<Intent>(
          "INSERT INTO payment_checkout_intents(user_id,plan_id,provider,environment,merchant_id,kind,amount_cents,currency,credits,state,expires_at,created_at) VALUES($1,$2,$3,'offline_fixture',$4,$5,$6,'USD',$7,'pending',$8,$9) RETURNING *",
          [
            userId,
            plan.id,
            provider,
            merchant(provider as Provider),
            offer.kind,
            offer.amount,
            offer.credits,
            at(now, 1800000),
            now,
          ],
        )
      ).rows[0];
      if (!intent) throw new Error("checkout_persistence_failed");
      await c.query(
        "INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at) VALUES($1,'payment.checkout',$2,$3,$4,'committed',$5)",
        [userId, keyHash, requestHash, intent.id, at(now, 86400000)],
      );
      await this.audit(c, userId, "payment.checkout", intent.id, { provider, plan_code: input.plan_code });
      return this.checkoutView(intent);
    });
  }
  private checkoutView(intent: Intent) {
    return {
      checkout_url: `${this.origin}/billing/checkout/${intent.id}`,
      provider: intent.provider,
      expires_at: iso(intent.expires_at),
    };
  }
  private async intent(c: Transaction, userId: string, id: string) {
    return (
      await c.query<Intent>("SELECT * FROM payment_checkout_intents WHERE id=$1 AND user_id=$2", [id, userId])
    ).rows[0];
  }
  async checkoutStatus(actor: PaymentActor, id: string) {
    return transaction(this.billing.db, async (c) => {
      const { userId, now } = await this.owner(c, actor);
      const record = await this.intent(c, userId, id);
      if (!record) return fail("not_found", 404, "Checkout not found.");
      return {
        provider: record.provider,
        status:
          record.state === "pending" && record.expires_at <= now ? "awaiting_reconciliation" : record.state,
        amount_cents: Number(record.amount_cents),
        currency: "USD",
        expires_at: iso(record.expires_at),
        data_mode: "offline_fixture",
      };
    });
  }
  async receive(provider: Provider, headers: Headers, raw: Buffer) {
    return transaction(this.billing.db, async (c) => {
      const now = await this.billing.now(c),
        { envelope, sha256 } = verifyFixture(provider, this.keys[provider], headers, raw, now);
      const inserted = await c.query(
        "INSERT INTO payment_events(provider,provider_event_id,event_type,payload_ref,received_at,status,fixture_envelope,fixture_digest,fixture_retry_at) VALUES($1,$2,$3,$4,$5,'received',$6,$4,$5) ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id",
        [provider, envelope.id, envelope.type, sha256, now, envelope],
      );
      if (!inserted.rowCount) {
        const prior = (
          await c.query(
            "SELECT fixture_digest FROM payment_events WHERE provider=$1 AND provider_event_id=$2",
            [provider, envelope.id],
          )
        ).rows[0];
        if (prior?.fixture_digest !== sha256)
          fail("idempotency_conflict", 409, "This event ID already has different bytes.");
      }
    });
  }
  /** Controlled fixture/test ingress. No customer route can record financial confirmations. */
  async stageFixture(input: unknown) {
    const fact = factSchema.parse(input);
    if (fact.merchant !== merchant(fact.provider)) throw new Error("fixture_merchant_mismatch");
    await transaction(this.billing.db, async (c) => {
      await this.lockFixtureObject(c, fact.provider, fact.object_id);
      const rows = await c.query(
        "INSERT INTO payment_fixture_facts(provider,merchant_id,object_id,revision,fact) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider,merchant_id,object_id,revision) DO NOTHING RETURNING revision",
        [fact.provider, fact.merchant, fact.object_id, fact.revision, fact],
      );
      if (rows.rowCount) return;
      const match = (
        await c.query(
          "SELECT 1 FROM payment_fixture_facts WHERE provider=$1 AND merchant_id=$2 AND object_id=$3 AND revision=$4 AND fact=$5::jsonb",
          [fact.provider, fact.merchant, fact.object_id, fact.revision, fact],
        )
      ).rowCount;
      if (!match) throw new Error("fixture_fact_revision_conflict");
    });
  }
  private async lockFixtureObject(c: Transaction, provider: Provider, object: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      `offline-fixture-fact:${provider}`,
      object,
    ]);
  }
  async workOnce() {
    return transaction(this.billing.db, async (c) => {
      const now = await this.billing.now(c),
        receipt = (
          await c.query<Receipt>(
            "SELECT id,provider,fixture_envelope,fixture_attempts FROM payment_events WHERE status IN ('received','retryable') AND fixture_retry_at<=$1 AND fixture_envelope IS NOT NULL ORDER BY fixture_retry_at,received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
            [now],
          )
        ).rows[0];
      if (!receipt) return null;
      await c.query("SAVEPOINT payment_apply");
      try {
        const envelope = receipt.fixture_envelope;
        const row = (
          await c.query(
            "SELECT fact FROM payment_fixture_facts WHERE provider=$1 AND merchant_id=$2 AND object_id=$3 AND revision=$4",
            [receipt.provider, envelope.merchant, envelope.object_id, envelope.revision],
          )
        ).rows[0];
        if (!row) throw new Review("confirmation_pending", true);
        const fact = factSchema.parse(row.fact);
        if (
          fact.provider !== receipt.provider ||
          fact.merchant !== envelope.merchant ||
          fact.object_id !== envelope.object_id ||
          fact.revision !== envelope.revision ||
          !inspectMatch(fact, envelope)
        )
          throw new Review("confirmation_mismatch");
        await this.apply(c, fact, now);
        await c.query(
          "UPDATE payment_events SET status='applied',processed_at=$2,fixture_error=NULL WHERE id=$1",
          [receipt.id, now],
        );
        return { status: "applied", eventId: receipt.id };
      } catch (error) {
        if (!(error instanceof Review)) throw error;
        await c.query("ROLLBACK TO SAVEPOINT payment_apply");
        const attempts = receipt.fixture_attempts + 1,
          retry = error.retry && attempts < 12;
        const status = retry ? "retryable" : "failed";
        await c.query(
          "UPDATE payment_events SET status=$2,processed_at=$3,fixture_attempts=$4,fixture_retry_at=$5,fixture_error=$6 WHERE id=$1",
          [
            receipt.id,
            status,
            retry ? null : now,
            attempts,
            retry ? at(now, Math.min(30 * 2 ** (attempts - 1), 3600) * 1000) : null,
            error.code,
          ],
        );
        return { status, eventId: receipt.id, reason: error.code };
      }
    });
  }
  /** Reconcile only a sealed offline notification whose confirmation arrived after its retry budget. */
  async replayLateConfirmation(c: Transaction, id: string, now: Date) {
    const receipt = (
      await c.query<Receipt & { status: string; fixture_error: string | null }>(
        "SELECT id,provider,fixture_envelope,fixture_attempts,status,fixture_error FROM payment_events WHERE id=$1 AND fixture_envelope IS NOT NULL FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!receipt) return fail("not_found", 404, "Offline payment receipt not found.");
    if (receipt.status === "applied")
      return { outcome: "already_applied" as const, attempts: receipt.fixture_attempts };
    if (
      receipt.status !== "failed" ||
      receipt.fixture_attempts < 12 ||
      receipt.fixture_error !== "confirmation_pending"
    )
      return fail("state_conflict", 409, "This receipt is outside the late confirmation recovery scope.");
    const envelope = receipt.fixture_envelope;
    await this.lockFixtureObject(c, receipt.provider, envelope.object_id);
    const recorded = (
      await c.query(
        `SELECT fact FROM payment_fixture_facts WHERE provider=$1 AND merchant_id=$2 AND object_id=$3
       ORDER BY revision DESC LIMIT 1`,
        [receipt.provider, envelope.merchant, envelope.object_id],
      )
    ).rows[0];
    if (!recorded) return fail("state_conflict", 409, "Trusted confirmation is still missing.");
    const fact = factSchema.parse(recorded.fact);
    const review = (reason: string) => ({
      outcome: "manual_review" as const,
      attempts: receipt.fixture_attempts,
      revision: fact.revision,
      reason,
    });
    if (fact.revision !== envelope.revision) return review("confirmation_superseded");
    if (
      fact.provider !== receipt.provider ||
      fact.merchant !== envelope.merchant ||
      fact.object_id !== envelope.object_id ||
      fact.kind !== "transaction" ||
      fact.status !== "confirmed" ||
      !inspectMatch(fact, envelope)
    )
      return review("confirmation_mismatch");
    await c.query("SAVEPOINT late_confirmation_apply");
    try {
      await this.apply(c, fact, now);
      await c.query(
        "UPDATE payment_events SET status='applied',processed_at=$2,fixture_error=NULL WHERE id=$1",
        [id, now],
      );
      return { outcome: "applied" as const, attempts: receipt.fixture_attempts, revision: fact.revision };
    } catch (error) {
      if (!(error instanceof Review)) throw error;
      await c.query("ROLLBACK TO SAVEPOINT late_confirmation_apply");
      return review(error.code);
    }
  }
  private async audit(c: Transaction, userId: string, action: string, id: string, diff: object) {
    await c.query(
      "INSERT INTO audit_events(actor_id,action,object_type,object_id,request_id,safe_diff) VALUES($1,$2,'offline_payment',$3,$4,$5)",
      [userId, action, id, randomUUID(), diff],
    );
  }
  private async apply(c: Transaction, fact: PaymentFact, now: Date) {
    const found = (
      await c.query("SELECT user_id FROM payment_checkout_intents WHERE id=$1", [fact.checkout_id])
    ).rows[0];
    if (!found) throw new Review("checkout_missing");
    const active = (
      await c.query("SELECT id,status,email_verified_at,free_anchor_at FROM users WHERE id=$1 FOR UPDATE", [
        found.user_id,
      ])
    ).rows[0];
    const intent = await this.intent(c, found.user_id, fact.checkout_id);
    if (!intent || intent.provider !== fact.provider || intent.merchant_id !== fact.merchant)
      throw new Review("checkout_scope_mismatch");
    if (fact.kind === "checkout_expired") {
      const checked = new Date(fact.checked_at);
      if (checked < intent.expires_at || checked > now || fact.object_id !== intent.id)
        throw new Review("checkout_expiry_unconfirmed");
      await c.query("UPDATE payment_checkout_intents SET state='expired' WHERE id=$1 AND state='pending'", [
        intent.id,
      ]);
      return;
    }
    const paidAt = new Date(fact.paid_at);
    if (
      paidAt < intent.created_at ||
      paidAt > now ||
      Number(intent.amount_cents) !== fact.amount_cents ||
      fact.currency !== "USD"
    )
      throw new Review("transaction_terms_mismatch");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      `offline-payment:${fact.provider}`,
      fact.object_id,
    ]);
    if (fact.subscription_id)
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
        `offline-subscription:${fact.provider}`,
        fact.subscription_id,
      ]);
    const prior = (
      await c.query("SELECT * FROM payments WHERE provider=$1 AND provider_payment_id=$2 FOR UPDATE", [
        fact.provider,
        fact.object_id,
      ])
    ).rows[0];
    if (
      prior &&
      (prior.checkout_intent_id !== intent.id ||
        prior.user_id !== intent.user_id ||
        Number(prior.amount_cents) !== fact.amount_cents ||
        prior.provider_subscription_ref !== fact.subscription_id ||
        iso(prior.period_start) !== iso(fact.period_start ? new Date(fact.period_start) : null) ||
        iso(prior.period_end) !== iso(fact.period_end ? new Date(fact.period_end) : null))
    )
      throw new Review("transaction_identity_conflict");
    if (prior?.provider_revision >= fact.revision || prior?.state === "refunded") return;
    if (fact.status === "failed" && prior && prior.state !== "failed") return;
    if ((!active?.email_verified_at || active.status !== "active") && fact.status === "confirmed")
      throw new Review("owner_not_active");
    let sub: Subscription | undefined;
    const start = fact.period_start ? new Date(fact.period_start) : null,
      end = fact.period_end ? new Date(fact.period_end) : null;
    if (intent.kind === "purchased") {
      if (fact.subscription_id || start || end) throw new Review("purchased_period_invalid");
    } else {
      if (!fact.subscription_id || !start || !end || end <= start || paidAt < start || paidAt >= end)
        throw new Review("subscription_period_invalid");
      sub = (
        await c.query<Subscription>("SELECT * FROM subscriptions WHERE checkout_intent_id=$1 FOR UPDATE", [
          intent.id,
        ])
      ).rows[0];
      if (sub && (sub.provider !== fact.provider || sub.provider_subscription_id !== fact.subscription_id))
        throw new Review("subscription_identity_conflict");
    }
    if (
      !prior &&
      (!sub || intent.kind === "purchased") &&
      (intent.state === "expired" || paidAt >= intent.expires_at)
    ) {
      if (intent.kind === "subscription" && intent.state === "pending" && paidAt >= intent.expires_at)
        throw new Review("initial_period_pending", true);
      throw new Review("checkout_no_longer_payable");
    }
    if (fact.status !== "failed" && intent.kind === "subscription" && start && end && fact.subscription_id) {
      if (intent.state === "expired") throw new Review("checkout_no_longer_payable");
      const periodStatus = fact.status === "confirmed" ? "active" : "past_due";
      if (!sub) {
        const conflict = (
          await c.query(
            "SELECT 1 FROM subscriptions WHERE (provider=$1 AND provider_subscription_id=$2) OR (user_id=$3 AND current_period_end>$4 AND checkout_intent_id IS DISTINCT FROM $5)",
            [fact.provider, fact.subscription_id, intent.user_id, start, intent.id],
          )
        ).rowCount;
        if (conflict) throw new Review("subscription_identity_conflict");
        sub = (
          await c.query<Subscription>(
            "INSERT INTO subscriptions(user_id,plan_id,provider,provider_subscription_id,status,current_period_start,current_period_end,checkout_intent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              intent.user_id,
              intent.plan_id,
              fact.provider,
              fact.subscription_id,
              periodStatus,
              start,
              end,
              intent.id,
            ],
          )
        ).rows[0];
        if (!sub) throw new Error("subscription_persistence_failed");
      } else if (start > sub.current_period_end) {
        throw new Review("previous_period_pending", true);
      } else if (start.getTime() === sub.current_period_end.getTime()) {
        if (sub.cancel_at_period_end) throw new Review("subscription_cancelled_for_next_period");
        await c.query(
          "UPDATE subscriptions SET current_period_start=$2,current_period_end=$3,status=$4,version=version+1 WHERE id=$1",
          [sub.id, start, end, periodStatus],
        );
      } else if (
        start.getTime() === sub.current_period_start.getTime() &&
        end.getTime() === sub.current_period_end.getTime()
      ) {
        if (sub.status !== periodStatus)
          await c.query("UPDATE subscriptions SET status=$2,version=version+1 WHERE id=$1", [
            sub.id,
            periodStatus,
          ]);
      } else if (end > sub.current_period_start) {
        throw new Review("subscription_period_conflict");
      }
    }
    if (fact.status !== "failed") {
      const used = (
        await c.query(
          "SELECT 1 FROM payments WHERE checkout_intent_id=$1 AND provider_payment_id<>$2 AND state IN ('confirmed','disputed','refunded') AND period_start IS NOT DISTINCT FROM $3::timestamptz",
          [intent.id, fact.object_id, start],
        )
      ).rowCount;
      if (used) throw new Review("duplicate_payment_cycle");
    }
    const paymentId = prior?.id ?? randomUUID();
    if (prior) {
      await c.query(
        "UPDATE payments SET state=$2,provider_revision=$3,refunded_cents=$4,payment_subscription_id=coalesce(payment_subscription_id,$5) WHERE id=$1",
        [
          paymentId,
          fact.status,
          fact.revision,
          fact.status === "refunded" ? fact.amount_cents : 0,
          sub?.id ?? null,
        ],
      );
    } else {
      await c.query(
        "INSERT INTO payments(id,user_id,provider,provider_payment_id,amount_cents,refunded_cents,currency,state,created_at,checkout_intent_id,provider_revision,payment_subscription_id,period_start,period_end,provider_subscription_ref) VALUES($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          paymentId,
          intent.user_id,
          fact.provider,
          fact.object_id,
          fact.amount_cents,
          fact.status === "refunded" ? fact.amount_cents : 0,
          fact.status,
          paidAt,
          intent.id,
          fact.revision,
          sub?.id ?? null,
          start,
          end,
          fact.subscription_id,
        ],
      );
    }
    if (fact.status === "confirmed") {
      await c.query("UPDATE payment_checkout_intents SET state='confirmed' WHERE id=$1 AND state='pending'", [
        intent.id,
      ]);
      if (intent.kind === "purchased" || (end && end > now))
        await this.billing.grantLocked(
          c,
          intent.user_id,
          {
            kind: intent.kind,
            provider: fact.provider,
            reference: fact.object_id,
            amount: intent.credits,
            paymentId,
            expiresAt: end,
            periodStart: start ?? undefined,
          },
          now,
        );
      if (intent.kind === "subscription") await this.billing.ensureFreeLocked(c, active, now);
    } else if (fact.status === "disputed" && intent.kind === "subscription") {
      await c.query("UPDATE payment_checkout_intents SET state='confirmed' WHERE id=$1 AND state='pending'", [
        intent.id,
      ]);
    } else if (fact.status === "refunded") {
      await this.billing.revokePaymentLocked(c, intent.user_id, paymentId, now);
      if (intent.state === "pending")
        await c.query("UPDATE payment_checkout_intents SET state='confirmed' WHERE id=$1", [intent.id]);
    }
    await this.audit(c, intent.user_id, `payment.${fact.status}`, paymentId, {
      provider: fact.provider,
      revision: fact.revision,
    });
  }

  private async current(c: Transaction, userId: string) {
    return (
      await c.query<Subscription>(
        "SELECT s.*,p.code FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.current_period_end DESC,s.id LIMIT 1",
        [userId],
      )
    ).rows[0];
  }
  private async view(c: Transaction, userId: string, now: Date) {
    const sub = await this.current(c, userId),
      pending = (
        await c.query(
          "SELECT provider,p.code FROM payment_checkout_intents i JOIN plans p ON p.id=i.plan_id WHERE i.user_id=$1 AND i.kind='subscription' AND i.state='pending'",
          [userId],
        )
      ).rows[0],
      risk = await this.billing.hasPaymentHold(c, userId);
    const current = sub && sub.current_period_end > now ? sub : undefined;
    return {
      plan_code: current?.code ?? pending?.code ?? "free",
      status: current ? (risk ? "disputed" : current.status) : pending ? "pending" : "free",
      provider: current?.provider ?? pending?.provider ?? null,
      current_period_start: iso(current?.current_period_start),
      current_period_end: iso(current?.current_period_end),
      cancel_at_period_end: current?.cancel_at_period_end ?? false,
      policy_version: BILLING_VERSION,
      credit_recovery_open: Boolean(risk),
      version: current?.version ?? null,
    };
  }
  async subscription(actor: PaymentActor) {
    return transaction(this.billing.db, async (c) => {
      const { userId, now } = await this.owner(c, actor);
      return this.view(c, userId, now);
    });
  }
  async cancel(actor: PaymentActor, version: number) {
    return transaction(this.billing.db, async (c) => {
      const { userId, now } = await this.owner(c, actor),
        sub = await this.current(c, userId);
      if (!sub || (sub.cancel_at_period_end && sub.current_period_end <= now) || sub.status === "cancelled")
        return fail("not_found", 404, "Manageable subscription not found.");
      if (sub.version !== version) fail("state_conflict", 409, "Refresh the subscription before cancelling.");
      if (!sub.cancel_at_period_end) {
        await c.query("UPDATE subscriptions SET cancel_at_period_end=true,version=version+1 WHERE id=$1", [
          sub.id,
        ]);
        await this.audit(c, userId, "subscription.cancel_at_period_end", sub.id, {
          provider: sub.provider,
          version: sub.version + 1,
        });
      }
      return this.view(c, userId, now);
    });
  }
  async portal(actor: PaymentActor) {
    return transaction(this.billing.db, async (c) => {
      const { userId, now } = await this.owner(c, actor),
        sub = await this.current(c, userId);
      if (!sub || sub.current_period_end <= now)
        return fail("not_found", 404, "Active subscription not found.");
      if (sub.provider !== "stripe")
        throw new AppError("state_conflict", 409, "Manage this PayPal subscription from billing.", {
          management_url: "/billing/subscription",
        });
      return { url: `${this.origin}/billing/subscription`, expires_at: at(now, 300000).toISOString() };
    });
  }
  async payments(actor: PaymentActor, pageSize: number, cursor?: { id: string; createdAt: string }) {
    return transaction(this.billing.db, async (c) => {
      const { userId } = await this.owner(c, actor);
      const rows = (
        await c.query(
          "SELECT id,provider,amount_cents,refunded_cents,state,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00' cursor_created_at FROM payments WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4",
          [userId, cursor?.createdAt ?? null, cursor?.id ?? null, pageSize + 1],
        )
      ).rows;
      return {
        items: rows.slice(0, pageSize).map((r) => ({
          payment_id: r.id,
          provider: r.provider,
          amount_cents: Number(r.amount_cents),
          refunded_cents: Number(r.refunded_cents),
          currency: "USD",
          status: r.state === "confirmed" ? "succeeded" : r.state,
          created_at: iso(r.created_at),
        })),
        next:
          rows.length > pageSize
            ? { id: rows[pageSize - 1].id, createdAt: rows[pageSize - 1].cursor_created_at }
            : null,
      };
    });
  }
}
