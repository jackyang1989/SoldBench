import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createApp } from "@soldbench/api";
import { AuthService, newAuthSecrets } from "@soldbench/auth";
import {
  BillingService,
  fixtureSignature,
  localPaymentKeys,
  merchant,
  offerVersion,
  PaymentLifecycle,
} from "@soldbench/billing";
import { normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  fixtureKeys = { stripe: randomBytes(32).toString("hex"), paypal: randomBytes(32).toString("hex") },
  config = loadConfig({ PAYMENT_FIXTURES: "true" });
before(() => migrate(db));
after(() => db.end());
function fixture() {
  const clock = { now: new Date("2026-10-01T09:00:00.000Z") },
    now = () => clock.now.toISOString(),
    billing = new BillingService(db, now),
    auth = new AuthService(db, newAuthSecrets(), config.origin, now),
    payments = new PaymentLifecycle(billing, config.origin, fixtureKeys),
    app = createApp(config, db, { auth, payments });
  return { clock, now, billing, auth, payments, app };
}
async function user(x, { free = true } = {}) {
  const now = x.now(),
    token = x.auth.crypto.token("sb_s_"),
    csrf = x.auth.crypto.hash("auth.csrf", token);
  const owner = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$3) RETURNING id",
      [`payment-${randomUUID()}@example.test`, now, free ? now : null],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)",
    [
      owner,
      x.auth.crypto.hash("auth.session", token),
      x.auth.crypto.hash("auth.csrf-store", csrf),
      now,
      "2027-01-01T00:00:00Z",
    ],
  );
  return {
    owner,
    headers: {
      Cookie: `soldbench_session=${token}`,
      Origin: config.origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
  };
}
const terms = (provider, plan_code = "starter") => ({ provider, plan_code, offer_version: offerVersion });
const checkoutId = (r) => new URL(r.checkout_url).pathname.split("/").at(-1);
function tx(x, provider, id, options = {}) {
  return {
    provider,
    merchant: merchant(provider),
    environment: "offline_fixture",
    checkout_id: id,
    object_id: `tx_${randomUUID()}`,
    revision: 1,
    kind: "transaction",
    status: "confirmed",
    amount_cents: 1000,
    currency: "USD",
    paid_at: x.now(),
    subscription_id: null,
    period_start: null,
    period_end: null,
    ...options,
  };
}
const counts = async (owner) => {
  const r = (
    await db.query(
      "SELECT (SELECT count(*) FROM payments WHERE user_id=$1)::int p,(SELECT count(*) FROM credit_grants WHERE user_id=$1 AND payment_id IS NOT NULL)::int g,(SELECT count(*) FROM subscriptions WHERE user_id=$1)::int s",
      [owner],
    )
  ).rows[0];
  return r;
};
function signed(x, fact, type, options = {}) {
  const {
      provider = fact.provider,
      eventId = randomUUID(),
      key = fixtureKeys[provider],
      time = x.clock.now,
      ...patch
    } = options,
    body = Buffer.from(
      JSON.stringify({
        id: eventId,
        type,
        merchant: fact.merchant,
        environment: fact.environment,
        object_id: fact.object_id,
        revision: fact.revision,
        ...patch,
      }),
    );
  return {
    eventId,
    body,
    provider,
    headers: {
      Host: new URL(config.origin).host,
      "Content-Type": "application/json",
      ...fixtureSignature(provider, key, body, time),
    },
  };
}
const deliver = (x, r) =>
  x.app.request(`/webhooks/${r.provider}`, { method: "POST", headers: r.headers, body: r.body });
const post = (x, u, path, value, key = randomUUID()) =>
  x.app.request(path, {
    method: "POST",
    headers: { ...u.headers, "Idempotency-Key": key },
    body: JSON.stringify(value),
  });
async function confirm(x, fact, type) {
  await x.payments.stageFixture(fact);
  assert.equal((await deliver(x, signed(x, fact, type))).status, 200);
  return x.payments.workOnce();
}
const month = (date) => new Date(date).toISOString();

