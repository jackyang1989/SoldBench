import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { distribution, evaluate, type Candidate } from '../src/pricing.ts';
import { instant, inWindow, localDay } from '../src/time.ts';

const asOf = '2026-11-14T06:00:00Z';
const query = { sourceId: 'synthetic', asOf, days: 90, basis: 'item_plus_observed_shipping' as const, limit: 50 };
const row = (overrides: Partial<Candidate> = {}): Candidate => ({ sourceId: 'synthetic', eventKey: 'event-1', identityVerified: true,
  comparable: true, priceStatus: 'verified_actual', format: 'fixed_price', currency: 'USD', itemCents: 100,
  shippingCents: 0, shippingStatus: 'verified_free_shipping', time: { precision: 'instant', value: '2026-11-01T00:00:00Z' }, ...overrides });

test('all 121 golden records reproduce all 14 statistics and all 6 quality fields', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../v14_gameboy_58_verified.json', import.meta.url), 'utf8'));
  // Legacy oracle supplies UTC instants even though metadata says day. Only this
  // synthetic adapter uses sold_at as an instant; it is not an eBay date parser.
  const records = fixture.candidate_records.map((r: any) => row({ eventKey: r.sale_event_id, comparable: r.is_comparable,
    priceStatus: r.sale_price_status, format: r.sale_format, currency: r.currency ?? 'USD',
    itemCents: r.item_price_cents ?? null, shippingCents: r.observed_shipping_cents ?? null,
    shippingStatus: r.observed_shipping_status ?? 'unknown', time: { precision: 'instant', value: r.sold_at } }));
  const result = evaluate(records, query);
  assert.deepEqual(result.stats, fixture.expected_stats);
  assert.deepEqual(result.quality, fixture.expected_quality);
  assert.equal(result.comps.length, 50); assert.equal(result.available_comp_count, 58);
  const limited = evaluate(records, { ...query, limit: 1 });
  assert.deepEqual(limited.stats, result.stats); assert.equal(limited.candidate_set_hash, result.candidate_set_hash);
});

test('0/1/7/8/29/30/58 samples and large safe cents cross-check Python Fraction oracle', () => {
  const arrays = [0, 1, 7, 8, 29, 30, 58].map(n => Array.from({ length: n }, (_, i) => 11 + (i * 997 % 107)));
  arrays.push([0, 0, 0, 0, 1, 1, 1, 1]);
  arrays.push(Array(58).fill(Number.MAX_SAFE_INTEGER));
  // Independent existing Python oracle, not a second copy of the TS algorithm.
  const oracle = spawnSync('python3', ['-c', 'import sys,json;sys.path.insert(0,"../tools");from verify_fixture import summary;print(json.dumps([summary(v) for v in json.load(sys.stdin)]))'],
    { cwd: new URL('..', import.meta.url), input: JSON.stringify(arrays), encoding: 'utf8' });
  assert.equal(oracle.status, 0, oracle.stderr);
  assert.deepEqual(arrays.map(distribution), JSON.parse(oracle.stdout));
  for (const n of [0, 7, 8, 29, 30, 58]) {
    const r = evaluate(Array.from({ length: n }, (_, i) => row({ eventKey: `e-${i}`, itemCents: 0 })), query);
    assert.equal(r.quality.quality_status, n < 8 ? 'insufficient_sample' : n < 30 ? 'limited_sample' : 'sufficient_sample');
    assert.equal(r.quality.score, null); assert.equal(r.stats.median_cents, n < 8 ? null : 0);
  }
  assert.equal(distribution([0, 0, 0, 0, 1, 1, 1, 1]).median_cents, 1);
  assert.throws(() => distribution([0.5])); assert.throws(() => distribution([-1]));
  assert.throws(() => distribution([Number.MAX_SAFE_INTEGER + 1]));
});

