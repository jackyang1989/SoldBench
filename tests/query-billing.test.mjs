import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { AuthService, newAuthSecrets } from "@soldbench/auth";
import { BillingService, freePeriod } from "@soldbench/billing";
import {
  CollectorStore,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
  provisionFixtureSource,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService, safeCsvCell } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";

const db = database(process.env.DATABASE_URL),
  roots = [],
  golden = JSON.parse(readFileSync("v14_gameboy_58_verified.json"));
before(() => migrate(db));
after(async () => {
  await db.end();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
async function setup({ count = 58, retentionDays = 7, gold = false, images = false } = {}) {
  const clock = { value: gold ? golden.as_of : "2026-11-17T12:00:00.000Z" },
    now = () => clock.value,
    config = loadConfig({}),
    auth = new AuthService(db, newAuthSecrets(), config.origin, now),
    billing = new BillingService(db, now),
    root = await mkdtemp(join(tmpdir(), "soldbench-query-"));
  roots.push(root);
  const media = new PrivateMediaStore(root),
    queries = new QueryService(db, auth, billing, media, now),
    source = await provisionFixtureSource(db, now(), { retentionDays }),
    store = new CollectorStore(db, now),
    q = normalizeQuery(new URLSearchParams({ q: `fixture ${randomUUID()}` }));
  const hash = collectionQueryHash(q),
    _job = await store.enqueue({ ...source, queryHash: hash, runKey: randomUUID(), asOf: now() });
  const rows = gold
    ? golden.candidate_records.map((r, i) => ({
        listingId: r.listing_id ?? `gold-${i}`,
        title: r.title ?? `Synthetic ${i}`,
        candidate: {
          sourceId: source.sourceId,
          eventKey: r.sale_event_id,
          identityVerified: true,
          comparable: r.is_comparable,
          priceStatus: r.sale_price_status,
          format: r.sale_format,
          currency: r.currency ?? "XXX",
          itemCents: r.item_price_cents ?? null,
          shippingCents: r.observed_shipping_cents ?? null,
          shippingStatus: r.observed_shipping_status,
          time: { precision: "instant", value: r.sold_at },
        },
      }))
    : Array.from({ length: count }, (_, i) => ({
        listingId: `item-${i}`,
        title: `Synthetic ${i}`,
        candidate: {
          sourceId: source.sourceId,
          eventKey: `event-${i}`,
          identityVerified: true,
          comparable: true,
          priceStatus: "verified_actual",
          format: "fixed_price",
          currency: "USD",
          itemCents: 1000 + i,
          shippingCents: 0,
          shippingStatus: "verified_free_shipping",
          time: { precision: "instant", value: now() },
          title: `Synthetic ${i}`,
        },
      }));
  const frames = new Map();
  for (let i = 0; i < Math.max(1, Math.ceil(rows.length / 50)); i++) {
    const cursor = i === 0 ? "start" : `p${i}`;
    frames.set(`page:${cursor}`, [
      fixtureResponse({
        schema: "soldbench.synthetic-page.v1",
        synthetic: true,
        sourceId: source.sourceId,
        queryHash: hash,
        cursor,
        nextCursor: (i + 1) * 50 < rows.length ? `p${i + 1}` : null,
        asOf: now(),
        empty: !rows.length,
        records: rows.slice(i * 50, (i + 1) * 50),
      }),
    ]);
  }
  if (images && rows.length) {
    const url = "https://images.example.test/primary.png";
    rows[0].primaryImage = { role: "primary", url };
    const p = frames.get("page:start");
    p[0] = fixtureResponse({
      schema: "soldbench.synthetic-page.v1",
      synthetic: true,
      sourceId: source.sourceId,
      queryHash: hash,
      cursor: "start",
      nextCursor: rows.length > 50 ? "p1" : null,
      asOf: now(),
      empty: false,
      records: rows.slice(0, 50),
    });
    frames.set(`image:${url}`, [
      {
        status: 200,
        contentType: "image/png",
        bytes: await sharp({ create: { width: 24, height: 16, channels: 3, background: "#654321" } })
          .png()
          .toBuffer(),
      },
    ]);
  }
  const result = await new OfflineCollectorWorker(store, new FixtureTransport(frames), media).runOne(
    source.sourceId,
  );
  assert.equal(result.status, "completed");
  const user = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'not-a-password','active',$2,$2) RETURNING *",
      [`query-${randomUUID()}@example.test`, now()],
    )
  ).rows[0];
  // A real opaque session is created by login in auth tests; here API keys exercise authentication without slow password hashing.
  const secret = auth.crypto.token("sb_k_"),
    key = (
      await db.query(
        "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'test',$2,'sb_k_test',$3) RETURNING id",
        [user.id, auth.crypto.hash("auth.api-key", secret), ["sold:read", "jobs:read", "usage:read"]],
      )
    ).rows[0].id;
  const identity = await auth.keyIdentity(secret, "sold:read"),
    app = createApp(config, db, { auth, query: queries });
  return {
    db,
    clock,
    now,
    auth,
    billing,
    queries,
    media,
    source,
    store,
    q,
    user,
    identity,
    secret,
    key,
    app,
    config,
  };
}
async function ready(x, query = x.q) {
  const r = await x.queries.submit(x.identity, query);
  const work = await x.queries.workOnce(randomUUID());
  assert.equal(work.status, "completed", JSON.stringify(work));
  return r;
}
const request = (x, path, options = {}) =>
  x.app.request(path, { ...options, headers: { Authorization: `Bearer ${x.secret}`, ...options.headers } });