test("an authorized operator restores a late offline confirmation once from the original verified notification", async (t) => {
  const x = fixture(),
    customer = await user(x),
    operator = await user(x),
    support = await user(x);
  const root = await mkdtemp(join(tmpdir(), "soldbench-payment-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const query = new QueryService(db, x.auth, x.billing, new PrivateMediaStore(root), x.now);
  x.app = createApp(config, db, { auth: x.auth, payments: x.payments, query });
  for (const [account, role] of [
    [operator, "admin"],
    [support, "support"],
  ]) {
    await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,$2)", [account.owner, role]);
    if (role === "admin")
      await db.query(
        "INSERT INTO user_mfa(user_id,encrypted_secret,state,enabled_at,updated_at) VALUES($1,$2,'enabled',$3,$3)",
        [account.owner, x.auth.crypto.seal("TEST_ONLY", account.owner), x.now()],
      );
  }
  const delayed = async (owner) => {
    const id = checkoutId(await x.payments.checkout(owner, terms("stripe", "purchased_1500"), randomUUID()));
    const fact = tx(x, "stripe", id);
    assert.equal((await deliver(x, signed(x, fact, "payment_intent_succeeded"))).status, 200);
    let ended;
    for (let i = 0; i < 12; i++) {
      ended = await x.payments.workOnce();
      assert.equal(ended.status, i < 11 ? "retryable" : "failed");
      if (i < 11) x.clock.now = new Date(x.clock.now.getTime() + Math.min(30 * 2 ** i, 3600) * 1000 + 1);
    }
    return { fact, eventId: ended.eventId, endpoint: `/admin/payments/events/${ended.eventId}/replay` };
  };
  const { fact, eventId, endpoint } = await delayed(customer.owner);
  const payload = { reason: "Review delayed synthetic confirmation", case_reference: "test-01" };
  await db.query("UPDATE sessions SET authenticated_at=$2,mfa_at=$2 WHERE user_id=$1", [
    operator.owner,
    x.now(),
  ]);
  const key = randomUUID();
  const recoveryList = (target, account) =>
    target.app.request("/admin/recovery", { headers: account.headers });
  assert.equal((await recoveryList(x, support)).status, 403);
  const listed = await recoveryList(x, operator);
  assert.match(listed.headers.get("Cache-Control"), /private, no-store/);
  const recovery = await listed.json();
  assert.deepEqual(
    recovery.data.items.map((row) => row.id),
    [eventId],
  );
  assert.ok(!JSON.stringify(recovery).includes(fact.object_id));
  assert.equal((await post(x, support, endpoint, payload)).status, 403);
  assert.equal((await post(x, operator, endpoint, payload, key)).status, 409);
  await x.payments.stageFixture(fact);
  const replies = await Promise.all(
    Array.from({ length: 10 }, () => post(x, operator, endpoint, payload, key)),
  );
  assert.ok(replies.every((response) => response.status === 202));
  const states = await Promise.all(replies.map((response) => response.json()));
  const first = states[0];
  assert.equal(first.data.outcome, "applied");
  assert.deepEqual((await (await recoveryList(x, operator)).json()).data.items, []);
  for (const state of states) assert.deepEqual(state.data, first.data);
  assert.deepEqual(await counts(customer.owner), { p: 1, g: 1, s: 0 });
  assert.equal((await (await post(x, operator, endpoint, payload)).json()).data.outcome, "already_applied");
  assert.equal(
    (await post(x, operator, endpoint, { ...payload, reason: "different command" }, key)).status,
    409,
  );
  const event = (await db.query("SELECT status,fixture_attempts FROM payment_events WHERE id=$1", [eventId]))
    .rows[0];
  assert.deepEqual(event, { status: "applied", fixture_attempts: 12 });
  const diff = (await db.query("SELECT safe_diff FROM audit_events WHERE id=$1", [first.data.audit_id]))
    .rows[0].safe_diff;
  assert.equal(diff.attempts, 12);
  assert.equal(diff.prior_status, "failed");
  assert.equal(diff.prior_error, "confirmation_pending");
  assert.ok(diff.case_hash);
  assert.ok(!JSON.stringify(diff).includes(payload.case_reference));
  execFileSync("python3", ["tests/validate-response.py"], {
    input: JSON.stringify([
      ["PaymentReplayResponse", first],
      ["AdminRecoveryResponse", recovery],
    ]),
  });
  const deleted = await user(x),
    review = await delayed(deleted.owner);
  await db.query("UPDATE users SET status='deleted' WHERE id=$1", [deleted.owner]);
  await x.payments.stageFixture(review.fact);
  await db.query("UPDATE sessions SET authenticated_at=$2,mfa_at=$2 WHERE user_id=$1", [
    operator.owner,
    x.now(),
  ]);
  const refusal = await (await post(x, operator, review.endpoint, payload)).json();
  assert.equal(refusal.data.outcome, "manual_review");
  assert.deepEqual(await counts(deleted.owner), { p: 0, g: 0, s: 0 });
  const reviewLog = (
    await db.query("SELECT safe_diff FROM audit_events WHERE id=$1", [refusal.data.audit_id])
  ).rows[0].safe_diff;
  assert.equal(reviewLog.reason, "owner_not_active");
  const off = { ...x, app: createApp(loadConfig({}), db, { auth: x.auth, query, payments: x.payments }) };
  assert.equal((await post(off, operator, review.endpoint, payload)).status, 503);
  assert.deepEqual((await (await recoveryList(off, operator)).json()).data, {
    payment_fixtures_enabled: false,
    items: [],
    next_cursor: null,
  });
});

test("100 cross-channel subscription requests create one pending intent, with exact replay and independent credit packs", async () => {
  const x = fixture(),
    u = await user(x);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, (_, i) =>
      x.payments.checkout(
        u.owner,
        terms(i % 2 ? "paypal" : "stripe"),
        `checkout-test-${i.toString().padStart(3, "0")}`,
      ),
    ),
  );
  const wins = outcomes.flatMap((r, i) => (r.status === "fulfilled" ? [{ id: i, value: r.value }] : []));
  assert.equal(wins.length, 1);
  const { id, value } = wins[0],
    key = `checkout-test-${id.toString().padStart(3, "0")}`;
  assert.ok(outcomes.every((r) => r.status === "fulfilled" || r.reason.code === "state_conflict"));
  assert.deepEqual(await x.payments.checkout(u.owner, terms(value.provider), key), value);
  await assert.rejects(
    x.payments.checkout(u.owner, terms(value.provider, "pro"), key),
    (e) => e.code === "idempotency_conflict",
  );
  const other = await user(x);
  assert.equal(
    (await x.app.request(new URL(value.checkout_url).pathname, { headers: other.headers })).status,
    404,
  );
  assert.equal(
    (await x.app.request(new URL(value.checkout_url).pathname, { headers: u.headers })).status,
    200,
  );
  assert.equal(
    (await post(x, u, "/billing/checkout", { ...terms("stripe", "purchased_1500"), amount_cents: 1 })).status,
    400,
  );
  assert.equal(
    (
      await post(
        x,
        { headers: { ...u.headers, Origin: "http://127.0.0.1:9999" } },
        "/billing/checkout",
        terms("stripe"),
      )
    ).status,
    403,
  );
  const packs = await Promise.all(
    ["stripe", "paypal"].map((p) => x.payments.checkout(u.owner, terms(p, "purchased_1500"), randomUUID())),
  );
  assert.notEqual(checkoutId(packs[0]), checkoutId(packs[1]));
  assert.deepEqual(await counts(u.owner), { p: 0, g: 0, s: 0 });
});

