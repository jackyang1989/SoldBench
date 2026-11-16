import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateFromJson,
  evaluate,
  normalizeQuery,
  parsePresentationSort,
  queryHash,
} from "@soldbench/core";

const asOf = "2026-11-16T12:00:00Z";
const base = { sourceId: "fixture", asOf, days: 90, basis: "item", limit: 50 };
const record = (i, changes = {}) => ({
  sourceId: "fixture",
  eventKey: `event-${String(i).padStart(3, "0")}`,
  identityVerified: true,
  comparable: true,
  priceStatus: "verified_actual",
  format: "fixed_price",
  currency: "USD",
  itemCents: 1000,
  shippingCents: 100,
  shippingStatus: "observed",
  time: { precision: "instant", value: "2026-11-15T12:00:00Z" },
  ...changes,
});
const many = (n, changes = {}) => Array.from({ length: n }, (_, i) => record(i, changes));

test("price ranges validate exactly, participate in semantic identity, and include both endpoints", () => {
  const parsed = normalizeQuery(
    new URLSearchParams("q=GameBoy&min_price_cents=0000&max_price_cents=1200&sale_format=auction"),
  );
  assert.equal(parsed.min_price_cents, 0);
  assert.equal(parsed.sale_format, "auction");
  assert.notEqual(queryHash(parsed), queryHash({ ...parsed, max_price_cents: 1201 }));
  for (const value of [
    "min_price_cents=-1",
    "min_price_cents=1.0",
    "min_price_cents=1e2",
    "min_price_cents=9007199254740992",
    "min_price_cents=2&max_price_cents=1",
    "sale_format=unknown",
    "min_price_cents=1&min_price_cents=1",
  ])
    assert.throws(() => normalizeQuery(new URLSearchParams(`q=x&${value}`)));
  const rows = [
    record(0, { itemCents: 999 }),
    record(1, { itemCents: 1000 }),
    record(2, { itemCents: 1200 }),
    record(3, { itemCents: 1201 }),
    record(4, { priceStatus: "displayed_only", format: "best_offer" }),
  ];
  const result = evaluate(rows, { ...base, minPriceCents: 1000, maxPriceCents: 1200 });
  assert.equal(result.stats.n_price_verified, 2);
  assert.equal(result.stats.n_comparable, 3);
  assert.equal(result.diagnostics.query_filter_events, 2);
  assert.equal(result.stats.n_excluded_unverified_price, 1);
  assert.equal(
    result.stats.n_observed,
    result.stats.n_comparable +
      Object.values(result.diagnostics.excluded_before_comparable).reduce((a, b) => a + b, 0),
  );
  assert.notEqual(result.candidate_set_hash, evaluate(rows, base).candidate_set_hash);
  assert.equal(evaluate(rows, { ...base, saleFormat: "auction" }).stats.n_price_verified, 0);
});

test("supplemental statistics obey 0/7/8/29/30/58 thresholds and ordinary mean is distinct from trim", () => {
  for (const n of [0, 7, 8, 29, 30, 58]) {
    const r = evaluate(many(n), base);
    assert.equal(r.supplemental_stats.mean_cents, n < 8 ? null : 1000);
    assert.equal(r.supplemental_stats.by_format.fixed_price.median_cents, n < 8 ? null : 1000);
  }
  const rows = many(30);
  rows[29].itemCents = 31000;
  const r = evaluate(rows, base);
  assert.equal(r.stats.trimmed_mean_cents, 1000);
  assert.equal(r.supplemental_stats.mean_cents, 2000);
  assert.equal(
    evaluate(many(8, { itemCents: Number.MAX_SAFE_INTEGER }), base).supplemental_stats.mean_cents,
    Number.MAX_SAFE_INTEGER,
  );
  const half = many(8);
  half[0].itemCents = 1004;
  assert.equal(evaluate(half, base).supplemental_stats.mean_cents, 1001);
});

test("shipping and seller summaries expose missing data and never merge destinations", () => {
  const rows = many(8, { shippingContextRef: "destination-A", sellerRef: "approved-seller-1" });
  rows[0] = { ...rows[0], shippingCents: 0, shippingStatus: "verified_free_shipping" };
  rows[1] = { ...rows[1], shippingCents: 0 };
  rows.push(
    record(8, { shippingContextRef: "destination-B", sellerRef: "approved-seller-2" }),
    record(9, { shippingCents: null, shippingStatus: "unknown" }),
  );
  const result = evaluate(rows, base).supplemental_stats;
  assert.equal(result.shipping_summary.groups.length, 2);
  assert.equal(result.shipping_summary.groups[0].known_count, 8);
  assert.equal(result.shipping_summary.groups[0].mean_shipping_cents, 75);
  assert.equal(result.shipping_summary.groups[0].free_count, 1);
  assert.equal(result.shipping_summary.groups[0].free_share, 1 / 8);
  assert.equal(result.shipping_summary.groups[1].mean_shipping_cents, null);
  assert.equal(result.shipping_summary.unknown_or_withheld_count, 1);
  assert.equal(result.seller_summary.distinct_count, 2);
  assert.equal(result.seller_summary.unknown_or_withheld_count, 1);
  const absent = evaluate(many(8), base).supplemental_stats;
  assert.equal(absent.seller_summary.distinct_count, null);
  assert.equal(absent.shipping_summary.groups.length, 0);
  assert.equal(absent.shipping_summary.unknown_or_withheld_count, 8);
});