async function browserIdentity(x, account = x.user) {
  const token = x.auth.crypto.token("sb_s_");
  const csrf = x.auth.crypto.hash("auth.csrf", token);
  await db.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_hash,credential_version,mfa_pending,expires_at,authenticated_at,created_at) SELECT id,$2,$3,credential_version,false,$4::timestamptz + interval '1 day',$4,$4 FROM users WHERE id=$1",
    [
      account.id,
      x.auth.crypto.hash("auth.session", token),
      x.auth.crypto.hash("auth.csrf-store", csrf),
      x.now(),
    ],
  );
  return { identity: await x.auth.sessionIdentity(token), headers: { Cookie: `soldbench_session=${token}` } };
}

test("UTC monthly anniversaries preserve Jan 31 after February and do not drift", () => {
  const anchor = new Date("2024-01-31T23:59:01.123Z");
  assert.equal(
    freePeriod(anchor, new Date("2024-02-29T23:59:01.123Z")).start.toISOString(),
    "2024-02-29T23:59:01.123Z",
  );
  assert.equal(
    freePeriod(anchor, new Date("2024-03-30T23:59:01.123Z")).end.toISOString(),
    "2024-03-31T23:59:01.123Z",
  );
  assert.equal(
    freePeriod(anchor, new Date("2025-01-01T00:00:00Z")).start.toISOString(),
    "2024-12-31T23:59:01.123Z",
  );
});
test("golden complete snapshot 121/64/58, limit 50/200 same stats and full 58 calculation rows", async () => {
  const x = await setup({ gold: true }),
    a = await ready(x);
  await assert.rejects(
    x.queries.result(x.identity, a.queryId, "unclaimed"),
    (e) => e.code === "result_not_claimed",
  );
  const first = await x.queries.result(x.identity, a.queryId, "claim", true, randomUUID());
  assert.equal(first.meta.credits_charged, 1);
  assert.equal(first.data.comps.length, 50);
  assert.equal(first.data.stats.n_observed, 121);
  assert.equal(first.data.stats.n_comparable, 64);
  assert.equal(first.data.stats.n_price_verified, 58);
  assert.equal(first.data.stats.median_cents, 5800);
  const calc = await x.queries.calculation(x.identity, a.queryId);
  assert.equal(calc.items.length, 58);
  assert.equal(calc.is_complete, true);
  const b = await ready(x, { ...x.q, limit: 200 }),
    second = await x.queries.result(x.identity, b.queryId, "claim2", true, randomUUID());
  assert.deepEqual(second.data.stats, first.data.stats);
  assert.equal(second.data.comps.length, 58);
  assert.equal(second.meta.candidate_set_hash, first.meta.candidate_set_hash);
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 98);
  assert.deepEqual(await x.billing.reconcile(x.user.id), []);
});
test("100 concurrent submissions and claims settle once, reuse survives service restart, old key cannot charge", async () => {
  const x = await setup(),
    submissions = await Promise.all(Array.from({ length: 100 }, () => x.queries.submit(x.identity, x.q)));
  assert.equal(new Set(submissions.map((s) => s.queryId)).size, 1);
  const a = submissions[0];
  assert.equal((await x.queries.workOnce("worker")).status, "completed");
  const all = await Promise.all(
    Array.from({ length: 100 }, () =>
      x.queries.result(x.identity, a.queryId, "claim", true, "one-business-claim-0001"),
    ),
  );
  assert.equal(
    all.reduce((n, r) => n + r.meta.credits_charged, 0),
    1,
  );
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 99);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM billing_charges WHERE query_id=$1", [a.queryId])).rows[0].n,
    1,
  );
  const restarted = new QueryService(db, x.auth, x.billing, x.media, x.now);
  assert.equal((await restarted.submit(x.identity, x.q)).queryId, a.queryId);
  assert.equal((await restarted.result(x.identity, a.queryId, "free")).meta.credits_charged, 0);
  await db.query("UPDATE api_keys SET revoked_at=$2 WHERE id=$1", [x.key, x.now()]);
  await assert.rejects(restarted.result(x.identity, a.queryId, "revoked"), (e) => e.status === 401);
  assert.deepEqual(await x.billing.reconcile(x.user.id), []);
});
test("0/7/8/29/30 boundaries, no charging for low sample, stale explicit consent and retention independent", async () => {
  for (const count of [0, 7, 8, 29, 30]) {
    const x = await setup({ count }),
      a = await ready(x);
    const r = await x.queries.result(x.identity, a.queryId, "claim", true, randomUUID());
    assert.equal(r.meta.credits_charged, count < 8 ? 0 : 1);
    assert.equal(r.data.stats.median_cents === null, count < 8);
  }
  const x = await setup(),
    a = await ready(x);
  x.clock.value = new Date(Date.parse(x.now()) + 48 * 3600000).toISOString();
  // Unclaimed result expires at 24h; a new stale-consenting query may still use the retained 7-day evidence.
  await assert.rejects(
    x.queries.result(x.identity, a.queryId, "expired"),
    (e) => e.code === "result_expired",
  );
  await assert.rejects(x.queries.submit(x.identity, x.q), (e) => e.code === "source_unavailable");
  const b = await ready(x, { ...x.q, allow_stale: true }),
    r = await x.queries.result(x.identity, b.queryId, "stale");
  assert.equal(r.meta.credits_charged, 0);
  assert.equal(r.meta.stale, true);
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 100);
  const y = await setup({ retentionDays: 1 });
  y.clock.value = new Date(Date.parse(y.now()) + 48 * 3600000).toISOString();
  await assert.rejects(
    y.queries.submit(y.identity, { ...y.q, allow_stale: true }),
    (e) => e.code === "forbidden",
  );
});
test("wallet priority, idempotent refund after expiry, cash refund recovery and no negative wallet", async () => {
  const x = await setup(),
    now = new Date(x.now());
  await x.billing.balance(x.user.id);
  await x.billing.grant(x.user.id, {
    kind: "promo",
    provider: "synthetic",
    reference: "early",
    amount: 1,
    expiresAt: new Date(now.getTime() + 3600000),
  });
  const a = await ready(x);
  await x.queries.result(x.identity, a.queryId, "claim", true, randomUUID());
  const consume = (
    await db.query(
      "SELECT w.bucket_type FROM credit_ledger l JOIN credit_wallets w ON w.id=l.wallet_id WHERE l.ref_id=$1 AND l.kind='consume'",
      [a.queryId],
    )
  ).rows[0];
  assert.equal(consume.bucket_type, "promo");
  const admin = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at) VALUES($1,'test','active',$2) RETURNING id",
      [`admin-${randomUUID()}@example.test`, x.now()],
    )
  ).rows[0].id;
  await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin')", [admin]);
  x.clock.value = new Date(now.getTime() + 2 * 3600000).toISOString();
  assert.equal(await x.billing.refundCredit(x.user.id, a.queryId, admin, "synthetic operator refund"), true);
  assert.equal(await x.billing.refundCredit(x.user.id, a.queryId, admin, "replay"), false);
  assert.equal(
    (
      await db.query(
        "SELECT w.bucket_type,w.expires_at,l.created_at FROM credit_ledger l JOIN credit_wallets w ON w.id=l.wallet_id WHERE l.ref_id=$1 AND l.kind='refund'",
        [a.queryId],
      )
    ).rows[0].bucket_type,
    "promo",
  );
  const payment = (
    await db.query(
      "INSERT INTO payments(user_id,provider,provider_payment_id,amount_cents,currency,state) VALUES($1,'synthetic',$2,500,'USD','confirmed') RETURNING id",
      [x.user.id, randomUUID()],
    )
  ).rows[0].id;
  await x.billing.grant(x.user.id, {
    kind: "purchased",
    provider: "synthetic",
    reference: payment,
    amount: 10,
    expiresAt: null,
    paymentId: payment,
  });
  await db.query("UPDATE payments SET state='refunded',refunded_cents=amount_cents WHERE id=$1", [payment]);
  assert.deepEqual(await x.billing.revokeConfirmedPayment(x.user.id, payment), { recoveryCredits: 0 });
  assert.deepEqual(await x.billing.revokeConfirmedPayment(x.user.id, payment), { recoveryCredits: 0 });
  assert.deepEqual(await x.billing.reconcile(x.user.id), []);
});
test("owner isolation, exact collection scope, idempotency conflict, cancellation and permission revocation", async () => {
  const x = await setup(),
    y = await setup(),
    a = await ready(x);
  await assert.rejects(
    x.queries.submit(x.identity, { ...x.q, q: "not collected" }),
    (e) => e.code === "source_unavailable",
  );
  await assert.rejects(x.queries.result(y.identity, a.queryId, "foreign"), (e) => e.code === "not_found");
  await x.queries.result(x.identity, a.queryId, "one", true, "business-claim-key-0001");
  const b = await ready(x, { ...x.q, limit: 200 });
  await assert.rejects(
    x.queries.result(x.identity, b.queryId, "conflict", true, "business-claim-key-0001"),
    (e) => e.code === "idempotency_conflict",
  );
  const c = await x.queries.submit(x.identity, { ...x.q, limit: 199 }),
    status = await x.queries.job(x.identity, c.jobId);
  await x.queries.cancel(x.identity, c.jobId, status.version);
  assert.equal((await x.queries.job(x.identity, c.jobId)).status, "cancelled");
  await x.store.revokeSource(x.source.sourceId, "synthetic revocation");
  await assert.rejects(x.queries.result(x.identity, a.queryId, "revoked"), (e) => e.code === "forbidden");
});
test("HTTP API search/worker/claim/GET/calculation/media uses one contract and owner-authenticated image", async () => {
  const x = await setup({ images: true });
  const start = await request(x, `/v1/sold?q=${encodeURIComponent(x.q.q)}`);
  assert.equal(start.status, 202);
  const accepted = await start.json();
  assert.equal((await x.queries.workOnce("http-worker")).status, "completed");
  const id = accepted.data.query_id;
  assert.equal((await request(x, `/v1/sold/${id}`)).status, 409);
  const claim = await request(x, `/v1/sold/${id}/claim`, {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
  });
  assert.equal(claim.status, 200);
  const result = await claim.json();
  assert.equal(result.meta.credits_charged, 1);
  const image = result.data.comps.find((c) => c.primary_image.state === "available").primary_image;
  assert.equal((await request(x, image.url)).status, 200);
  assert.equal((await x.app.request(image.url)).status, 401);
  const calc = await request(x, `/v1/sold/${id}/calculation-inputs`);
  assert.equal(calc.status, 200);
  const calculation = await calc.json();
  assert.equal(calculation.data.items.length, 58);
  const ownerSession = await browserIdentity(x);
  const foreignSession = await browserIdentity(x, (await setup()).user);
  const historyResponse = await x.app.request("/v1/queries", { headers: ownerSession.headers });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.ok(history.data.items.some((item) => item.query_id === id));
  assert.equal((await request(x, "/v1/queries")).status, 403);
  const foreignHistory = await x.app.request("/v1/queries", { headers: foreignSession.headers });
  assert.equal(foreignHistory.status, 200);
  assert.deepEqual((await foreignHistory.json()).data.items, []);
  assert.equal((await x.app.request(`/v1/sold/${id}`, { headers: foreignSession.headers })).status, 404);
  const usage = await (await request(x, "/v1/usage")).json();
  execFileSync("python3", ["tests/validate-response.py"], {
    input: JSON.stringify([
      ["SoldResult", result],
      ["CalculationResponse", calculation],
      ["UsageResponse", usage],
      ["QueriesResponse", history],
    ]),
  });
  await db.query("UPDATE listing_images SET permission_epoch=permission_epoch+1 WHERE source_id=$1", [
    x.source.sourceId,
  ]);
  const changed = await (await request(x, `/v1/sold/${id}`)).json();
  assert.equal(
    changed.data.comps.find(
      (c) =>
        c.sale_event_id ===
        result.data.comps.find((c) => c.primary_image.state === "available").sale_event_id,
    ).primary_image.state,
    "revoked",
  );
  assert.equal((await request(x, image.url)).status, 404);
  assert.equal((await request(x, `/v1/sold/${id}`)).status, 200);
  assert.equal((await request(x, "/v1/usage")).status, 200);
  await db.query("UPDATE api_keys SET revoked_at=$2 WHERE id=$1", [x.key, x.now()]);
  assert.equal((await request(x, "/v1/queries")).status, 401);
  assert.equal(safeCsvCell(" =SUM(A1:A2)"), '"\' =SUM(A1:A2)"');
});