test("signed receipts persist before ack, reject wrong routes/keys/payloads and recover delayed channel facts", async () => {
  const x = fixture(),
    u = await user(x),
    id = checkoutId(await x.payments.checkout(u.owner, terms("stripe", "purchased_1500"), randomUUID())),
    fact = tx(x, "stripe", id),
    good = signed(x, fact, "payment_intent_succeeded");
  const disabled = createApp(loadConfig({}), db, { auth: x.auth, payments: x.payments });
  assert.equal(
    (await disabled.request("/webhooks/stripe", { method: "POST", headers: good.headers, body: good.body }))
      .status,
    503,
  );
  assert.equal(
    (await deliver(x, signed(x, fact, "payment_intent_succeeded", { key: fixtureKeys.paypal }))).status,
    401,
  );
  assert.equal(
    (
      await deliver(
        x,
        signed(x, fact, "payment_intent_succeeded", { time: new Date(Date.parse(x.now()) - 301000) }),
      )
    ).status,
    401,
  );
  assert.equal((await deliver(x, { ...good, provider: "paypal" })).status, 401);
  assert.equal(
    (await deliver(x, { ...good, body: Buffer.concat([good.body, Buffer.from(" ")]) })).status,
    401,
  );
  assert.equal(
    (await deliver(x, { ...good, headers: { ...good.headers, Host: "fixture.invalid" } })).status,
    403,
  );
  assert.equal(
    (await deliver(x, signed(x, fact, "payment_intent_succeeded", { environment: "production" }))).status,
    400,
  );
  assert.equal((await x.app.request("/webhooks/dodo", { method: "POST" })).status, 503);
  assert.equal((await deliver(x, good)).status, 200);
  assert.equal((await deliver(x, good)).status, 200);
  assert.equal(
    (await deliver(x, signed(x, fact, "payment_intent_succeeded", { eventId: good.eventId, revision: 2 })))
      .status,
    409,
  );
  assert.equal(
    (await db.query("SELECT status FROM payment_events WHERE provider_event_id=$1", [good.eventId])).rows[0]
      .status,
    "received",
  );
  assert.deepEqual(await counts(u.owner), { p: 0, g: 0, s: 0 });
  assert.equal((await x.payments.workOnce()).reason, "confirmation_pending");
  await x.payments.stageFixture(fact);
  x.clock.now = new Date(Date.parse(x.now()) + 31000);
  assert.equal((await x.payments.workOnce()).status, "applied");
  assert.deepEqual(await counts(u.owner), { p: 1, g: 1, s: 0 });
  assert.equal((await confirm(x, fact, "payment_intent_succeeded")).status, "applied");
  assert.deepEqual(await counts(u.owner), { p: 1, g: 1, s: 0 });
  assert.deepEqual(await x.billing.reconcile(u.owner), []);
});