test('price eligibility preserves unknowns, shipping basis and FX evidence', () => {
  for (const change of [ { priceStatus: 'displayed_only' }, { priceStatus: 'unknown' }, { itemCents: null },
    { shippingCents: null }, { shippingStatus: 'unknown' }, { currency: 'EUR' }, { itemCents: -1 },
    { shippingCents: 1 }, { itemCents: Number.MAX_SAFE_INTEGER, shippingCents: 1, shippingStatus: 'observed' } ] as Partial<Candidate>[]) {
    assert.equal(evaluate([row(change)], query).stats.n_price_verified, 0, JSON.stringify(change));
  }
  assert.equal(evaluate([row({ shippingCents: null, shippingStatus: 'unknown' })], { ...query, basis: 'item' }).stats.n_price_verified, 1);
  const fx = row({ currency: 'EUR', usdConversion: { itemCents: 120, shippingCents: 0, evidenceRef: 'synthetic-fx-evidence' } });
  assert.equal(evaluate([fx], query).stats.observed_min_cents, 120);
  assert.equal(evaluate([row({ ...fx, usdConversion: { ...fx.usdConversion!, evidenceRef: '' } })], query).stats.n_price_verified, 0);
  assert.equal(evaluate([row({ comparable: false })], query).stats.n_comparable, 0);
});

test('event identity, repeat observations, conflicts and source scope fail conservatively', () => {
  assert.equal(evaluate([row(), row()], query).stats.n_price_verified, 1);
  assert.equal(evaluate([row({ eventKey: null }), row({ identityVerified: false })], query).stats.n_price_verified, 0);
  const conflict = evaluate([row(), row({ itemCents: 101 })], query);
  assert.equal(conflict.stats.n_price_verified, 0); assert.deepEqual(conflict.diagnostics.conflicting_event_keys, ['event-1']);
  assert.notEqual(conflict.candidate_set_hash, evaluate([row()], query).candidate_set_hash);
  assert.equal(evaluate([row({ eventKey: 'e2' }), row()], query).candidate_set_hash,
    evaluate([row(), row({ eventKey: 'e2' })], query).candidate_set_hash);
  assert.throws(() => evaluate([row({ sourceId: 'other' })], query), /mixed_source/);
  assert.throws(() => evaluate([], { ...query, limit: 201 }));
  assert.throws(() => evaluate([], { ...query, days: 45 }), /invalid_query/);
});

test('exact window is lower-exclusive upper-inclusive, and malformed dates are excluded', () => {
  const start = new Date(instant(asOf) - 90 * 86_400_000).toISOString();
  const t = (value: string) => inWindow({ precision: 'instant', value }, asOf, 90);
  assert.equal(t(start), false); assert.equal(t(new Date(instant(start) + 1).toISOString()), true);
  assert.equal(t(asOf), true); assert.equal(t('2026-11-14T06:00:00.001Z'), false);
  assert.equal(t('2026-02-30T00:00:00Z'), false); assert.equal(t('2026-11-14T06:00:00'), false);
  assert.throws(() => evaluate([], { ...query, asOf: 'bad' }));
});

test('local dates respect IANA DST, whole-day containment and unknown precision', () => {
  const spring = localDay('2026-03-08', 'America/New_York'), fall = localDay('2026-11-01', 'America/New_York');
  assert.equal(spring[1] - spring[0], 23 * 3_600_000); assert.equal(fall[1] - fall[0], 25 * 3_600_000);
  assert.equal(new Date(spring[0]).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(new Date(fall[1]).toISOString(), '2026-11-02T05:00:00.000Z');
  const day = { precision: 'day' as const, value: '2026-11-01', timeZone: 'America/New_York' };
  assert.equal(inWindow(day, '2026-11-02T05:00:00Z', 2), true);
  assert.equal(inWindow(day, '2026-11-02T04:59:59Z', 2), false);
  assert.equal(inWindow(day, '2026-11-02T05:00:00Z', 1), false);
  assert.equal(inWindow({ ...day, timeZone: null }, asOf, 90), false);
  assert.equal(inWindow({ ...day, timeZone: 'invalid' }, asOf, 90), false);
  assert.equal(inWindow({ precision: 'unknown' }, asOf, 90), false);
  assert.throws(() => localDay('2011-12-30', 'Pacific/Apia'), /nonexistent/);
});
