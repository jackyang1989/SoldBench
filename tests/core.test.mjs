import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { distribution, evaluate, matchStrongAttributes, normalizeQuery, queryHash } from "@soldbench/core";
import { en, loadConfig, localeFrom, message, money, zhCN } from "@soldbench/shared";

test("normalized query identity preserves model punctuation, ignores header locale and rejects ambiguous inputs", () => {
  const a = normalizeQuery(new URLSearchParams("q=%20RTX++4070+Ti-Super%20&limit=50"));
  const b = normalizeQuery(
    new URLSearchParams(
      "limit=50&q=RTX+4070+Ti-Super&marketplace=ebay_us&window_days=90&allow_stale=false&price_basis=item_plus_observed_shipping",
    ),
  );
  assert.equal(a.q, "RTX 4070 Ti-Super");
  assert.equal(queryHash(a), queryHash(b));
  for (const query of [
    "q=x&q=y",
    "q=x&limit=0",
    "q=x&limit=201",
    "q=x&allow_stale=1",
    "q=x&category=",
    "q=x&marketplace=",
    "q=x&attr_grade=9",
    "q=x&unknown=x",
  ])
    assert.throws(() => normalizeQuery(new URLSearchParams(query)));
  assert.throws(
    () => normalizeQuery(new URLSearchParams("q=x&window_days=365")),
    (error) => error.status === 422,
  );
  assert.notEqual(queryHash(a), queryHash({ ...a, limit: 200 }));
  assert.equal(matchStrongAttributes({ grade: "PSA 9" }, { grade: "PSA 10" }).length, 1);
  assert.equal(matchStrongAttributes({ grade: "PSA 9" }, {}).length, 1);
});

test("shared core reproduces all golden fields and includes time, basis and versions in snapshot identity", () => {
  const fixture = JSON.parse(readFileSync(new URL("../v14_gameboy_58_verified.json", import.meta.url)));
  const query = {
    sourceId: "synthetic",
    asOf: fixture.as_of,
    days: 90,
    basis: "item_plus_observed_shipping",
    limit: 50,
  };
  const records = fixture.candidate_records.map((r) => ({
    sourceId: "synthetic",
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
  }));
  const result = evaluate(records, query);
  assert.deepEqual(result.stats, fixture.expected_stats);
  assert.deepEqual(result.quality, fixture.expected_quality);
  assert.equal(result.candidate_set_hash, evaluate(records, { ...query, limit: 1 }).candidate_set_hash);
  assert.notEqual(
    result.candidate_set_hash,
    evaluate(records, { ...query, asOf: "2026-11-14T07:00:00Z" }).candidate_set_hash,
  );
  assert.equal(distribution(Array(8).fill(Number.MAX_SAFE_INTEGER)).median_cents, Number.MAX_SAFE_INTEGER);
});

test("bilingual messages and parameters remain consistent and locale does not change currency", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  assert.equal(localeFrom("/zh-CN/account", "en"), "zh-CN");
  assert.equal(localeFrom("/", "zh-Hant, en;q=0.5"), "en");
  assert.equal(localeFrom("/", "zh-CN;q=0,en;q=1"), "en");
  assert.match(message("en", "results.sample", { count: 2 }), /2 verified comparables/);
  assert.match(message("zh-CN", "results.sample", { count: 2 }), /2 条/);
  for (const locale of ["en", "zh-CN"])
    for (const key of Object.keys(en))
      assert.equal(typeof message(locale, key, { count: 2, days: 90 }), "string");
  for (const changes of [
    { COLLECTOR_ENABLED: "true" },
    { PAYMENTS_MODE: "live" },
    { DATA_MODE: "approved_network" },
    { NODE_ENV: "production" },
  ])
    assert.throws(() => loadConfig(changes));
  assert.equal(loadConfig({ PORT: "4100" }).origin, "http://127.0.0.1:4100");
  assert.throws(() => loadConfig({ HOST: "0.0.0.0" }));
  assert.throws(() => loadConfig({ APP_ORIGIN: "https://soldbench.com" }));
  assert.equal(money("en", 2), "$0.02");
  assert.match(money("en", Number.MAX_SAFE_INTEGER), /\.91$/);
  assert.throws(() => money("en", 0.5));
});