test("both channels grant one subscription per cycle, retain remaining purchase credit and honor cancellation", async () => {
  for (const provider of ["stripe", "paypal"]) {
    const x = fixture(),
      u = await user(x),
      subId = checkoutId(await x.payments.checkout(u.owner, terms(provider), randomUUID())),
      packageId = checkoutId(
        await x.payments.checkout(u.owner, terms(provider, "purchased_1500"), randomUUID()),
      ),
      purchase = tx(x, provider, packageId),
      cycle = tx(x, provider, subId, {
        amount_cents: 900,
        subscription_id: `sub_${randomUUID()}`,
        period_start: month("2026-10-01"),
        period_end: month("2026-11-01"),
      }),
      type = provider === "stripe" ? "invoice_paid" : "sale_completed";
    assert.equal((await x.billing.balance(u.owner)).available_credits, 100);
    assert.equal(
      (await confirm(x, purchase, provider === "stripe" ? "payment_intent_succeeded" : "capture_completed"))
        .status,
      "applied",
    );
    assert.equal((await confirm(x, cycle, type)).status, "applied");
    assert.equal((await x.billing.balance(u.owner)).available_credits, 3500);
    assert.equal(
      (await confirm(x, { ...cycle, object_id: `tx_${randomUUID()}` }, type)).reason,
      "duplicate_payment_cycle",
    );
    assert.deepEqual(await counts(u.owner), { p: 2, g: 2, s: 1 });
    assert.equal(await x.payments.subscription(u.owner).then((r) => r.status), "active");
    assert.equal((await post(x, u, "/billing/portal", {})).status, provider === "stripe" ? 200 : 409);
    x.clock.now = new Date("2026-11-01T09:00:00Z");
    const renewal = {
      ...cycle,
      object_id: `tx_${randomUUID()}`,
      paid_at: x.now(),
      period_start: month("2026-11-01"),
      period_end: month("2026-12-01"),
    };
    assert.equal((await confirm(x, renewal, type)).status, "applied");
    assert.equal((await x.billing.balance(u.owner)).available_credits, 3500);
    assert.equal((await post(x, u, "/billing/cancel", { version: 1 })).status, 409);
    assert.equal((await post(x, u, "/billing/cancel", { version: 2 })).status, 200);
    assert.equal((await x.billing.balance(u.owner)).available_credits, 3500);
    x.clock.now = new Date("2026-12-01T09:00:00Z");
    const denied = {
      ...renewal,
      object_id: `tx_${randomUUID()}`,
      paid_at: x.now(),
      period_start: month("2026-12-01"),
      period_end: month("2027-01-01"),
    };
    assert.equal((await confirm(x, denied, type)).reason, "subscription_cancelled_for_next_period");
    assert.equal((await x.billing.balance(u.owner)).available_credits, 1600);
    assert.equal(await x.payments.subscription(u.owner).then((r) => r.status), "free");
    assert.deepEqual(await counts(u.owner), { p: 3, g: 3, s: 1 });
    assert.deepEqual(await x.billing.reconcile(u.owner), []);
    assert.equal(
      (await x.payments.checkout(u.owner, terms(provider === "stripe" ? "paypal" : "stripe"), randomUUID()))
        .provider,
      provider === "stripe" ? "paypal" : "stripe",
    );
  }
});

