import { createHash } from 'node:crypto';
import { inWindow, type SaleTime } from './time.ts';

export const ENGINE_VERSION = 'offline-exploration-1.1.1';
type Money = number | null;
export function cents(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_integer_cents');
  return BigInt(value);
}
function round(n: bigint, d: bigint): number {
  const result = (2n * n + d) / (2n * d);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount_out_of_range');
  return Number(result);
}
export function distribution(values: readonly number[]) {
  const prices = values.map(cents).sort((a, b) => a < b ? -1 : a > b ? 1 : 0), n = prices.length;
  const q = (num: number, den: number): Money => {
    if (n < 8) return null;
    const h = BigInt(n - 1) * BigInt(num), d = BigInt(den), i = Number(h / d), rem = h % d;
    return round(prices[i] * (d - rem) + prices[Math.min(i + 1, n - 1)] * rem, d);
  };
  const k = Math.floor(n / 20), kept = prices.slice(k, n - k);
  return {
    median_cents: q(1, 2), p25_cents: q(1, 4), p75_cents: q(3, 4),
    trimmed_mean_cents: n < 8 ? null : round(kept.reduce((sum, p) => sum + p, 0n), BigInt(kept.length)),
    observed_min_cents: n ? Number(prices[0]) : null,
    observed_max_cents: n ? Number(prices[n - 1]) : null,
  };
}

export type Candidate = {
  sourceId: string; eventKey: string | null; identityVerified: boolean;
  observationKey?: string;
  comparable: boolean; priceStatus: 'verified_actual' | 'displayed_only' | 'unknown';
  format: 'fixed_price' | 'best_offer' | 'auction'; currency: string;
  itemCents: Money; shippingCents: Money;
  shippingStatus: 'observed' | 'verified_free_shipping' | 'unknown';
  // USD conversions need a separate evidence reference; unsupported FX is excluded.
  usdConversion?: { itemCents: number; shippingCents: Money; evidenceRef: string };
  time: SaleTime;
};
export type Query = { sourceId: string; asOf: string; days: number; basis: 'item' | 'item_plus_observed_shipping'; limit: number };

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

export function candidateFromJson(value: unknown): Candidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_candidate');
  const record = value as Candidate;
  const validMoney = (amount: unknown) => amount === null || (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0);
  if (typeof record.sourceId !== 'string' || !record.sourceId ||
      !(record.eventKey === null || (typeof record.eventKey === 'string' && record.eventKey.length > 0)) ||
      typeof record.identityVerified !== 'boolean' || typeof record.comparable !== 'boolean' ||
      (record.eventKey === null && record.identityVerified) ||
      !['verified_actual', 'displayed_only', 'unknown'].includes(record.priceStatus) ||
      !['fixed_price', 'best_offer', 'auction'].includes(record.format) ||
      typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency) ||
      !validMoney(record.itemCents) || !validMoney(record.shippingCents) ||
      !['observed', 'verified_free_shipping', 'unknown'].includes(record.shippingStatus)) throw new Error('invalid_candidate');
  if (record.observationKey !== undefined && !/^[a-f0-9]{64}$/.test(record.observationKey)) throw new Error('invalid_candidate');
  if (record.usdConversion !== undefined && (!record.usdConversion ||
      !validMoney(record.usdConversion.itemCents) || record.usdConversion.itemCents === null ||
      !validMoney(record.usdConversion.shippingCents) || typeof record.usdConversion.evidenceRef !== 'string')) {
    throw new Error('invalid_candidate');
  }
  const time = record.time;
  if (!time || !['instant', 'day', 'unknown'].includes(time.precision) ||
      (time.precision !== 'unknown' && typeof time.value !== 'string') ||
      (time.precision === 'day' && !(time.timeZone === null || typeof time.timeZone === 'string'))) throw new Error('invalid_candidate');
  return structuredClone(record);
}

