import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { parseBatchCsv } from "@soldbench/query";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

async function seedQueryCorpus(x, keyword, count, { asOf = x.now(), extraCondition = "good" } = {}) {
  const q = normalizeQuery(new URLSearchParams({ q: keyword }));
  const hash = collectionQueryHash(q);
  const store = new CollectorStore(db, x.now);
  const jobId = await store.enqueue({ ...x.source, queryHash: hash, runKey: randomUUID(), asOf });
  const rows = Array.from({ length: count }, (_, i) => ({
    listingId: `${keyword}-listing-${i}-${randomUUID()}`,
    title: `${keyword} item ${i}`,
    candidate: {
      sourceId: x.source.sourceId,
      eventKey: `${keyword}-event-${i}-${randomUUID()}`,
      identityVerified: true,
      comparable: true,
      priceStatus: "verified_actual",
      format: "fixed_price",
      currency: "USD",
      itemCents: 2000 + i * 25,
      shippingCents: 0,
      shippingStatus: "verified_free_shipping",
      condition: extraCondition,
      title: `${keyword} item ${i}`,
      time: { precision: "instant", value: asOf },
    },
  }));
  const imageUrl = `https://images.example.test/${encodeURIComponent(keyword)}.png`;
  if (rows[0]) rows[0].primaryImage = { role: "primary", url: imageUrl };
  const frames = new Map();
  frames.set("page:start", [
    fixtureResponse({
      schema: "soldbench.synthetic-page.v1",
      synthetic: true,
      sourceId: x.source.sourceId,
      queryHash: hash,
      cursor: "start",
      nextCursor: null,
      asOf,
      empty: rows.length === 0,
      records: rows,
    }),
  ]);
  if (rows[0]) {
    frames.set(`image:${imageUrl}`, [
      {
        status: 200,
        contentType: "image/png",
        bytes: await sharp({ create: { width: 10, height: 10, channels: 3, background: "green" } })
          .png()
          .toBuffer(),
      },
    ]);
  }
  const media = new PrivateMediaStore(roots[0]);
  const res = await new OfflineCollectorWorker(store, new FixtureTransport(frames), media).runOne(
    x.source.sourceId,
  );
  assert.equal(res.status, "completed");
  return { q, jobId };
}

test("parseBatchCsv enforces schema, 20-item limit, and RFC-4180 escaping", () => {
  assert.throws(() => parseBatchCsv(""), /empty/i);
  assert.throws(() => parseBatchCsv("brand\nnintendo\n"), /q column/i);
  assert.throws(() => parseBatchCsv("q,unknown_col\ntest,1\n"), /Unsupported CSV/i);
  assert.throws(() => parseBatchCsv('q\n"unclosed'), /Unclosed quoted/i);
  const twentyOne = `q\n${Array.from({ length: 21 }, (_, i) => `item ${i}`).join("\n")}\n`;
  assert.throws(() => parseBatchCsv(twentyOne), /at most 20/i);

  const parsed = parseBatchCsv(
    '\uFEFFq,condition,window_days,min_price_cents\n"Switch, ""OLED""",like_new,90,1000\n',
  );
  assert.deepEqual(parsed, [
    { q: 'Switch, "OLED"', condition: "like_new", window_days: 90, min_price_cents: 1000 },
  ]);
});