test("refund before success and disputes never mint twice, and payment cursors cannot cross owners", async () => {
  const x = fixture(),
    u = await user(x, { free: false }),
    stranger = await user(x),
    id = checkoutId(await x.payments.checkout(u.owner, terms("paypal", "purchased_1500"), randomUUID())),
    fact = tx(x, "paypal", id);
  assert.equal(
    (await confirm(x, { ...fact, revision: 2, status: "refunded" }, "capture_refunded")).status,
    "applied",
  );
  assert.equal((await confirm(x, fact, "capture_completed")).status, "applied");
  assert.deepEqual(await counts(u.owner), { p: 1, g: 0, s: 0 });
  const paid = tx(
    x,
    "stripe",
    checkoutId(await x.payments.checkout(u.owner, terms("stripe", "purchased_1500"), randomUUID())),
  );
  assert.equal((await confirm(x, paid, "payment_intent_succeeded")).status, "applied");
  assert.equal(
    (await confirm(x, { ...paid, status: "disputed", revision: 2 }, "dispute_changed")).status,
    "applied",
  );
  assert.equal((await x.payments.subscription(u.owner)).credit_recovery_open, true);
  assert.equal((await confirm(x, { ...paid, revision: 3 }, "dispute_changed")).status, "applied");
  assert.equal((await x.payments.subscription(u.owner)).credit_recovery_open, false);
  assert.equal((await x.billing.balance(u.owner)).available_credits, 1500);
  assert.equal(
    (await confirm(x, { ...paid, status: "refunded", revision: 4 }, "charge_refunded")).status,
    "applied",
  );
  assert.equal((await x.billing.balance(u.owner)).available_credits, 0);
  assert.equal((await confirm(x, { ...paid, revision: 5 }, "payment_intent_succeeded")).status, "applied");
  assert.equal((await x.billing.balance(u.owner)).available_credits, 0);
  assert.deepEqual(await counts(u.owner), { p: 2, g: 1, s: 0 });
  const first = (await (await x.app.request("/billing/payments?page_size=1", { headers: u.headers })).json())
    .data;
  assert.equal(first.items.length, 1);
  assert.ok(first.items[0].payment_id && !JSON.stringify(first.items).includes(paid.object_id));
  const page = `/billing/payments?page_size=1&cursor=${first.next_cursor}`;
  assert.equal((await x.app.request(page, { headers: stranger.headers })).status, 400);
  const second = (await (await x.app.request(page, { headers: u.headers })).json()).data;
  assert.notEqual(first.items[0].payment_id, second.items[0].payment_id);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(await x.billing.reconcile(u.owner), []);
});

