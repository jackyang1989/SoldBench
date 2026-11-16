import type { Candidate } from "./pricing.ts";
import { distribution } from "./statistics.ts";
import { instant, localDay } from "./time.ts";

const DAY = 86_400_000;
export type PricedCandidate = { record: Candidate; price: number };
/** Approved collector coverage only, scoped to the same filters and snapshot.
 * Complete here means planned source observations, never the entire market. */
export type ObservationCoverage = { start: string; end: string };
export type PresentationSort =
  `${"date" | "title" | "price" | "shipping" | "total" | "condition" | "seller"}_${"asc" | "desc"}`;
const sortFields = ["date", "title", "price", "shipping", "total", "condition", "seller"];
export function parsePresentationSort(value = "date_desc"): PresentationSort {
  if (!sortFields.some((field) => value === `${field}_asc` || value === `${field}_desc`))
    throw new Error("invalid_presentation_sort");
  return value as PresentationSort;
}
function interval(record: Candidate): [number, number] | null {
  try {
    if (record.time.precision === "instant") {
      const t = instant(record.time.value);
      return [t, t];
    }
    if (record.time.precision === "day" && record.time.timeZone)
      return localDay(record.time.value, record.time.timeZone);
  } catch {
    /* Unknown/malformed dates do not become capture timestamps. */
  }
  return null;
}
function within(
  row: PricedCandidate,
  start: number,
  end: number,
  bucket = false,
  span = interval(row.record),
): boolean {
  return Boolean(
    span &&
      (bucket && row.record.time.precision === "day" ? span[0] >= start : span[0] > start) &&
      span[1] <= end,
  );
}
function shipping(row: PricedCandidate): number | null {
  const r = row.record;
  const value =
    r.currency === "USD"
      ? r.shippingCents
      : r.usdConversion?.evidenceRef.trim()
        ? r.usdConversion.shippingCents
        : null;
  if (
    r.shippingStatus === "unknown" ||
    value === undefined ||
    value === null ||
    !Number.isSafeInteger(value) ||
    value < 0
  )
    return null;
  if (r.shippingStatus === "verified_free_shipping" && value !== 0) return null;
  return value;
}
function item(row: PricedCandidate): number | null {
  return row.record.currency === "USD" ? row.record.itemCents : (row.record.usdConversion?.itemCents ?? null);
}
/** Pure presentation ordering, no mutation or selection/charging side effects. */
export function sortComparables(
  rows: readonly PricedCandidate[],
  sort: PresentationSort = "date_desc",
): PricedCandidate[] {
  parsePresentationSort(sort);
  const intervals = new Map(rows.map((row) => [row.record, interval(row.record)]));
  const [field, direction] = sort.split("_");
  const value = (row: PricedCandidate): string | number | null => {
    switch (field) {
      case "date":
        return intervals.get(row.record)?.[0] ?? null;
      case "title":
        return row.record.title ?? null;
      case "condition":
        return row.record.condition ?? null;
      case "seller":
        return row.record.sellerDisplayName ?? null;
      case "price":
        return row.price;
      case "shipping":
        return shipping(row);
      case "total": {
        const cost = item(row),
          freight = shipping(row);
        return cost !== null && freight !== null && Number.isSafeInteger(cost + freight)
          ? cost + freight
          : null;
      }
      default:
        throw new Error("invalid_presentation_sort");
    }
  };
  return [...rows].sort((a, b) => {
    const x = value(a),
      y = value(b);
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    const order = x === null || y === null ? 0 : x < y ? -1 : x > y ? 1 : 0;
    if (order) return direction === "asc" ? order : -order;
    return (a.record.eventKey ?? "").localeCompare(b.record.eventKey ?? "", "en");
  });
}
function mean(values: readonly number[]): number | null {
  if (values.length < 8) return null;
  const sum = values.reduce((total, n) => total + BigInt(n), 0n),
    count = BigInt(values.length);
  return Number((2n * sum + count) / (2n * count));
}
function summary(rows: readonly PricedCandidate[]) {
  return { sample_count: rows.length, median_cents: distribution(rows.map((r) => r.price)).median_cents };
}
function covered(start: number, end: number, spans: readonly [number, number][]): boolean {
  let cursor = start;
  for (const [a, b] of spans) {
    if (a > cursor) return false;
    cursor = Math.max(cursor, b);
    if (cursor >= end) return true;
  }
  return false;
}
/** Input rows must already be deduplicated, comparable, verified and rights-filtered.
 * sellerRef/context are opaque approved aggregation identifiers, never raw personal data. */
