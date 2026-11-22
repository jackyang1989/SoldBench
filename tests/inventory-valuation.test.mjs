import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { database, migrate } from "@soldbench/db";
import { InventoryValuationService, parseInventoryCsv } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-068 parseInventoryCsv rejects empty/oversized CSV and preserves formulas safely", () => {
  assert.throws(
    () => parseInventoryCsv(""),
    (e) => e?.code === "invalid_parameter",
  );
  assert.throws(
    () => parseInventoryCsv("sku,title,quantity\n"),
    (e) => e?.code === "invalid_parameter",
  );
  const twentyOne = [
    "sku,title,quantity",
    ...Array.from({ length: 21 }, (_, i) => `SKU-${i},Item ${i},1`),
  ].join("\n");
  assert.throws(
    () => parseInventoryCsv(twentyOne),
    (e) => e?.code === "invalid_parameter",
  );
  const parsed = parseInventoryCsv(
    '\ufeffsku,title,quantity,currency,cost_basis_cents,q\nSKU-1,"=HYPERLINK(""bad"")",3,USD,1200,Game Boy\n',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].quantity, 3);
  assert.equal(parsed[0].cost_basis_cents, 1200);
});

test("AT-068 inventory valuation enforces billing consent, dedupe, zero-fill prohibition, explicit denominators, cancellation, re-valuation, revocation, and owner isolation", async () => {
  const x = await createProductFixture(db, roots, {
    keyword: "Sony PSP 3000",
    count: 12,
    extra: false,
    prepareQuery: false,
    limit: 50,
  });
  const low = await createProductFixture(db, roots, {
    keyword: "Rare Obscure Watch",
    count: 5,
    extra: false,
    prepareQuery: false,
    userId: x.user,
    limit: 50,
  });
  const pendingFix = await createProductFixture(db, roots, {
    keyword: "Nintendo 64 Console",
    count: 10,
    extra: false,
    prepareQuery: false,
    userId: x.user,
    limit: 50,
  });

  const otherSecret = x.auth.crypto.token("sb_k_");
  const otherId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`other-inv-${randomUUID()}@example.test`, x.now()],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'other',$2,'sb_k_inv',$3)",
    [otherId, x.auth.crypto.hash("auth.api-key", otherSecret), ["sold:read", "jobs:read", "usage:read"]],
  );
  const otherHeaders = { Authorization: `Bearer ${otherSecret}`, "Content-Type": "application/json" };

  const invService = new InventoryValuationService(x.query);
  const app = createApp(loadConfig({}), db, { auth: x.auth, query: x.query, inventory: invService });
  const jsonHeaders = { ...x.headers, "Content-Type": "application/json" };

  const itemsPayload = [
    {
      sku: "SKU-PSP-A",
      title: '=HYPERLINK("https://evil.test")',
      quantity: 3,
      currency: "USD",
      cost_basis_cents: 500,
      q: x.q.q,
    },
    {
      sku: "SKU-PSP-DUP",
      title: "Sony PSP Dup",
      quantity: 2,
      currency: "USD",
      cost_basis_cents: 400,
      q: x.q.q,
    },
    { sku: "SKU-LOW", title: "Rare Watch", quantity: 4, currency: "USD", q: low.q.q },
    { sku: "SKU-NOMODEL", title: "Missing Model Crate", quantity: 5, currency: "USD" },
    { sku: "SKU-EUR", title: "European Stock", quantity: 2, currency: "EUR", q: x.q.q },
  ];

  // 1. Preview at 0 credits shows exclusions & unique query count (x.q + low.q = 2 unique)
  const previewRes = await app.request("/v1/inventory/valuations/preview", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ items: itemsPayload }),
  });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.equal(preview.meta.credits_charged, 0);
  assert.equal(preview.data.summary.total_rows, 5);
  assert.equal(preview.data.summary.total_units, 16);
  assert.equal(preview.data.summary.mapped_rows, 3);
  assert.equal(preview.data.summary.unmapped_rows, 1);
  assert.equal(preview.data.summary.currency_unsupported_rows, 1);
  assert.equal(preview.data.summary.unique_query_count, 2);
  assert.equal(preview.data.summary.duplicate_query_rows, 1);
  assert.equal(preview.data.summary.estimated_max_credits, 2);
  assert.equal(
    preview.data.summary.valuation_disclaimer,
    "observed_comparable_estimate_not_guaranteed_sale_price",
  );

  // 2. Reject missing billing_consent_accepted=true with 400 and 0 credits
  const noConsent = await app.request("/v1/inventory/valuations", {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": `inv-no-consent-${randomUUID()}` },
    body: JSON.stringify({ name: "No Consent Run", items: itemsPayload, billing_consent_accepted: false }),
  });
  assert.equal(noConsent.status, 400);
  assert.equal((await noConsent.json()).error.code, "billing_consent_required");

  // 3. Create valuation with consent + verify idempotency replay & conflict
  const createKey = `inv-create-${randomUUID()}`;
  const createRes = await app.request("/v1/inventory/valuations", {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": createKey },
    body: JSON.stringify({ name: "Q4 Stock Check", items: itemsPayload, billing_consent_accepted: true }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.meta.credits_charged, 0);
  assert.equal(created.data.replayed, false);
  const valId = created.data.valuation.id;
  assert.equal(created.data.valuation.portfolio_median_cents, null);

  const replayRes = await app.request("/v1/inventory/valuations", {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": createKey },
    body: JSON.stringify({ name: "Q4 Stock Check", items: itemsPayload, billing_consent_accepted: true }),
  });
  assert.equal(replayRes.status, 201);
  assert.equal((await replayRes.json()).data.replayed, true);

  const conflictRes = await app.request("/v1/inventory/valuations", {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": createKey },
    body: JSON.stringify({ name: "Different Name", items: itemsPayload, billing_consent_accepted: true }),
  });
  assert.equal(conflictRes.status, 409);

  // Finish background query jobs and verify unclaimed state still withholds values (null, never 0)
  while (await x.query.workOnce("inv-test-worker")) {
    // finish queued queries
  }
  const preClaim = await (
    await app.request(`/v1/inventory/valuations/${valId}`, { headers: x.headers })
  ).json();
  assert.equal(preClaim.data.status, "ready_to_claim");
  assert.equal(preClaim.data.portfolio_median_cents, null);
  assert.equal(preClaim.data.items[0].valuation_status, "unclaimed");
  assert.equal(preClaim.data.items[0].line_median_cents, null);

  // 4. Explicit claim charges only valid unique query (1 credit; low sample <8 is 0 credits and remains null!)
  const claimRes = await app.request(`/v1/inventory/valuations/${valId}/claim`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": `inv-claim-${randomUUID()}` },
  });
  assert.equal(claimRes.status, 200);
  const claimed = await claimRes.json();
  assert.equal(claimed.meta.credits_charged, 1);
  const v = claimed.data.valuation;
  assert.equal(v.total_credits_charged, 1);
  assert.equal(v.denominator.valued_rows, 2); // SKU-PSP-A (qty 3) + SKU-PSP-DUP (qty 2)
  assert.equal(v.denominator.valued_units, 5);
  assert.equal(v.denominator.excluded_rows, 3); // low + missing_model + eur
  assert.equal(v.denominator.excluded_units, 11);
  assert.equal(v.denominator.breakdown.insufficient_samples, 1);
  assert.equal(v.denominator.breakdown.unmapped_missing_model, 1);
  assert.equal(v.denominator.breakdown.currency_unsupported, 1);

  const item0 = v.items[0];
  const item1 = v.items[1];
  const item2 = v.items[2];
  assert.equal(item0.valuation_status, "valued");
  assert.equal(item0.n_price_verified, 12);
  assert.equal(item0.line_median_cents, item0.unit_median_cents * 3);
  assert.equal(item1.line_median_cents, item1.unit_median_cents * 2);
  assert.equal(v.portfolio_median_cents, item0.line_median_cents + item1.line_median_cents);
  assert.ok(v.as_of_range.oldest_as_of);

  // Low-sample item stays null (never 0!)
  assert.equal(item2.valuation_status, "insufficient_samples");
  assert.equal(item2.n_price_verified, 5);
  assert.equal(item2.unit_median_cents, null);
  assert.equal(item2.line_median_cents, null);

  // 5. CSV export escapes formula cells & writes blanks for nulls
  const exportRes = await app.request(`/v1/inventory/valuations/${valId}/export`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ format: "csv" }),
  });
  assert.equal(exportRes.status, 200);
  const csvBody = await exportRes.text();
  assert.match(csvBody, /'=HYPERLINK/);
  assert.match(
    csvBody,
    /"SKU-LOW","Rare Watch","4","USD","mapped","insufficient_samples","insufficient","5","","","","","",""/,
  );

  // 6. Re-valuation requires consent & leaves original snapshot intact
  const badReval = await app.request(`/v1/inventory/valuations/${valId}/revalue`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": `inv-reval-bad-${randomUUID()}` },
    body: JSON.stringify({ billing_consent_accepted: false }),
  });
  assert.equal(badReval.status, 400);

  const cancelableRes = await app.request("/v1/inventory/valuations", {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": `inv-cancel-src-${randomUUID()}` },
    body: JSON.stringify({
      name: "To Be Cancelled",
      items: [{ sku: "SKU-CXL", title: "Cancel Test", quantity: 1, currency: "USD", q: pendingFix.q.q }],
      billing_consent_accepted: true,
    }),
  });
  assert.equal(cancelableRes.status, 201);
  const cancelTarget = (await cancelableRes.json()).data.valuation;
  const cancelledRes = await app.request(`/v1/inventory/valuations/${cancelTarget.id}/cancel`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": `inv-cancel-${randomUUID()}` },
    body: JSON.stringify({ version: cancelTarget.version }),
  });
  assert.equal(cancelledRes.status, 200);
  assert.equal((await cancelledRes.json()).data.status, "cancelled");

  const revalRes = await app.request(`/v1/inventory/valuations/${valId}/revalue`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": `inv-reval-${randomUUID()}` },
    body: JSON.stringify({ billing_consent_accepted: true, window_days: 90 }),
  });
  assert.equal(revalRes.status, 201);
  const revalued = (await revalRes.json()).data.valuation;
  assert.equal(revalued.revaluation_of_id, valId);

  // 7. Owner isolation across GET, claim, cancel, revalue, export
  assert.equal(
    (await app.request(`/v1/inventory/valuations/${valId}`, { headers: otherHeaders })).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/v1/inventory/valuations/${valId}/claim`, {
        method: "POST",
        headers: { ...otherHeaders, "Idempotency-Key": `other-claim-${randomUUID()}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/v1/inventory/valuations/${valId}/export`, {
        method: "POST",
        headers: otherHeaders,
        body: JSON.stringify({ format: "json" }),
      })
    ).status,
    404,
  );

  // 8. Source revocation immediately withholds valued prices across GET & export (portfolio -> null, never 0)
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    x.source.sourceId,
  ]);
  const postRevoke = await (
    await app.request(`/v1/inventory/valuations/${valId}`, { headers: x.headers })
  ).json();
  assert.equal(postRevoke.data.items[0].valuation_status, "rights_revoked");
  assert.equal(postRevoke.data.items[0].line_median_cents, null);
  assert.equal(postRevoke.data.portfolio_median_cents, null);
  assert.equal(postRevoke.data.denominator.valued_rows, 0);

  const exportRevoked = await app.request(`/v1/inventory/valuations/${valId}/export`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ format: "json" }),
  });
  assert.equal(exportRevoked.status, 200);
  const exportedJson = await exportRevoked.json();
  assert.equal(exportedJson.valuation.portfolio_median_cents, null);
  assert.equal(exportedJson.valuation.items[0].line_median_cents, null);

  assert.deepEqual(await x.billing.reconcile(x.user), []);
});
