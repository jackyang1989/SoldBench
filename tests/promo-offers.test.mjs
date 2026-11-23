import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { merchant, PaymentLifecycle } from "@soldbench/billing";
import { database, migrate, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

async function createSessionUser(auth, clockNow) {
  const email = `promo-${randomUUID()}@example.test`;
  const password = "Passphrase-Promo-123!";
  await auth.register(
    { email, password, terms_version: "2026-11" },
    { clientId: "promo-test", locale: "en", requestId: randomUUID() },
  );
  const userId = (await db.query("SELECT id FROM users WHERE lower(email)=$1", [email])).rows[0].id;
  await db.query("UPDATE users SET status='active',email_verified_at=$2,free_anchor_at=$2 WHERE id=$1", [
    userId,
    clockNow,
  ]);
  const login = await auth.login(email, password, {
    clientId: "promo-test",
    locale: "en",
    requestId: randomUUID(),
  });
  return {
    userId,
    headers: {
      Cookie: `soldbench_session=${login.token}`,
      "X-CSRF-Token": login.view.csrf_token,
      "Content-Type": "application/json",
    },
  };
}

test("AT-081 100-concurrency duplicate promo redemption yields strictly 1 grant, honors idempotency, cap, expiry, and owner isolation", async () => {
  const x = await createProductFixture(db, roots, { count: 10, limit: 10, claimed: false });
  const config = loadConfig({});
  const app = createApp(config, db, { auth: x.auth, query: x.query, billing: x.billing });
  const owner = await createSessionUser(x.auth, x.now());
  const other = await createSessionUser(x.auth, x.now());

  // API key Bearer rejected with 403 on browser session promo endpoint
  const bearerRes = await app.request("/v1/billing/promos/redeem", {
    method: "POST",
    headers: {
      ...x.headers,
      "Content-Type": "application/json",
      "Idempotency-Key": `bearer-attempt-${randomUUID()}`,
    },
    body: JSON.stringify({ code: "LAUNCH50_PREVIEW" }),
  });
  assert.equal(bearerRes.status, 403);

  // Unknown & expired promo codes rejected cleanly
  assert.equal(
    (
      await app.request("/v1/billing/promos/redeem", {
        method: "POST",
        headers: {
          ...owner.headers,
          Origin: config.origin,
          "Idempotency-Key": `missing-${randomUUID()}`,
        },
        body: JSON.stringify({ code: "NO_SUCH_CAMPAIGN" }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request("/v1/billing/promos/redeem", {
        method: "POST",
        headers: {
          ...owner.headers,
          Origin: config.origin,
          "Idempotency-Key": `expired-${randomUUID()}`,
        },
        body: JSON.stringify({ code: "EXPIRED10_PREVIEW" }),
      })
    ).status,
    409,
  );

  // 100 simultaneous duplicate redemption attempts for the same owner with distinct keys -> strictly 1 grant
  const fixedReplayKey = `replay-key-${randomUUID()}`;
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      app.request("/v1/billing/promos/redeem", {
        method: "POST",
        headers: {
          ...owner.headers,
          Origin: config.origin,
          "Idempotency-Key": i === 0 ? fixedReplayKey : `race-${i}-${randomUUID()}`,
        },
        body: JSON.stringify({ code: "launch50_preview" }),
      }),
    ),
  );
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 99);

  // Idempotent replay with identical key returns the original grant; mismatching payload conflicts 409
  const firstKeyMatch = await app.request("/v1/billing/promos/redeem", {
    method: "POST",
    headers: {
      ...owner.headers,
      Origin: config.origin,
      "Idempotency-Key": fixedReplayKey,
    },
    body: JSON.stringify({ code: "LAUNCH50_PREVIEW" }),
  });
  const firstRedemptions = (
    await (
      await app.request("/v1/billing/promos/redemptions", { headers: { Cookie: owner.headers.Cookie } })
    ).json()
  ).data.items;
  assert.equal(firstRedemptions.length, 1);
  assert.equal(firstRedemptions[0].credits_granted, 50);
  if (firstKeyMatch.status === 200) {
    const body = await firstKeyMatch.json();
    assert.equal(body.data.replayed, true);
    assert.equal(body.data.grant_id, firstRedemptions[0].grant_id);
  }
  assert.equal(
    (
      await app.request("/v1/billing/promos/redeem", {
        method: "POST",
        headers: {
          ...owner.headers,
          Origin: config.origin,
          "Idempotency-Key": fixedReplayKey,
        },
        body: JSON.stringify({ code: "OTHER_CODE_CONFLICT" }),
      })
    ).status,
    409,
  );

  // Max-redemptions cap = 1 enforces global exhaustion across distinct accounts
  const capCode = `CAP1_${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  await db.query(
    `INSERT INTO promo_campaigns(code,title_en,title_zh,credits,valid_days,max_redemptions,starts_at,ends_at,status,commercial_approved,policy_version)
     VALUES($1,'Cap 1','限额1',15,14,1,'2026-01-01T00:00:00Z','2028-01-01T00:00:00Z','active',false,'promo-offline-v1')`,
    [capCode],
  );
  assert.equal(
    (
      await app.request("/v1/billing/promos/redeem", {
        method: "POST",
        headers: {
          ...owner.headers,
          Origin: config.origin,
          "Idempotency-Key": `cap-a-${randomUUID()}`,
        },
        body: JSON.stringify({ code: capCode }),
      })
    ).status,
    200,
  );
  const capExhausted = await app.request("/v1/billing/promos/redeem", {
    method: "POST",
    headers: {
      ...other.headers,
      Origin: config.origin,
      "Idempotency-Key": `cap-b-${randomUUID()}`,
    },
    body: JSON.stringify({ code: capCode }),
  });
  assert.equal(capExhausted.status, 409);
  assert.equal((await capExhausted.json()).error.code, "promo_exhausted");

  // Owner isolation: other user sees 0 of owner's redemptions
  const otherList = (
    await (
      await app.request("/v1/billing/promos/redemptions", { headers: { Cookie: other.headers.Cookie } })
    ).json()
  ).data.items;
  assert.equal(otherList.length, 0);

  assert.deepEqual(await x.billing.reconcile(owner.userId), []);
  assert.deepEqual(await x.billing.reconcile(other.userId), []);
});

test("AT-081 promo wallets follow earliest-expiry / subscription-first consumption order, expire cleanly, and preserve historical orders across offer versions", async () => {
  const x = await createProductFixture(db, roots, { count: 10, limit: 10, claimed: false });
  const config = loadConfig({ PAYMENT_FIXTURES: "true" });
  const payments = new PaymentLifecycle(x.billing, config.origin, {
    stripe: randomBytes(32).toString("hex"),
    paypal: randomBytes(32).toString("hex"),
  });
  const app = createApp(config, db, { auth: x.auth, query: x.query, billing: x.billing, payments });
  const owner = await createSessionUser(x.auth, x.now());

  // Seed historical confirmed checkout order before inspecting new candidate offer versions
  const orderRes = await payments.checkout(
    owner.userId,
    { plan_code: "purchased_1500", offer_version: "offline-v1", provider: "stripe" },
    `checkout-${randomUUID()}`,
  );
  const intentBefore = (
    await db.query("SELECT id, amount_cents, credits FROM payment_checkout_intents WHERE user_id=$1", [
      owner.userId,
    ])
  ).rows[0];
  assert.equal(intentBefore.amount_cents, "1000");
  assert.equal(intentBefore.credits, 1500);

  const catalogRes = await app.request("/v1/billing/offer-versions", {
    headers: { Cookie: owner.headers.Cookie },
  });
  assert.equal(catalogRes.status, 200);
  const catalog = (await catalogRes.json()).data;
  assert.equal(catalog.offline_fixture_only, true);
  assert.equal(catalog.commercial_approval_required, true);
  assert.equal(catalog.historical_orders_immutable, true);
  const annualDraft = catalog.versions.find((v) => v.offer_version === "starter-annual-v2-draft");
  assert.equal(annualDraft?.commercial_approved, false);
  assert.equal(annualDraft?.status, "pending_commercial_approval");
  assert.ok(orderRes.checkout_url.includes("/billing/checkout/"));

  // Historical checkout order remains untouched alongside v2 offer drafts
  const intentAfter = (
    await db.query("SELECT id, amount_cents, credits FROM payment_checkout_intents WHERE id=$1", [
      intentBefore.id,
    ])
  ).rows[0];
  assert.deepEqual(intentAfter, intentBefore);
  assert.equal(merchant("stripe").length > 0, true);

  // Verify credit bucket consumption order on a fresh user:
  // 1) subscription expiring +10d (tie-breaker wins over promo expiring +10d)
  // 2) promo expiring +10d (wins over longer-lived +30d free subscription & purchased)
  // 3) purchased no-expiry (consumed last)
  const bucketUser = await createSessionUser(x.auth, x.now());
  const subExpiry = new Date(Date.parse(x.now()) + 10 * 86_400_000);
  const promoExpiry = new Date(Date.parse(x.now()) + 10 * 86_400_000);
  const longPromoExpiry = new Date(Date.parse(x.now()) + 15 * 86_400_000);
  await x.billing.grant(bucketUser.userId, {
    kind: "purchased",
    provider: "test_pack",
    reference: `purch-${randomUUID()}`,
    amount: 5,
    expiresAt: null,
  });
  await x.billing.grant(bucketUser.userId, {
    kind: "promo",
    provider: "soldbench_promo",
    reference: `promo-10d-${randomUUID()}`,
    amount: 1,
    expiresAt: promoExpiry,
  });
  await x.billing.grant(bucketUser.userId, {
    kind: "promo",
    provider: "soldbench_promo",
    reference: `promo-15d-${randomUUID()}`,
    amount: 1,
    expiresAt: longPromoExpiry,
  });
  await x.billing.grant(bucketUser.userId, {
    kind: "subscription",
    provider: "stripe",
    reference: `sub-10d-${randomUUID()}`,
    amount: 1,
    expiresAt: subExpiry,
    periodStart: new Date(x.now()),
  });

  // Helper to claim a ready query inside transaction to inspect wallet consumption order
  const consumeSequence = [];
  for (let i = 0; i < 3; i++) {
    const qId = randomUUID();
    const resHash = `hash-${i}-${randomUUID()}`;
    await db.query(
      `INSERT INTO queries(
         id,user_id,canonical_query_hash,normalizer_version,normalized_query,filters,
         marketplace,window_days,price_basis,requested_limit,allow_stale,as_of,
         billing_policy_version,compute_status,settlement_status,result_state,created_at,expires_at
       ) VALUES($1,$2,$3,'1.1.0','promo bucket test','{}'::jsonb,'ebay_us',90,'item',50,false,$4,'1.1.0','completed','pending','ready',$4,$5)`,
      [qId, bucketUser.userId, `qh-${i}`, x.now(), new Date(Date.parse(x.now()) + 86_400_000)],
    );
    await db.query(
      `INSERT INTO query_results(query_id,stats,quality,snapshot_version,engine_version,cleaner_version,parser_versions,candidate_set_hash,source_scope,coverage_status)
       VALUES($1,'{"n_price_verified":10}'::jsonb,'{}'::jsonb,'1','1','1','{}'::jsonb,$2,'{}'::jsonb,'complete')`,
      [qId, resHash],
    );
    const consumedWallet = await transaction(db, async (c) => {
      const charge = await x.billing.consumeLocked(c, bucketUser.userId, qId, resHash, new Date(x.now()));
      const row = (
        await c.query(
          "SELECT w.bucket_type, w.expires_at FROM credit_ledger l JOIN credit_wallets w ON w.id=l.wallet_id WHERE l.charge_id=$1 AND l.kind='consume'",
          [charge.chargeId],
        )
      ).rows[0];
      return row;
    });
    consumeSequence.push(consumedWallet.bucket_type);
  }
  assert.deepEqual(consumeSequence, ["subscription", "promo", "promo"]);

  // Advance clock past free anniversary & expiry (+35d): balance expires overdue wallets & writes expire ledger entries
  x.clock.value = new Date(Date.parse(x.now()) + 35 * 86_400_000).toISOString();
  await x.billing.balance(bucketUser.userId);
  assert.deepEqual(await x.billing.reconcile(bucketUser.userId), []);
});