test("format groups exclude displayed offers and independently suppress low sample medians", () => {
  const rows = [
    ...many(6),
    record(6, { format: "best_offer", itemCents: 900 }),
    record(7, { format: "best_offer", priceStatus: "displayed_only", itemCents: 999999 }),
    record(8, { format: "auction" }),
  ];
  const r = evaluate(rows, base);
  assert.equal(r.stats.n_price_verified, 8);
  assert.equal(r.supplemental_stats.by_format.fixed_price.median_cents, null);
  assert.equal(r.supplemental_stats.by_format.best_offer.sample_count, 1);
  assert.equal(r.supplemental_stats.by_format.best_offer.median_cents, null);
});

test("recent comparisons require both complete periods, sufficient samples and a nonzero baseline", () => {
  const rows = [
    ...many(8, { itemCents: 1100 }),
    ...many(8, { itemCents: 1000, time: { precision: "instant", value: "2026-10-01T12:00:00Z" } }).map(
      (r, i) => ({ ...r, eventKey: `previous-${i}` }),
    ),
  ];
  assert.equal(evaluate(rows, base).supplemental_stats.change_ratio, null);
  const q = { ...base, observationCoverage: [{ start: "2026-08-18T12:00:00Z", end: asOf }] };
  assert.deepEqual(evaluate(rows, q).supplemental_stats.change_ratio, {
    numerator_cents: 100,
    denominator_cents: 1000,
  });
  assert.equal(evaluate(rows, { ...q, days: 30 }).supplemental_stats.change_ratio, null);
  assert.equal(
    evaluate(rows, { ...q, observationCoverage: [{ start: "2026-09-17T12:00:01Z", end: asOf }] })
      .supplemental_stats.change_ratio,
    null,
  );
  assert.equal(
    evaluate(
      rows.map((r) => (r.eventKey.startsWith("previous-") ? { ...r, itemCents: 0 } : r)),
      q,
    ).supplemental_stats.change_ratio,
    null,
  );
});

test("time buckets distinguish no records from coverage gaps and do not drop eligible UTC day records", () => {
  const rows = many(8, { time: { precision: "day", value: "2026-11-15", timeZone: "UTC" } });
  const r = evaluate(rows, { ...base, days: 30 }).supplemental_stats.time_series;
  const bucket = r.buckets.find((b) => b.start === "2026-11-15T00:00:00.000Z");
  assert.equal(bucket.sample_count, 8);
  assert.equal(bucket.median_cents, 1000);
  assert.equal(r.unassigned_count, 0);
  assert.ok(
    r.buckets.some(
      (b) => b.sample_count === 0 && b.median_cents === null && b.observation_coverage === "unknown",
    ),
  );
  const limited = evaluate(rows.slice(0, 7), { ...base, days: 30 }).supplemental_stats.time_series;
  assert.ok(limited.buckets.every((b) => b.median_cents === null));
});

test("presentation reorders the complete snapshot before limit without changing statistics or identity", () => {
  const rows = [
    record(0, { itemCents: 900, title: "B" }),
    record(1, { itemCents: 100, title: "A", shippingCents: null, shippingStatus: "unknown" }),
    ...many(8).map((r, i) => ({ ...r, eventKey: `rest-${i}` })),
  ];
  const a = evaluate(rows, { ...base, limit: 1, presentationSort: "price_asc" });
  const b = evaluate(rows, { ...base, limit: 1, presentationSort: "price_desc" });
  assert.equal(a.comps[0].priceCents, 100);
  assert.equal(b.comps[0].priceCents, 1000);
  assert.deepEqual(a.stats, b.stats);
  assert.deepEqual(a.supplemental_stats, b.supplemental_stats);
  assert.equal(a.candidate_set_hash, b.candidate_set_hash);
  assert.equal(
    evaluate(rows, { ...base, presentationSort: "shipping_desc" }).comps.at(-1).eventKey,
    "event-001",
  );
  assert.deepEqual(
    rows.map((r) => r.eventKey),
    ["event-000", "event-001", ...Array.from({ length: 8 }, (_, i) => `rest-${i}`)],
  );
  assert.throws(() => parsePresentationSort("rank"));
  assert.throws(() => candidateFromJson(record(0, { sellerRef: 123 })));
});