test("same confirmed payment with 100 different notification references issues exactly one grant", async () => {
  const x = await setup();
  const payment = (
    await db.query(
      "INSERT INTO payments(user_id,provider,provider_payment_id,amount_cents,currency,state) VALUES($1,'synthetic',$2,500,'USD','confirmed') RETURNING id",
      [x.user.id, randomUUID()],
    )
  ).rows[0].id;
  const ids = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      x.billing.grant(x.user.id, {
        kind: "purchased",
        provider: "synthetic",
        reference: `notification-${i}`,
        amount: 10,
        paymentId: payment,
        expiresAt: null,
        policyVersion: i % 2 ? "1" : "2",
      }),
    ),
  );
  assert.equal(new Set(ids).size, 1);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM credit_grants WHERE payment_id=$1", [payment])).rows[0].n,
    1,
  );
  assert.deepEqual(await x.billing.reconcile(x.user.id), []);
});
test("one remaining credit under 100 distinct ready queries permits one settlement and retries stay ready", async () => {
  const x = await setup({ count: 8 });
  await db.query("UPDATE users SET free_anchor_at=NULL WHERE id=$1", [x.user.id]);
  await x.billing.grant(x.user.id, {
    kind: "promo",
    provider: "synthetic",
    reference: "one",
    amount: 1,
    expiresAt: new Date(Date.parse(x.now()) + 86400000),
  });
  const pending = [];
  for (let limit = 1; limit <= 100; limit++) {
    const r = await ready(x, { ...x.q, limit });
    pending.push(r);
  }
  const all = await Promise.allSettled(
    pending.map((r) => x.queries.result(x.identity, r.queryId, "concurrent", true, randomUUID())),
  );
  assert.equal(all.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(
    all.filter((r) => r.status === "rejected").every((r) => r.reason.code === "insufficient_credits"),
  );
  assert.deepEqual(await x.billing.reconcile(x.user.id), []);
  const retry = pending.find((_, i) => all[i].status === "rejected");
  await x.billing.grant(x.user.id, {
    kind: "promo",
    provider: "synthetic",
    reference: "topup",
    amount: 1,
    expiresAt: new Date(Date.parse(x.now()) + 86400000),
  });
  assert.equal(
    (await x.queries.result(x.identity, retry.queryId, "retry", true, randomUUID())).meta.credits_charged,
    1,
  );
});
test("cash/credit refunds in either order and expired compensation leave equal zero credit and no open recovery", async () => {
  for (const order of ["cash-first", "credit-first", "expired-credit-first"]) {
    const x = await setup({ count: 8 });
    await db.query("UPDATE users SET free_anchor_at=NULL WHERE id=$1", [x.user.id]);
    const admin = (
      await db.query(
        "INSERT INTO users(email,password_hash,status,email_verified_at) VALUES($1,'test','active',$2) RETURNING id",
        [`admin-${randomUUID()}@example.test`, x.now()],
      )
    ).rows[0].id;
    await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin')", [admin]);
    const payment = (
      await db.query(
        "INSERT INTO payments(user_id,provider,provider_payment_id,amount_cents,currency,state) VALUES($1,'synthetic',$2,500,'USD','confirmed') RETURNING id",
        [x.user.id, randomUUID()],
      )
    ).rows[0].id;
    await x.billing.grant(x.user.id, {
      kind: order === "expired-credit-first" ? "promo" : "purchased",
      provider: "synthetic",
      reference: payment,
      amount: 1,
      paymentId: payment,
      expiresAt: order === "expired-credit-first" ? new Date(Date.parse(x.now()) + 3600000) : null,
    });
    const a = await ready(x);
    await x.queries.result(x.identity, a.queryId, "claim", true, randomUUID());
    if (order === "expired-credit-first")
      x.clock.value = new Date(Date.parse(x.now()) + 2 * 3600000).toISOString();
    const cash = async () => {
      await db.query("UPDATE payments SET state='refunded',refunded_cents=amount_cents WHERE id=$1", [
        payment,
      ]);
      await x.billing.revokeConfirmedPayment(x.user.id, payment);
    };
    if (order === "cash-first") {
      await cash();
      assert.equal((await x.billing.balance(x.user.id)).recovery_credits, 1);
      await x.billing.refundCredit(x.user.id, a.queryId, admin, "offline");
    } else {
      await x.billing.refundCredit(x.user.id, a.queryId, admin, "offline");
      await cash();
    }
    await cash();
    assert.equal((await x.billing.balance(x.user.id)).available_credits, 0);
    assert.equal((await x.billing.balance(x.user.id)).recovery_credits, 0);
    assert.deepEqual(await x.billing.reconcile(x.user.id), []);
  }
});
test("withdrawn versions do not get current labels, stopped source retains lawful history, FX unknown stays null", async () => {
  const x = await setup({ count: 8 }),
    a = await ready(x);
  await x.queries.result(x.identity, a.queryId, "claim", true, randomUUID());
  await x.store.stop(x.source.sourceId, "offline outage");
  assert.equal((await x.queries.result(x.identity, a.queryId, "history")).meta.source_status, "stopped");
  await db.query("UPDATE query_results SET engine_version='old-engine' WHERE query_id=$1", [a.queryId]);
  await assert.rejects(x.queries.result(x.identity, a.queryId, "old"), (e) => e.code === "state_conflict");
  const y = await setup({ count: 8 }),
    b = await y.queries.submit(y.identity, { ...y.q, price_basis: "item" }).catch((e) => {
      assert.equal(e.code, "source_unavailable");
      return null;
    });
  assert.equal(b, null);
  // Collector scope is exact, so create a distinct item-basis watermark over authored EUR fixtures.
  const q = { ...y.q, price_basis: "item" },
    store = y.store,
    _job = await store.enqueue({
      ...y.source,
      queryHash: collectionQueryHash(q),
      runKey: randomUUID(),
      asOf: y.now(),
    });
  const records = Array.from({ length: 8 }, (_, i) => ({
    listingId: `fx-${i}`,
    title: `FX ${i}`,
    candidate: {
      sourceId: y.source.sourceId,
      eventKey: `fx-${i}`,
      identityVerified: true,
      comparable: true,
      priceStatus: "verified_actual",
      format: "fixed_price",
      currency: "EUR",
      itemCents: 1000,
      shippingCents: 100,
      shippingStatus: "observed",
      usdConversion: { itemCents: 1100, shippingCents: null, evidenceRef: "synthetic-fx" },
      time: { precision: "instant", value: y.now() },
    },
  }));
  await new OfflineCollectorWorker(
    store,
    new FixtureTransport(
      new Map([
        [
          "page:start",
          [
            fixtureResponse({
              schema: "soldbench.synthetic-page.v1",
              synthetic: true,
              sourceId: y.source.sourceId,
              queryHash: collectionQueryHash(q),
              cursor: "start",
              nextCursor: null,
              asOf: y.now(),
              empty: false,
              records,
            }),
          ],
        ],
      ]),
    ),
    y.media,
  ).runOne(y.source.sourceId);
  const r = await ready(y, q),
    value = await y.queries.result(y.identity, r.queryId, "fx", true, randomUUID());
  assert.equal(value.data.stats.median_cents, 1100);
  assert.ok(value.data.comps.every((c) => c.observed_shipping_cents === null));
});

test("inflight dedupe after 11 minutes, expired pending recovery and stale lease cannot duplicate publication", async () => {
  const x = await setup({ count: 8 }),
    a = await x.queries.submit(x.identity, x.q);
  x.clock.value = new Date(Date.parse(x.now()) + 11 * 60000).toISOString();
  assert.equal((await x.queries.submit(x.identity, x.q)).jobId, a.jobId);
  await db.query(
    "UPDATE query_jobs SET status='running',lease_owner='dead-worker',lease_until=$2,attempt_count=1 WHERE id=$1",
    [a.jobId, new Date(Date.parse(x.now()) - 1000)],
  );
  assert.equal((await x.queries.workOnce("recovered")).status, "completed");
  assert.equal((await x.queries.job(x.identity, a.jobId)).attempt_count, 2);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM query_results WHERE query_id=$1", [a.queryId])).rows[0].n,
    1,
  );
  x.clock.value = new Date(Date.parse(x.now()) + 24 * 3600000).toISOString();
  assert.equal((await x.queries.job(x.identity, a.jobId)).result_state, "expired");
  assert.equal((await x.queries.job(x.identity, a.jobId)).status, "completed");
  const b = await x.queries.submit(x.identity, { ...x.q, allow_stale: true });
  assert.notEqual(b.queryId, a.queryId);
  x.clock.value = new Date(Date.parse(x.now()) + 24 * 3600000).toISOString();
  const c = await x.queries.submit(x.identity, { ...x.q, allow_stale: true });
  assert.notEqual(c.queryId, b.queryId);
  assert.equal((await x.queries.job(x.identity, b.jobId)).status, "expired");
});
test("Free grants roll once per UTC period; only confirmed paid periods upgrade or reanchor", async () => {
  const x = await setup({ count: 8 });
  x.clock.value = "2026-01-31T12:00:00.000Z";
  await db.query("UPDATE users SET free_anchor_at=$2 WHERE id=$1", [x.user.id, x.now()]);
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 100);
  x.clock.value = "2026-02-28T12:00:00.000Z";
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 100);
  const plan = (
    await db.query(
      "INSERT INTO plans(code,policy_version,price_usd_cents,monthly_credits,rate_limit_per_min,features) VALUES($1,'synthetic',900,2000,60,'{}') RETURNING id",
      [randomUUID()],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO subscriptions(user_id,plan_id,provider,provider_subscription_id,status,current_period_start,current_period_end) VALUES($1,$2,'synthetic',$3,'incomplete',$4,$5)",
    [x.user.id, plan, randomUUID(), "2026-02-10T12:00:00Z", "2026-02-20T12:00:00Z"],
  );
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 100);
  await db.query(
    "INSERT INTO subscriptions(user_id,plan_id,provider,provider_subscription_id,status,current_period_start,current_period_end) VALUES($1,$2,'synthetic',$3,'active',$4,$5)",
    [x.user.id, plan, randomUUID(), "2026-02-28T12:00:00Z", "2026-03-28T12:00:00Z"],
  );
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 100);
  const payment = (
    await db.query(
      "INSERT INTO payments(user_id,provider,provider_payment_id,amount_cents,currency,state) VALUES($1,'synthetic',$2,900,'USD','confirmed') RETURNING id",
      [x.user.id, randomUUID()],
    )
  ).rows[0].id;
  await x.billing.grant(x.user.id, {
    kind: "subscription",
    provider: "synthetic",
    reference: "paid-period",
    amount: 2000,
    paymentId: payment,
    periodStart: new Date("2026-02-28T12:00:00Z"),
    expiresAt: new Date("2026-03-28T12:00:00Z"),
  });
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 2000);
  x.clock.value = "2026-03-28T12:00:00.000Z";
  assert.equal((await x.billing.balance(x.user.id)).available_credits, 100);
  assert.equal(
    (
      await db.query("SELECT period_start FROM credit_wallets WHERE user_id=$1 AND status='active'", [
        x.user.id,
      ])
    ).rows[0].period_start.toISOString(),
    x.now(),
  );
  assert.deepEqual(await x.billing.reconcile(x.user.id), []);
});
test("HTTP Free owner rate shared across keys returns Retry-After and resets on the next UTC minute", async () => {
  const x = await setup({ count: 8 });
  for (let i = 0; i < 30; i++) assert.equal((await request(x, "/v1/usage")).status, 200);
  const blocked = await request(x, "/v1/usage");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
  assert.equal((await request(x, "/v1/usage")).status, 200);
});

