import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { AuthService, newAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
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
import { BestOfferVerificationService, QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

async function seedBestOfferQuery({
  fixedCount = 8,
  bestOfferCount = 2,
  clockValue = "2026-11-22T12:00:00.000Z",
} = {}) {
  const clock = { value: clockValue };
  const now = () => clock.value;
  const config = loadConfig({});
  const auth = new AuthService(db, newAuthSecrets(), config.origin, now);
  const billing = new BillingService(db, now);
  const root = await mkdtemp(join(tmpdir(), "soldbench-best-offer-"));
  roots.push(root);
  const media = new PrivateMediaStore(root);
  const query = new QueryService(db, auth, billing, media, now);
  const source = await provisionFixtureSource(db, now(), { retentionDays: 7 });
  const store = new CollectorStore(db, now);
  const keyword = `best-offer-fixture-${randomUUID()}`;
  const normalized = normalizeQuery(new URLSearchParams({ q: keyword, limit: "25" }));
  const hash = collectionQueryHash(normalized);
  await store.enqueue({ ...source, queryHash: hash, runKey: randomUUID(), asOf: now() });

  const records = [];
  for (let i = 0; i < fixedCount; i += 1) {
    records.push({
      listingId: `fixed-${i}`,
      title: `Fixed Item ${i}`,
      candidate: {
        sourceId: source.sourceId,
        eventKey: `fixed-event-${i}-${randomUUID()}`,
        identityVerified: true,
        comparable: true,
        priceStatus: "verified_actual",
        format: "fixed_price",
        currency: "USD",
        itemCents: 10000 + i * 100,
        shippingCents: 0,
        shippingStatus: "verified_free_shipping",
        condition: "good",
        title: `Fixed Item ${i}`,
        time: { precision: "instant", value: now() },
      },
    });
  }
  for (let i = 0; i < bestOfferCount; i += 1) {
    records.push({
      listingId: `bo-${i}`,
      title: `Best Offer Listing ${i}`,
      candidate: {
        sourceId: source.sourceId,
        eventKey: `bo-event-${i}-${randomUUID()}`,
        identityVerified: true,
        comparable: true,
        priceStatus: "displayed_only",
        format: "best_offer",
        currency: "USD",
        itemCents: 25000 + i * 1000,
        shippingCents: 0,
        shippingStatus: "verified_free_shipping",
        condition: "good",
        title: `Best Offer Listing ${i}`,
        time: { precision: "instant", value: now() },
      },
    });
  }

  const frames = new Map([
    [
      "page:start",
      [
        fixtureResponse({
          schema: "soldbench.synthetic-page.v1",
          synthetic: true,
          sourceId: source.sourceId,
          queryHash: hash,
          cursor: "start",
          nextCursor: null,
          asOf: now(),
          empty: false,
          records,
        }),
      ],
    ],
  ]);
  const workerRes = await new OfflineCollectorWorker(store, new FixtureTransport(frames), media).runOne(
    source.sourceId,
  );
  assert.equal(workerRes.status, "completed");

  const ownerId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`bo-owner-${randomUUID()}@example.test`, now()],
    )
  ).rows[0].id;
  const ownerSecret = auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'fixture',$2,'sb_k_bo',$3)",
    [ownerId, auth.crypto.hash("auth.api-key", ownerSecret), ["sold:read", "jobs:read", "usage:read"]],
  );
  const ownerIdentity = await auth.keyIdentity(ownerSecret, "sold:read");

  const otherId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`bo-other-${randomUUID()}@example.test`, now()],
    )
  ).rows[0].id;
  const otherSecret = auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'other',$2,'sb_k_oth',$3)",
    [otherId, auth.crypto.hash("auth.api-key", otherSecret), ["sold:read", "jobs:read", "usage:read"]],
  );

  const submitted = await query.submit(ownerIdentity, normalized);
  assert.equal((await query.workOnce("bo-query-worker")).status, "completed");
  await query.result(ownerIdentity, submitted.queryId, randomUUID(), true, randomUUID());

  return {
    clock,
    now,
    config,
    auth,
    billing,
    query,
    source,
    ownerId,
    ownerHeaders: { Authorization: `Bearer ${ownerSecret}` },
    otherHeaders: { Authorization: `Bearer ${otherSecret}` },
    queryId: submitted.queryId,
  };
}