export function analyzeSearch(
  rows: readonly PricedCandidate[],
  asOf: string,
  days: number,
  coverage: readonly ObservationCoverage[] = [],
) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("invalid_window");
  const intervals = new Map(rows.map((row) => [row.record, interval(row.record)]));
  const inside = (row: PricedCandidate, a: number, b: number, bucket = false) =>
    within(row, a, b, bucket, intervals.get(row.record) ?? null);
  const end = instant(asOf),
    start = end - days * DAY;
  const spans = coverage
    .map((span): [number, number] => {
      const a = instant(span.start),
        b = instant(span.end);
      if (a >= b) throw new Error("invalid_observation_coverage");
      return [Math.max(start, a), Math.min(end, b)];
    })
    .filter(([a, b]) => a < b)
    .sort((a, b) => a[0] - b[0]);
  const period = (a: number, b: number, bucket = false) => ({
    ...summary(rows.filter((row) => inside(row, a, b, bucket))),
    start: new Date(a).toISOString(),
    end: new Date(b).toISOString(),
    observation_coverage:
      a < start ? ("unknown" as const) : covered(a, b, spans) ? ("complete" as const) : ("unknown" as const),
  });
  const recent = period(end - 30 * DAY, end),
    previous = period(end - 60 * DAY, end - 30 * DAY);
  const delta =
    recent.median_cents !== null &&
    previous.median_cents !== null &&
    previous.median_cents > 0 &&
    recent.observation_coverage === "complete" &&
    previous.observation_coverage === "complete"
      ? {
          numerator_cents: recent.median_cents - previous.median_cents,
          denominator_cents: previous.median_cents,
        }
      : null;
  const contexts = new Map<string, Array<{ amount: number; free: boolean }>>();
  for (const row of rows) {
    const amount = shipping(row),
      context = row.record.shippingContextRef;
    if (amount === null || !context) continue;
    const amounts = contexts.get(context) ?? [];
    amounts.push({ amount, free: row.record.shippingStatus === "verified_free_shipping" });
    contexts.set(context, amounts);
  }
  const groups = [...contexts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([context_ref, amounts]) => ({
      context_ref,
      known_count: amounts.length,
      mean_shipping_cents: mean(amounts.map((entry) => entry.amount)),
      free_count: amounts.filter((entry) => entry.free).length,
      free_share: amounts.filter((entry) => entry.free).length / amounts.length,
    }));
  const known = groups.reduce((n, group) => n + group.known_count, 0);
  const sellers = rows.flatMap(({ record }) => (record.sellerRef ? [record.sellerRef] : []));
  const granularity = days <= 30 ? "day" : "week";
  const bucketSize = granularity === "day" ? DAY : 7 * DAY;
  const first =
    granularity === "day"
      ? Math.floor(start / DAY) * DAY
      : Math.floor((start + 3 * DAY) / bucketSize) * bucketSize - 3 * DAY;
  const buckets = [];
  let assigned = 0;
  for (let a = first; a < end; a += bucketSize) {
    const b = Math.min(a + bucketSize, end),
      lower = Math.max(a, start);
    const bucketRows = rows.filter((row) => inside(row, lower, b, true));
    assigned += bucketRows.length;
    buckets.push({ ...period(lower, b, true), partial: lower !== a || b !== a + bucketSize });
  }
  return {
    mean_cents: mean(rows.map((row) => row.price)),
    sample_count: rows.length,
    shipping_summary: {
      groups,
      unknown_or_withheld_count: rows.length - known,
      mixed_contexts: groups.length > 1,
    },
    seller_summary: {
      distinct_count: sellers.length ? new Set(sellers).size : null,
      identified_count: sellers.length,
      unknown_or_withheld_count: rows.length - sellers.length,
    },
    recent_30d: recent,
    previous_30d: previous,
    change_ratio: delta,
    by_format: Object.fromEntries(
      (["fixed_price", "auction", "best_offer"] as const).map((format) => [
        format,
        summary(rows.filter((row) => row.record.format === format)),
      ]),
    ),
    time_series: { granularity, timezone: "UTC", buckets, unassigned_count: rows.length - assigned },
  };
}