test("pagination is signed, owner scoped, stable for identical timestamps and independent of ledger cursors", async () => {
  const x = await setup({ count: 8 }),
    y = await setup({ count: 8 });
  for (let i = 1; i <= 3; i++) await ready(x, { ...x.q, limit: i });
  const session = (await browserIdentity(x)).identity;
  const foreign = (await browserIdentity(x, y.user)).identity;
  const first = await x.queries.history(session, undefined, 2),
    second = await x.queries.history(session, first.next_cursor, 2);
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map((r) => r.query_id)).size, 3);
  await assert.rejects(
    x.queries.history(foreign, first.next_cursor, 2),
    (e) => e.code === "invalid_parameter",
  );
  await assert.rejects(
    x.queries.usage(x.identity, first.next_cursor, 2),
    (e) => e.code === "invalid_parameter",
  );
  const accepted = await request(x, "/web/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: x.q.q, attributes: {} }),
  });
  assert.equal(accepted.status, 202);
  assert.equal(
    (
      await request(x, "/web/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: x.q.q, limit: "50" }),
      })
    ).status,
    400,
  );
});
test("current business lock rechecks administrator absolute TTL on an already obtained identity", async () => {
  const x = await setup({ count: 8 }),
    token = x.auth.crypto.token("sb_s_"),
    csrf = x.auth.crypto.hash("auth.csrf", token);
  await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin')", [x.user.id]);
  await db.query(
    "INSERT INTO user_mfa(user_id,encrypted_secret,state,enabled_at,updated_at) VALUES($1,$2,'enabled',$3,$3)",
    [x.user.id, Buffer.from("synthetic encrypted placeholder"), x.now()],
  );
  await db.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_hash,credential_version,mfa_pending,expires_at,authenticated_at,mfa_at,created_at) VALUES($1,$2,$3,0,false,$4,$5,$5,$5)",
    [
      x.user.id,
      x.auth.crypto.hash("auth.session", token),
      x.auth.crypto.hash("auth.csrf-store", csrf),
      new Date(Date.parse(x.now()) + 7 * 86400000),
      x.now(),
    ],
  );
  const identity = await x.auth.sessionIdentity(token);
  x.clock.value = new Date(Date.parse(x.now()) + 12 * 3600000 + 1).toISOString();
  await assert.rejects(x.queries.submit(identity, x.q), (e) => e.status === 401);
});