test("merchant batch workflow enforces dedupe, 1-active cap, partial failure, atomic claim, cancel, revocation, and CSV safety", async () => {
  const x = await createProductFixture(db, roots, { keyword: "Batch Primary Console", claimed: true });
  const formulaKeyword = "=CMD(' /C calc'!A0), \"quoted\"";
  await seedQueryCorpus(x, formulaKeyword, 12);
  await seedQueryCorpus(x, "+LowSampleCard", 5);

  const otherUserId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`other-${randomUUID()}@example.test`, x.now()],
    )
  ).rows[0].id;
  const otherSecret = x.auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'other',$2,'sb_k_oth',$3)",
    [otherUserId, x.auth.crypto.hash("auth.api-key", otherSecret), ["sold:read", "jobs:read", "usage:read"]],
  );
  const otherHeaders = { Authorization: `Bearer ${otherSecret}` };

  // 1. 0-credit preview: covers 10-min reuse, in-batch dedupe, uncovered row, invalid row, low-sample/covered
  const csvInput = [
    "q,limit,window_days",
    '"Batch Primary Console",5,90',
    `"${formulaKeyword.replaceAll('"', '""')}",50,90`,
    `"${formulaKeyword.replaceAll('"', '""')}",50,90`,
    "+LowSampleCard,50,90",
    "Uncovered Missing Product,50,90",
    "Bad Window Row,50,999",
  ].join("\n");

  const previewRes = await x.app.request("/v1/batches/preview", {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ csv: csvInput }),
  });
  assert.equal(previewRes.status, 200);
  const preview = (await previewRes.json()).data;
  assert.equal(preview.total_rows, 6);
  assert.equal(preview.valid_rows, 5);
  assert.equal(preview.unique_executable_queries, 4);
  assert.equal(preview.duplicate_rows, 1);
  assert.equal(preview.invalid_rows, 1);
  assert.equal(preview.reusable_queries, 1); // Batch Primary Console
  assert.equal(preview.items[0].estimated_max_credits, 0); // already delivered 10m reuse
  assert.equal(preview.items[1].estimated_max_credits, 1); // formulaKeyword
  assert.equal(preview.items[2].deduplicated_in_batch, true);
  assert.equal(preview.items[2].primary_item_index, 1);
  assert.equal(preview.items[2].estimated_max_credits, 0);
  assert.equal(preview.items[5].valid, false);
  assert.equal(preview.max_estimated_credits, 2); // formulaKeyword + LowSampleCard (not yet run)

  // Verify 0 credits deducted by preview
  const balanceBefore = await x.billing.balance(x.user);
  assert.equal(balanceBefore.available_credits, 99); // 100 free - 1 from createProductFixture

  // 2. Submit batch idempotently (0 upfront charge) + conflict check + 1-active-batch-per-owner cap
  const createKey = `batch-create-${randomUUID()}`;
  const createRes = await x.app.request("/v1/batches", {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": createKey },
    body: JSON.stringify({ name: "Merchant Weekly Intake", csv: csvInput }),
  });
  assert.equal(createRes.status, 202);
  const created = await createRes.json();
  assert.equal(created.meta.credits_charged, 0);
  assert.equal(created.meta.reused, false);
  const batchId = created.data.id;
  assert.equal(created.data.status, "queued");
  assert.equal(created.data.total_items, 6);
  assert.equal(created.data.unique_query_count, 4);
  assert.equal(created.data.items[0].status, "delivered"); // 10-min delivered reuse
  assert.equal(created.data.items[1].status, "queued");
  assert.equal(created.data.items[2].query_id, created.data.items[1].query_id);
  assert.equal(created.data.items[4].status, "failed"); // uncovered offline
  assert.equal(created.data.items[4].error_code, "source_unavailable");
  assert.equal(created.data.items[5].status, "failed"); // invalid window 999

  // Exact idempotent replay returns same batch without error or double-submit
  const replayCreate = await x.app.request("/v1/batches", {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": createKey },
    body: JSON.stringify({ name: "Merchant Weekly Intake", csv: csvInput }),
  });
  assert.equal(replayCreate.status, 202);
  const replayData = await replayCreate.json();
  assert.equal(replayData.meta.reused, true);
  assert.equal(replayData.data.id, batchId);

  // Same key + different payload -> 409 idempotency_conflict
  const conflictCreate = await x.app.request("/v1/batches", {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": createKey },
    body: JSON.stringify({ name: "Different Name", csv: csvInput }),
  });
  assert.equal(conflictCreate.status, 409);

  // Second concurrent active batch rejected with 409 state_conflict
  const secondBatch = await x.app.request("/v1/batches", {
    method: "POST",
    headers: {
      ...x.headers,
      "Content-Type": "application/json",
      "Idempotency-Key": `batch-second-${randomUUID()}`,
    },
    body: JSON.stringify({ items: [{ q: formulaKeyword }] }),
  });
  assert.equal(secondBatch.status, 409);
  assert.equal((await secondBatch.json()).error.code, "state_conflict");

  // Cross-owner isolation (404 on get, claim, cancel, export)
  for (const [method, path, body] of [
    ["GET", `/v1/batches/${batchId}`, null],
    ["POST", `/v1/batches/${batchId}/claim`, {}],
    ["POST", `/v1/batches/${batchId}/cancel`, { version: 1 }],
    ["POST", `/v1/batches/${batchId}/export`, { format: "csv" }],
  ]) {
    const cross = await x.app.request(path, {
      method,
      headers: {
        ...otherHeaders,
        ...(body ? { "Content-Type": "application/json", "Idempotency-Key": randomUUID() } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(cross.status, 404, `${method} ${path} cross-owner should 404`);
  }

  // 3. Process queued child jobs -> items become ready_to_claim, stats withheld before claim!
  while (await x.query.workOnce("batch-worker")) {
    // drain queue
  }
  const readyView = (await (await x.app.request(`/v1/batches/${batchId}`, { headers: x.headers })).json())
    .data;
  assert.equal(readyView.status, "partial"); // items 0..3 succeeded, 4..5 failed
  assert.equal(readyView.items[1].status, "ready_to_claim");
  assert.equal(readyView.items[1].claimable, true);
  assert.equal(readyView.items[1].stats, null); // MUST withhold stats before explicit claim
  assert.equal(readyView.items[2].status, "ready_to_claim");
  assert.equal(readyView.items[3].status, "ready_to_claim"); // low sample (5)
  assert.equal(readyView.items[3].potential_credits, 0);

  // 4. Export before claim does not leak unclaimed item #1 prices (only already-delivered item #0 has stats)
  const preClaimExport = await x.app.request(`/v1/batches/${batchId}/export`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ format: "json" }),
  });
  assert.equal(preClaimExport.status, 200);
  const preJson = await preClaimExport.json();
  assert.equal(preJson.batch.items[1].stats, null);
  assert.ok(preJson.batch.items[0].stats.median_cents > 0);

  // 5. Claim whole batch with stable Idempotency-Key -> charges 1 credit once for formulaKeyword, 0 for low sample/dedupe/delivered
  const claimKey = `batch-claim-${randomUUID()}`;
  const claimRes = await x.app.request(`/v1/batches/${batchId}/claim`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": claimKey },
    body: JSON.stringify({}),
  });
  assert.equal(claimRes.status, 200);
  const claimed = await claimRes.json();
  assert.equal(claimed.meta.credits_charged, 1);
  assert.equal(claimed.data.credits_charged_now, 1);
  assert.equal(claimed.data.claimed_query_ids.length, 2); // formulaKeyword + LowSampleCard
  assert.equal(claimed.data.failed_items.length, 0);
  assert.equal(claimed.data.batch.items[1].status, "delivered");
  assert.ok(claimed.data.batch.items[1].stats.median_cents > 0);
  assert.equal(claimed.data.batch.items[2].status, "delivered"); // shares same delivered query
  assert.equal(claimed.data.batch.items[3].status, "delivered");
  assert.equal(claimed.data.batch.items[3].credits_charged, 0); // <8 samples is free
  assert.equal(claimed.data.batch.items[3].stats.median_cents, null); // small sample median is null

  // Replay claim after client disconnect -> 0 additional charges!
  const replayClaim = await x.app.request(`/v1/batches/${batchId}/claim`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": claimKey },
    body: JSON.stringify({}),
  });
  assert.equal(replayClaim.status, 200);
  const replayClaimBody = await replayClaim.json();
  assert.equal(replayClaimBody.meta.credits_charged, 0);

  // Conflicting subset claim with same key -> 409 idempotency_conflict
  const conflictClaim = await x.app.request(`/v1/batches/${batchId}/claim`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": claimKey },
    body: JSON.stringify({ item_indices: [1] }),
  });
  assert.equal(conflictClaim.status, 409);

  // 6. Malicious CSV export neutralization (formula starting with = and + escaped with leading ')
  const csvExport = await x.app.request(`/v1/batches/${batchId}/export`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ format: "csv" }),
  });
  assert.equal(csvExport.status, 200);
  assert.equal(csvExport.headers.get("Cache-Control"), "private, no-store");
  assert.match(csvExport.headers.get("Content-Type"), /text\/csv/);
  const csvBody = await csvExport.text();
  assert.match(csvBody, /"'=CMD\(' \/C calc'!A0\), ""quoted"""/);
  assert.match(csvBody, /"'\+LowSampleCard"/);

  // 7. Because batch 1 is now terminal ("partial"), owner can submit a new batch and cancel queued child jobs!
  await seedQueryCorpus(x, "-Cancel Target A", 10);
  await seedQueryCorpus(x, "@InsufficientTarget B", 10);
  const batch2Res = await x.app.request("/v1/batches", {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      name: "Cancelable Batch",
      items: [{ q: "-Cancel Target A" }, { q: "@InsufficientTarget B" }],
    }),
  });
  assert.equal(batch2Res.status, 202);
  const batch2 = (await batch2Res.json()).data;
  assert.equal(batch2.status, "queued");

  // Run only one child job while the other stays queued, then cancel batch!
  assert.equal((await x.query.workOnce("batch-worker-2")).status, "completed");
  const batch2Mid = (await (await x.app.request(`/v1/batches/${batch2.id}`, { headers: x.headers })).json())
    .data;
  const completedIdx = batch2Mid.items.findIndex((item) => item.status === "ready_to_claim");
  const queuedIdx = batch2Mid.items.findIndex((item) => item.status === "queued");
  assert.ok(completedIdx >= 0 && queuedIdx >= 0 && completedIdx !== queuedIdx);

  // Wrong version rejected
  const badCancel = await x.app.request(`/v1/batches/${batch2.id}/cancel`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ version: 99 }),
  });
  assert.equal(badCancel.status, 409);

  const cancelKey = `batch-cancel-${randomUUID()}`;
  const cancelRes = await x.app.request(`/v1/batches/${batch2.id}/cancel`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": cancelKey },
    body: JSON.stringify({ version: batch2Mid.version }),
  });
  assert.equal(cancelRes.status, 200);
  const cancelled = (await cancelRes.json()).data;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.items[completedIdx].status, "ready_to_claim"); // already-completed child preserved
  assert.equal(cancelled.items[queuedIdx].status, "cancelled");

  // Replay cancel succeeds cleanly
  const replayCancel = await x.app.request(`/v1/batches/${batch2.id}/cancel`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json", "Idempotency-Key": cancelKey },
    body: JSON.stringify({ version: batch2Mid.version }),
  });
  assert.equal(replayCancel.status, 200);

  // 8. Mid-batch insufficient credits handling (owner has 1 credit, tries claiming 2 fresh ready items -> 1 claimed, 1 fails 402-style in failed_items)
  await seedQueryCorpus(x, "Quota Item 1", 10);
  await seedQueryCorpus(x, "Quota Item 2", 10);
  const lowWalletOwner = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at) VALUES($1,'fixture','active',$2) RETURNING id",
      [`low-${randomUUID()}@example.test`, x.now()],
    )
  ).rows[0].id;
  await x.billing.grant(lowWalletOwner, {
    kind: "promo",
    provider: "soldbench",
    reference: `single-credit-${randomUUID()}`,
    amount: 1,
    expiresAt: new Date(Date.parse(x.now()) + 86400000),
  });
  const lowSecret = x.auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'low',$2,'sb_k_low',$3)",
    [lowWalletOwner, x.auth.crypto.hash("auth.api-key", lowSecret), ["sold:read", "jobs:read", "usage:read"]],
  );
  const lowHeaders = { Authorization: `Bearer ${lowSecret}` };

  const quotaBatchRes = await x.app.request("/v1/batches", {
    method: "POST",
    headers: { ...lowHeaders, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ items: [{ q: "Quota Item 1" }, { q: "Quota Item 2" }] }),
  });
  assert.equal(quotaBatchRes.status, 202);
  const quotaBatch = (await quotaBatchRes.json()).data;
  while (await x.query.workOnce("batch-worker-quota")) {
    // finish both
  }

  const partialClaimRes = await x.app.request(`/v1/batches/${quotaBatch.id}/claim`, {
    method: "POST",
    headers: { ...lowHeaders, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({}),
  });
  assert.equal(partialClaimRes.status, 200);
  const partialClaim = (await partialClaimRes.json()).data;
  assert.equal(partialClaim.credits_charged_now, 1);
  assert.equal(partialClaim.claimed_query_ids.length, 1);
  assert.equal(partialClaim.failed_items.length, 1);
  assert.equal(partialClaim.failed_items[0].code, "insufficient_credits");
  assert.equal(partialClaim.batch.items[0].status, "delivered");
  assert.equal(partialClaim.batch.items[1].status, "ready_to_claim");

  // Top up 1 credit and claim again -> only second item is charged!
  await x.billing.grant(lowWalletOwner, {
    kind: "promo",
    provider: "soldbench",
    reference: `topup-${randomUUID()}`,
    amount: 1,
    expiresAt: new Date(Date.parse(x.now()) + 86400000),
  });
  const secondClaimRes = await x.app.request(`/v1/batches/${quotaBatch.id}/claim`, {
    method: "POST",
    headers: { ...lowHeaders, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({}),
  });
  assert.equal(secondClaimRes.status, 200);
  const secondClaim = (await secondClaimRes.json()).data;
  assert.equal(secondClaim.credits_charged_now, 1);
  assert.equal(secondClaim.already_delivered_query_ids.length, 1);
  assert.equal(secondClaim.claimed_query_ids.length, 1);
  assert.equal(secondClaim.batch_total_credits_charged, 2);

  // 9. List owner's batches
  const listRes = await x.app.request("/v1/batches", { headers: x.headers });
  assert.equal(listRes.status, 200);
  const listed = (await listRes.json()).data;
  assert.equal(listed.items.length, 2);

  // 10. Source revocation hides delivered batch stats immediately on read and export
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    x.source.sourceId,
  ]);
  const afterRevoke = (await (await x.app.request(`/v1/batches/${batchId}`, { headers: x.headers })).json())
    .data;
  assert.equal(afterRevoke.items[0].rights_unavailable, true);
  assert.equal(afterRevoke.items[0].stats, null);
  assert.equal(afterRevoke.items[1].rights_unavailable, true);
  assert.equal(afterRevoke.items[1].stats, null);

  // Ledger reconciliation clean for both users (0 mismatched wallets)
  assert.deepEqual(await x.billing.reconcile(x.user), []);
  assert.deepEqual(await x.billing.reconcile(lowWalletOwner), []);
});