test("AT-064 Best Offer post-lookup verification lifecycle preserves immutable baseline, enforces retry/deadline/budget caps, circuit-breaks on 403, and creates free revisions", async () => {
  const s = await seedBestOfferQuery({ fixedCount: 8, bestOfferCount: 3 });

  const transportResponses = new Map();
  let externalCalls = 0;
  const service = new BestOfferVerificationService(s.query, {
    kind: "memory_fixture",
    async verify(input) {
      externalCalls += 1;
      const handler = transportResponses.get(input.externalListingId);
      assert.ok(handler, `missing mock for ${input.externalListingId}`);
      return handler(input.attempt);
    },
  });
  const app = createApp(s.config, db, { auth: s.auth, query: s.query, bestOffers: service });

  // Original delivered baseline snapshot (v1): 8 fixed_price verified + 3 displayed_only excluded
  const v1Res = await app.request(`/v1/sold/${s.queryId}`, { headers: s.ownerHeaders });
  assert.equal(v1Res.status, 200);
  const v1Body = await v1Res.json();
  assert.equal(v1Body.data.stats.n_price_verified, 8);
  assert.equal(v1Body.data.stats.best_offer_displayed_only_count, 3);
  const v1Median = v1Body.data.stats.median_cents;
  const v1Hash = v1Body.meta.candidate_set_hash;

  // Cross-owner isolation (404)
  const crossOwnerGet = await app.request(`/v1/sold/${s.queryId}/best-offers`, { headers: s.otherHeaders });
  assert.equal(crossOwnerGet.status, 404);
  const crossOwnerPost = await app.request(`/v1/sold/${s.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...s.otherHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(crossOwnerPost.status, 404);

  // Initial status before enqueue shows baseline Revision 1 & 3 unrequested Best Offers
  const initialStatusRes = await app.request(`/v1/sold/${s.queryId}/best-offers`, {
    headers: s.ownerHeaders,
  });
  assert.equal(initialStatusRes.status, 200);
  const initialStatus = await initialStatusRes.json();
  assert.equal(initialStatus.data.summary.total_best_offer_events, 3);
  assert.equal(initialStatus.data.summary.displayed_only_count, 3);
  assert.equal(initialStatus.data.summary.unrequested_count, 3);
  assert.equal(initialStatus.data.revisions.length, 1);
  assert.equal(initialStatus.data.revisions[0].revision_number, 1);
  assert.equal(initialStatus.meta.credits_charged, 0);

  // Creating revision with zero verified Best Offers rejects with 409 no_verified_offers
  const noRevRes = await app.request(`/v1/sold/${s.queryId}/revisions`, {
    method: "POST",
    headers: { ...s.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(noRevRes.status, 409);
  assert.equal((await noRevRes.json()).error.code, "no_verified_offers");

  // Enqueue 2 items first (`bo-0` & `bo-1`) cleanly; keep `bo-2` unrequested for later
  const bo0EventId = initialStatus.data.items.find((i) => i.external_listing_id === "bo-0").sale_event_id;
  const bo1EventId = initialStatus.data.items.find((i) => i.external_listing_id === "bo-1").sale_event_id;
  const bo2EventId = initialStatus.data.items.find((i) => i.external_listing_id === "bo-2").sale_event_id;

  const verifyReq = await app.request(`/v1/sold/${s.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...s.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sale_event_ids: [bo0EventId, bo1EventId], ttl_minutes: 30 }),
  });
  assert.equal(verifyReq.status, 202);
  const verifyBody = await verifyReq.json();
  assert.equal(verifyBody.meta.credits_charged, 0);
  assert.equal(verifyBody.meta.queued_now, 2);
  assert.equal(verifyBody.data.summary.pending_count, 2);
  assert.equal(verifyBody.data.summary.unrequested_count, 1);
  const bo0InitialExpires = verifyBody.data.items.find((i) => i.sale_event_id === bo0EventId).verification
    .expires_at;

  // Idempotent repeat enqueue does NOT reset deadline or duplicate rows
  s.clock.value = "2026-11-22T12:05:00.000Z";
  const repeatReq = await app.request(`/v1/sold/${s.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...s.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sale_event_ids: [bo0EventId, bo1EventId], ttl_minutes: 60 }),
  });
  assert.equal(repeatReq.status, 202);
  const repeatBody = await repeatReq.json();
  assert.equal(repeatBody.meta.queued_now, 0);
  assert.equal(repeatBody.meta.reused_existing, 2);
  assert.equal(
    repeatBody.data.items.find((i) => i.sale_event_id === bo0EventId).verification.expires_at,
    bo0InitialExpires,
  );

  // Configure transport:
  // - bo-0: retryable once -> verified actual price ($150.00 = 15000 cents, NOT displayed $250.00)
  // - bo-1: retries 3 times -> exhausted -> not_available (stays excluded, NEVER 0)
  transportResponses.set("bo-0", (attempt) =>
    attempt === 1
      ? { kind: "retryable", reason: "upstream_429_rate_limit" }
      : {
          kind: "verified",
          verifiedPriceCents: 15000,
          currency: "USD",
          evidenceKind: "best_offer_acceptance_card",
          evidenceRef: "fixture-acceptance-bo-0",
        },
  );
  transportResponses.set("bo-1", () => ({
    kind: "retryable",
    reason: "temporary_detail_unavailable",
  }));

  // Drain worker steps with strictly bounded retries (bo-0 needs 2 attempts, bo-1 exhausts 3 attempts)
  for (let step = 0; step < 5; step += 1) {
    s.clock.value = new Date(Date.parse(s.clock.value) + 1000).toISOString();
    await service.processNext({ queryId: s.queryId });
  }
  const idleRes = await service.processNext({ queryId: s.queryId });
  assert.equal(idleRes.outcome, "idle");

  // Re-submitting same items does NOT reset attempts or status after completion/exhaustion
  const afterRunRepeat = await app.request(`/v1/sold/${s.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...s.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sale_event_ids: [bo0EventId, bo1EventId] }),
  });
  assert.equal(afterRunRepeat.status, 202);
  const afterBody = await afterRunRepeat.json();
  assert.equal(afterBody.data.summary.verified_count, 1);
  assert.equal(afterBody.data.summary.not_available_count, 1);
  const bo0State = afterBody.data.items.find((i) => i.sale_event_id === bo0EventId).verification;
  const bo1State = afterBody.data.items.find((i) => i.sale_event_id === bo1EventId).verification;
  assert.equal(bo0State.status, "verified");
  assert.equal(bo0State.attempts, 2);
  assert.equal(bo0State.verified_price_usd_cents, 15000);
  assert.equal(bo1State.status, "not_available");
  assert.equal(bo1State.attempts, 3);
  assert.match(bo1State.failure_reason, /^retry_budget_exhausted:/);

  // Generate Revision 2! Verify:
  // - Only bo-0 (verified actual 15000) enters calculation; bo-1 (not_available) & bo-2 (displayed_only) stay excluded
  // - Revision 1 & original GET /v1/sold/:id are UNCHANGED
  // - Credits charged === 0
  s.clock.value = "2026-11-22T12:10:00.000Z";
  const rev2Res = await app.request(`/v1/sold/${s.queryId}/revisions`, {
    method: "POST",
    headers: { ...s.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ trigger_kind: "best_offer_verification" }),
  });
  assert.equal(rev2Res.status, 201);
  const rev2 = await rev2Res.json();
  assert.equal(rev2.meta.credits_charged, 0);
  assert.equal(rev2.meta.reused, false);
  assert.equal(rev2.data.revision_number, 2);
  assert.equal(rev2.data.parent_revision_number, 1);
  assert.equal(rev2.data.credits_charged, 0);
  assert.equal(rev2.data.verified_offer_count, 1);
  assert.equal(rev2.data.not_available_offer_count, 1);
  assert.equal(rev2.data.stats.n_price_verified, 9);
  assert.equal(rev2.data.stats.best_offer_displayed_only_count, 2);
  assert.notEqual(rev2.data.stats.median_cents, v1Median);
  assert.ok(rev2.data.records.some((r) => r.sale_event_id === bo0EventId && r.price_usd_cents === 15000));
  assert.equal(
    rev2.data.records.some((r) => r.sale_event_id === bo1EventId || r.sale_event_id === bo2EventId),
    false,
  );

  // Repeating POST /v1/sold/:id/revisions reuses Revision 2 idempotently (200)
  const rev2Replay = await app.request(`/v1/sold/${s.queryId}/revisions`, {
    method: "POST",
    headers: { ...s.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(rev2Replay.status, 200);
  const rev2ReplayBody = await rev2Replay.json();
  assert.equal(rev2ReplayBody.meta.reused, true);
  assert.equal(rev2ReplayBody.data.revision_number, 2);

  // Original snapshot endpoint & Revision 1 stay 100% unchanged
  const v1Recheck = await (await app.request(`/v1/sold/${s.queryId}`, { headers: s.ownerHeaders })).json();
  assert.equal(v1Recheck.data.stats.n_price_verified, 8);
  assert.equal(v1Recheck.data.stats.median_cents, v1Median);
  assert.equal(v1Recheck.meta.candidate_set_hash, v1Hash);
  const statusAfterRev = await (
    await app.request(`/v1/sold/${s.queryId}/best-offers`, { headers: s.ownerHeaders })
  ).json();
  assert.equal(statusAfterRev.data.revisions.length, 2);
  assert.equal(statusAfterRev.data.revisions[0].stats.n_price_verified, 8);
  assert.equal(statusAfterRev.data.revisions[1].stats.n_price_verified, 9);

  // Test deadline expiration on bo-2 without touching transport
  const callsBeforeExpiry = externalCalls;
  const bo2Enqueue = await app.request(`/v1/sold/${s.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...s.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sale_event_ids: [bo2EventId], ttl_minutes: 1 }),
  });
  assert.equal(bo2Enqueue.status, 202);
  s.clock.value = "2026-11-22T12:12:00.000Z";
  const expiredProcess = await service.processNext({ queryId: s.queryId });
  assert.equal(expiredProcess.outcome, "idle");
  assert.equal(externalCalls, callsBeforeExpiry);
  const expiredStatus = await (
    await app.request(`/v1/sold/${s.queryId}/best-offers`, { headers: s.ownerHeaders })
  ).json();
  assert.equal(
    expiredStatus.data.items.find((i) => i.sale_event_id === bo2EventId).verification.status,
    "expired",
  );

  // Ledger reconciliation clean and query total billing charges remains 1 (never 2+)
  const charges = (await db.query("SELECT * FROM billing_charges WHERE user_id=$1", [s.ownerId])).rows;
  assert.equal(charges.length, 1);
  assert.deepEqual(await s.billing.reconcile(), []);
});

test("AT-064 enforces unclaimed 409, 10-item budget cap, non-fixture transport guard, 403 circuit break, and source revocation", async () => {
  // 1. Unclaimed query -> 409 result_not_claimed
  const unclaimed = await createProductFixture(db, roots, { claimed: false, count: 8 });
  const unclaimedApp = createApp(loadConfig({}), db, { auth: unclaimed.auth, query: unclaimed.query });
  const unclaimedGet = await unclaimedApp.request(`/v1/sold/${unclaimed.queryId}/best-offers`, {
    headers: unclaimed.headers,
  });
  assert.equal(unclaimedGet.status, 409);
  assert.equal((await unclaimedGet.json()).error.code, "result_not_claimed");

  // 2. 12 Best Offer items -> requesting >10 triggers 422 verification_budget_exceeded, empty body caps cleanly at 10
  const large = await seedBestOfferQuery({ fixedCount: 8, bestOfferCount: 12 });
  const nonFixtureSvc = new BestOfferVerificationService(large.query, {
    kind: "forbidden_live_http",
    async verify() {
      throw new Error("must_not_run");
    },
  });
  const largeApp = createApp(large.config, db, {
    auth: large.auth,
    query: large.query,
    bestOffers: nonFixtureSvc,
  });
  const listRes = await (
    await largeApp.request(`/v1/sold/${large.queryId}/best-offers`, {
      headers: large.headers ?? large.ownerHeaders,
    })
  ).json();
  const all11 = listRes.data.items.slice(0, 10).map((i) => i.sale_event_id);
  assert.equal(all11.length, 10);

  const enqueue10 = await largeApp.request(`/v1/sold/${large.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...large.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sale_event_ids: all11 }),
  });
  assert.equal(enqueue10.status, 202);
  assert.equal((await enqueue10.json()).meta.queued_now, 10);

  const overBudget = await largeApp.request(`/v1/sold/${large.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...large.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(overBudget.status, 422);
  assert.equal((await overBudget.json()).error.code, "verification_budget_exceeded");

  // Non-memory_fixture transport throws 503 best_offer_verifier_unavailable before touching external network
  await assert.rejects(
    () => nonFixtureSvc.processNext({ queryId: large.queryId }),
    (err) => err.code === "best_offer_verifier_unavailable" && err.status === 503,
  );

  // 3. 403 source_blocked opens collector_circuits immediately and blocks ALL pending rows + future verify requests
  const blockedSvc = new BestOfferVerificationService(large.query, {
    kind: "memory_fixture",
    async verify() {
      return { kind: "source_blocked", httpStatus: 403, reason: "anti_bot_403_block" };
    },
  });
  const blockResult = await blockedSvc.processNext({ queryId: large.queryId });
  assert.equal(blockResult.outcome, "source_blocked");

  const circuit = (
    await db.query(
      "SELECT status,opened_reason FROM collector_circuits WHERE source_id=$1 AND category_key='*'",
      [large.source.sourceId],
    )
  ).rows[0];
  assert.equal(circuit.status, "open");
  assert.match(circuit.opened_reason, /^http_403:/);

  const blockedStatus = await (
    await largeApp.request(`/v1/sold/${large.queryId}/best-offers`, { headers: large.ownerHeaders })
  ).json();
  assert.equal(blockedStatus.data.eligibility.source_circuit_open, true);
  assert.equal(blockedStatus.data.summary.source_blocked_count, 10);
  assert.equal(blockedStatus.data.summary.pending_count, 0);

  // Attempting to enqueue while circuit is open fails 409 source_circuit_open
  const remainingItem = listRes.data.items[10].sale_event_id;
  const blockedEnqueue = await largeApp.request(`/v1/sold/${large.queryId}/best-offers/verify`, {
    method: "POST",
    headers: { ...large.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sale_event_ids: [remainingItem] }),
  });
  assert.equal(blockedEnqueue.status, 409);
  assert.equal((await blockedEnqueue.json()).error.code, "source_circuit_open");

  // 4. Source revocation immediately stops all read & mutation access (403 forbidden)
  await db.query("UPDATE sources SET status='revoked',permission_epoch=permission_epoch+1 WHERE id=$1", [
    large.source.sourceId,
  ]);
  const revokedRead = await largeApp.request(`/v1/sold/${large.queryId}/best-offers`, {
    headers: large.ownerHeaders,
  });
  assert.equal(revokedRead.status, 403);
  const revokedRevise = await largeApp.request(`/v1/sold/${large.queryId}/revisions`, {
    method: "POST",
    headers: { ...large.ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(revokedRevise.status, 403);
});