test("an elapsed checkout remains blocked until the scoped expiry confirmation is processed", async () => {
  const x = fixture(),
    u = await user(x),
    old = checkoutId(await x.payments.checkout(u.owner, terms("stripe"), randomUUID()));
  x.clock.now = new Date(Date.parse(x.now()) + 3600000);
  await assert.rejects(
    x.payments.checkout(u.owner, terms("paypal"), randomUUID()),
    (e) => e.code === "state_conflict",
  );
  const expiry = {
    provider: "stripe",
    merchant: merchant("stripe"),
    environment: "offline_fixture",
    checkout_id: old,
    object_id: old,
    revision: 1,
    kind: "checkout_expired",
    checked_at: x.now(),
  };
  assert.equal((await confirm(x, expiry, "checkout_expired")).status, "applied");
  assert.equal((await x.payments.checkout(u.owner, terms("paypal"), randomUUID())).provider, "paypal");
});

test("provider and amount mismatch leave the wallet untouched", async () => {
  const x = fixture(),
    u = await user(x),
    id = checkoutId(await x.payments.checkout(u.owner, terms("stripe", "purchased_1500"), randomUUID()));
  assert.equal(
    (await confirm(x, tx(x, "paypal", id), "capture_completed")).reason,
    "checkout_scope_mismatch",
  );
  assert.equal(
    (await confirm(x, tx(x, "stripe", id, { amount_cents: 10 }), "payment_intent_succeeded")).reason,
    "transaction_terms_mismatch",
  );
  assert.deepEqual(await counts(u.owner), { p: 0, g: 0, s: 0 });
});

test("a failed receipt cannot acknowledge, and a failed projection rolls payment, grant and ledger back together", async () => {
  const x = fixture(),
    u = await user(x, { free: false }),
    id = checkoutId(await x.payments.checkout(u.owner, terms("stripe", "purchased_1500"), randomUUID())),
    fact = tx(x, "stripe", id),
    delivery = signed(x, fact, "payment_intent_succeeded");
  await x.payments.stageFixture(fact);
  await db.query(
    "CREATE FUNCTION payment_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated_payment_database_failure'; END; $$",
  );
  try {
    await db.query(
      "CREATE TRIGGER payment_fail_receipt BEFORE INSERT ON payment_events FOR EACH ROW EXECUTE FUNCTION payment_test_fail()",
    );
    assert.equal((await deliver(x, delivery)).status, 503);
    assert.equal(
      (
        await db.query("SELECT count(*)::int n FROM payment_events WHERE provider_event_id=$1", [
          delivery.eventId,
        ])
      ).rows[0].n,
      0,
    );
    await db.query("DROP TRIGGER payment_fail_receipt ON payment_events");
    assert.equal((await deliver(x, delivery)).status, 200);
    await db.query(
      "CREATE TRIGGER payment_fail_commit BEFORE UPDATE ON payment_events FOR EACH ROW WHEN (NEW.status='applied') EXECUTE FUNCTION payment_test_fail()",
    );
    await assert.rejects(x.payments.workOnce(), /simulated_payment_database_failure/);
    assert.deepEqual(await counts(u.owner), { p: 0, g: 0, s: 0 });
    assert.equal((await x.billing.balance(u.owner)).available_credits, 0);
    assert.equal(
      (await db.query("SELECT status FROM payment_events WHERE provider_event_id=$1", [delivery.eventId]))
        .rows[0].status,
      "received",
    );
  } finally {
    await db.query("DROP FUNCTION payment_test_fail() CASCADE");
  }
  assert.equal((await x.payments.workOnce()).status, "applied");
  assert.deepEqual(await counts(u.owner), { p: 1, g: 1, s: 0 });
  assert.equal((await x.billing.balance(u.owner)).available_credits, 1500);
  assert.deepEqual(await x.billing.reconcile(u.owner), []);
});