export function priceQualification(record: Candidate, basis: Query['basis']): { priceCents: Money; reason: string | null } {
  const excluded = (reason: string) => ({ priceCents: null, reason });
  if (record.priceStatus !== 'verified_actual') return excluded('unverified_actual_price');
  try { if (record.itemCents !== null) cents(record.itemCents); if (record.shippingCents !== null) cents(record.shippingCents); }
  catch { return excluded('invalid_integer_cents'); }
  let item = record.itemCents, shipping = record.shippingCents;
  if (record.currency !== 'USD') {
    if (!record.usdConversion?.evidenceRef.trim()) return excluded('missing_fx_evidence');
    item = record.usdConversion.itemCents; shipping = record.usdConversion.shippingCents;
  }
  if (item === null) return excluded('missing_item_price');
  try {
    const total = cents(item);
    if (basis === 'item') return { priceCents: Number(total), reason: null };
    if (record.shippingStatus === 'unknown' || shipping === null) return excluded('missing_shipping_evidence');
    if (record.shippingStatus === 'verified_free_shipping' && shipping !== 0) return excluded('inconsistent_free_shipping');
    const sum = total + cents(shipping);
    if (sum > BigInt(Number.MAX_SAFE_INTEGER)) return excluded('amount_out_of_range');
    return { priceCents: Number(sum), reason: null };
  } catch { return excluded('invalid_integer_cents'); }
}

export function evaluate(records: readonly Candidate[], query: Query) {
  if (!query.sourceId || ![30, 90, 180, 365].includes(query.days) || !['item', 'item_plus_observed_shipping'].includes(query.basis) ||
      !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) throw new Error('invalid_query');
  // Validate fixed clock/window even when there are no candidates.
  inWindow({ precision: 'unknown' }, query.asOf, query.days);
  const keyed = new Map<string, Candidate>(), conflicts = new Set<string>();
  const uncertain = new Set<string>();
  let unidentified = 0;
  for (const [index, record] of records.entries()) {
    if (record.sourceId !== query.sourceId) throw new Error('mixed_source_scope');
    if (!record.eventKey || !record.identityVerified) {
      unidentified++;
      const key = record.eventKey ? 'source-record:' + record.eventKey : record.observationKey ?? 'unkeyed-observation:' + index;
      uncertain.add(key);
      continue;
    }
    const previous = keyed.get(record.eventKey);
    if (previous && canonicalJson(previous) !== canonicalJson(record)) conflicts.add(record.eventKey);
    else keyed.set(record.eventKey, record);
  }
  const observed = [...keyed].filter(([key, r]) => !conflicts.has(key) && inWindow(r.time, query.asOf, query.days)).map(([, r]) => r);
  const comparable = observed.filter(r => r.comparable);
  const qualifications = comparable.map(record => ({ record, decision: priceQualification(record, query.basis) }));
  const verified = qualifications.flatMap(({ record, decision }) =>
    decision.priceCents === null ? [] : [{ record, price: decision.priceCents }]);
  const n = verified.length;
  return {
    engine_version: ENGINE_VERSION,
    candidate_set_hash: createHash('sha256').update(JSON.stringify(records.map(canonicalJson).sort())).digest('hex'),
    stats: {
      n_observed: keyed.size + uncertain.size, n_comparable: comparable.length, n_price_verified: n,
      n_excluded_unverified_price: comparable.length - n,
      sold_last_30d_observed: verified.filter(x => inWindow(x.record.time, query.asOf, 30)).length,
      ...distribution(verified.map(x => x.price)),
      buy_it_now_verified_count: verified.filter(x => x.record.format === 'fixed_price').length,
      best_offer_verified_count: verified.filter(x => x.record.format === 'best_offer').length,
      best_offer_displayed_only_count: comparable.filter(x => x.format === 'best_offer' && x.priceStatus === 'displayed_only').length,
    },
    quality: { data_insufficient: n < 8, quality_status: n < 8 ? 'insufficient_sample' : n < 30 ? 'limited_sample' : 'sufficient_sample',
      verified_share: comparable.length ? n / comparable.length : null, coverage_status: 'unknown', coverage_ratio: null, score: null },
    diagnostics: { unidentified_observations: unidentified, conflicting_event_keys: [...conflicts].sort(),
      duplicate_observations: records.length - unidentified - keyed.size,
      outside_window_events: keyed.size - conflicts.size - observed.length,
      hard_mismatch_events: observed.length - comparable.length,
      uncertain_candidates: uncertain.size,
      duplicate_uncertain_observations: unidentified - uncertain.size,
      excluded_before_comparable: {
        uncertain_identity: uncertain.size, event_identity_conflict: conflicts.size,
        outside_window: keyed.size - conflicts.size - observed.length,
        hard_attribute_mismatch: observed.length - comparable.length,
      },
      price_exclusions: qualifications.filter(x => x.decision.reason !== null)
        .map(x => ({ eventKey: x.record.eventKey, reason: x.decision.reason! })) },
    comps: verified.slice(0, query.limit).map(x => ({ eventKey: x.record.eventKey, priceCents: x.price })),
    available_comp_count: n,
  };
}