test("an open dispute stops new claims and a full refund records recovery without rewriting prior charges", async () => {
  const roots = [];
  try {
    const x = await createProductFixture(db, roots, { claimed: false });
    await db.query("UPDATE users SET free_anchor_at=NULL WHERE id=$1", [x.user]);
    const payments = new PaymentLifecycle(x.billing, config.origin, fixtureKeys);
    const ctx = {
      ...x,
      payments,
      clock: { now: new Date(x.now()) },
      app: createApp(config, db, { auth: x.auth, payments }),
    };
    const intent = await payments.checkout(x.user, terms("paypal", "purchased_1500"), randomUUID()),
      fact = tx(ctx, "paypal", checkoutId(intent));
    assert.equal((await confirm(ctx, fact, "capture_completed")).status, "applied");
    const first = await x.query.result(x.identity, x.queryId, randomUUID(), true, randomUUID());
    assert.equal(first.meta.credits_charged, 1);
    assert.equal((await x.billing.balance(x.user)).available_credits, 1499);
    const another = await x.query.submit(
      x.identity,
      normalizeQuery(new URLSearchParams({ q: x.q.q, limit: "10" })),
    );
    await x.query.workOnce("payment-integration");
    assert.equal(
      (await confirm(ctx, { ...fact, revision: 2, status: "disputed" }, "dispute_changed")).status,
      "applied",
    );
    assert.equal((await x.query.usage(x.identity)).credit_recovery_open, true);
    await assert.rejects(
      x.query.result(x.identity, another.queryId, randomUUID(), true, randomUUID()),
      (e) => e.code === "credit_recovery_required",
    );
    assert.equal(
      (await confirm(ctx, { ...fact, revision: 3, status: "refunded" }, "capture_refunded")).status,
      "applied",
    );
    assert.equal((await x.billing.balance(x.user)).recovery_credits, 1);
    assert.equal((await x.billing.balance(x.user)).available_credits, 0);
    assert.deepEqual(await x.billing.reconcile(x.user), []);
    assert.equal((await x.query.result(x.identity, x.queryId, randomUUID())).meta.credits_charged, 0);
    assert.equal(
      (await db.query("SELECT state FROM billing_charges WHERE query_id=$1", [x.queryId])).rows[0].state,
      "charged",
    );
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("the real dev launcher, private fixture CLI and query worker settle a PayPal simulation", async () => {
  const root = await mkdtemp(join(tmpdir(), "soldbench-payment-cli-"));
  const socket = createServer();
  await new Promise((done) => socket.listen(0, "127.0.0.1", done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const origin = `http://127.0.0.1:${port}`,
    env = {
      ...process.env,
      PAYMENT_FIXTURES: "true",
      PORT: String(port),
      HOST: "127.0.0.1",
      APP_ORIGIN: origin,
      LOCAL_STATE_ROOT: root,
      MEDIA_ROOT: join(root, "media"),
    },
    run = promisify(execFile);
  let dev, devClosed;
  try {
    const init = await run(process.execPath, ["scripts/payment-fixture.mjs", "init"], {
      env,
      timeout: 10000,
    });
    assert.equal(JSON.parse(init.stdout).ready, true);
    assert.equal((await stat(join(root, "payment-fixture-keys.json"))).mode & 0o777, 0o600);
    const keys = localPaymentKeys(root),
      x = fixture(),
      u = await user(x, { free: false }),
      now = new Date(),
      lifecycle = new PaymentLifecycle(new BillingService(db), origin, keys),
      id = checkoutId(await lifecycle.checkout(u.owner, terms("paypal", "purchased_1500"), randomUUID()));
    assert.ok(!init.stdout.includes(keys.paypal));
    const file = join(root, "confirmation.json");
    // Reuse the actual intent creation time so the provider's paid_at never precedes it.
    const created = (await db.query("SELECT created_at FROM payment_checkout_intents WHERE id=$1", [id]))
      .rows[0].created_at;
    const fact = {
      ...tx({ now: () => new Date(Math.max(now.getTime(), created.getTime())).toISOString() }, "paypal", id),
      event_type: "capture_completed",
    };
    await writeFile(file, JSON.stringify(fact), { mode: 0o600 });
    dev = spawn(process.execPath, ["scripts/dev.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    dev.stdout.on("data", (bytes) => {
      logs += bytes;
    });
    dev.stderr.on("data", (bytes) => {
      logs += bytes;
    });
    devClosed = new Promise((done) => dev.once("close", done));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${origin}/ready`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(ready, true);
    const result = await run(process.execPath, ["scripts/payment-fixture.mjs", "deliver", file], {
      env,
      timeout: 15000,
    });
    assert.equal(JSON.parse(result.stdout).receipt_status, 200);
    assert.ok(!result.stdout.includes(keys.paypal));
    for (let i = 0; i < 80; i++) {
      if ((await counts(u.owner)).g === 1) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.deepEqual(await counts(u.owner), { p: 1, g: 1, s: 0 });
    assert.ok(!logs.includes(keys.paypal));
  } finally {
    if (dev) {
      dev.kill("SIGTERM");
      await devClosed;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("an early first-cycle refund keeps subscription identity and permits a later confirmed cycle", async () => {
  const x = fixture(),
    u = await user(x, { free: false }),
    id = checkoutId(await x.payments.checkout(u.owner, terms("paypal"), randomUUID())),
    first = tx(x, "paypal", id, {
      amount_cents: 900,
      subscription_id: `sub_${randomUUID()}`,
      period_start: month("2026-10-01"),
      period_end: month("2026-11-01"),
    });
  assert.equal(
    (await confirm(x, { ...first, revision: 2, status: "refunded" }, "capture_refunded")).status,
    "applied",
  );
  assert.equal((await confirm(x, first, "sale_completed")).status, "applied");
  assert.deepEqual(await counts(u.owner), { p: 1, g: 0, s: 1 });
  assert.equal(await x.payments.subscription(u.owner).then((r) => r.status), "past_due");
  x.clock.now = new Date("2026-11-01T09:00:00Z");
  const next = {
    ...first,
    object_id: `tx_${randomUUID()}`,
    paid_at: x.now(),
    period_start: month("2026-11-01"),
    period_end: month("2026-12-01"),
  };
  assert.equal((await confirm(x, next, "sale_completed")).status, "applied");
  assert.deepEqual(await counts(u.owner), { p: 2, g: 1, s: 1 });
  assert.equal((await x.billing.balance(u.owner)).available_credits, 2000);
  assert.equal(await x.payments.subscription(u.owner).then((r) => r.status), "active");
});

test("a revoked session cannot enter the owner transaction after initial HTTP authentication", async () => {
  const x = fixture(),
    u = await user(x),
    authenticate = x.auth.sessionIdentity.bind(x.auth);
  x.auth.sessionIdentity = async (...args) => {
    const identity = await authenticate(...args);
    await db.query("UPDATE sessions SET revoked_at=$2 WHERE id=$1", [identity.sessionId, x.now()]);
    return identity;
  };
  const cancelled = await post(x, u, "/billing/checkout", terms("stripe"));
  assert.equal(cancelled.status, 401);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM payment_checkout_intents WHERE user_id=$1", [u.owner]))
      .rows[0].n,
    0,
  );
  const read = await user(x);
  assert.equal((await x.app.request("/billing/payments", { headers: read.headers })).status, 401);
});

test("an unrepresentable fact date cannot poison payment processing", async () => {
  const x = fixture(),
    u = await user(x),
    id = checkoutId(await x.payments.checkout(u.owner, terms("stripe"), randomUUID())),
    first = tx(x, "stripe", id, {
      amount_cents: 900,
      subscription_id: `sub_${randomUUID()}`,
      period_start: month("2026-10-01"),
      period_end: month("2026-11-01"),
    });
  await assert.rejects(
    x.payments.stageFixture({ ...first, period_start: "0000-01-01T00:00:00Z" }),
    /Unsupported date/,
  );
  assert.equal((await confirm(x, first, "invoice_paid")).status, "applied");
  assert.deepEqual(await counts(u.owner), { p: 1, g: 1, s: 1 });
});
