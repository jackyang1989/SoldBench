import { createHash } from "node:crypto";
import { VERSIONS } from "@soldbench/shared";
import {
  analyzeSearch,
  type ObservationCoverage,
  type PresentationSort,
  sortComparables,
} from "./search-analysis.ts";
import { inWindow, type SaleTime } from "./time.ts";

export const ENGINE_VERSION = VERSIONS.engine;
type Money = number | null;

import { cents, distribution, outlierCandidates } from "./statistics.ts";

export { cents, distribution } from "./statistics.ts";

export type Candidate = {
  sourceId: string;
  eventKey: string | null;
  identityVerified: boolean;
  observationKey?: string;
  comparable: boolean;
  strongAttributeEvidenceMissing?: true;
  priceStatus: "verified_actual" | "displayed_only" | "unknown";
  format: "fixed_price" | "best_offer" | "auction";
  currency: string;
  itemCents: Money;
  shippingCents: Money;
  shippingStatus: "observed" | "verified_free_shipping" | "unknown";
  // USD conversions need a separate evidence reference; unsupported FX is excluded.
  usdConversion?: { itemCents: number; shippingCents: Money; evidenceRef: string };
  time: SaleTime;
  title?: string;
  condition?: string;
  sellerRef?: string;
  sellerDisplayName?: string;
  shippingContextRef?: string;
};
export type Query = {
  sourceId: string;
  asOf: string;
  days: number;
  basis: "item" | "item_plus_observed_shipping";
  limit: number;
  minPriceCents?: number;
  maxPriceCents?: number;
  saleFormat?: Candidate["format"];
  presentationSort?: PresentationSort;
  observationCoverage?: readonly ObservationCoverage[];
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

export function candidateFromJson(value: unknown): Candidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_candidate");
  const record = value as Candidate;
  const validMoney = (amount: unknown) =>
    amount === null || (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0);
  if (
    typeof record.sourceId !== "string" ||
    !record.sourceId ||
    !(record.eventKey === null || (typeof record.eventKey === "string" && record.eventKey.length > 0)) ||
    typeof record.identityVerified !== "boolean" ||
    typeof record.comparable !== "boolean" ||
    (record.eventKey === null && record.identityVerified) ||
    !["verified_actual", "displayed_only", "unknown"].includes(record.priceStatus) ||
    !["fixed_price", "best_offer", "auction"].includes(record.format) ||
    typeof record.currency !== "string" ||
    !/^[A-Z]{3}$/.test(record.currency) ||
    !validMoney(record.itemCents) ||
    !validMoney(record.shippingCents) ||
    !["observed", "verified_free_shipping", "unknown"].includes(record.shippingStatus)
  )
    throw new Error("invalid_candidate");
  if (record.observationKey !== undefined && !/^[a-f0-9]{64}$/.test(record.observationKey))
    throw new Error("invalid_candidate");
  for (const key of ["title", "condition", "sellerRef", "sellerDisplayName", "shippingContextRef"] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 500))
      throw new Error("invalid_candidate");
  }
  if (
    record.usdConversion !== undefined &&
    (!record.usdConversion ||
      !validMoney(record.usdConversion.itemCents) ||
      record.usdConversion.itemCents === null ||
      !validMoney(record.usdConversion.shippingCents) ||
      typeof record.usdConversion.evidenceRef !== "string")
  ) {
    throw new Error("invalid_candidate");
  }
  const time = record.time;
  if (
    !time ||
    !["instant", "day", "unknown"].includes(time.precision) ||
    (time.precision !== "unknown" && typeof time.value !== "string") ||
    (time.precision === "day" && !(time.timeZone === null || typeof time.timeZone === "string"))
  )
    throw new Error("invalid_candidate");
  return structuredClone(record);
}

export function priceQualification(
  record: Candidate,
  basis: Query["basis"],
): { priceCents: Money; reason: string | null } {
  const excluded = (reason: string) => ({ priceCents: null, reason });
  if (record.priceStatus !== "verified_actual") return excluded("unverified_actual_price");
  try {
    if (record.itemCents !== null) cents(record.itemCents);
    if (record.shippingCents !== null) cents(record.shippingCents);
  } catch {
    return excluded("invalid_integer_cents");
  }
  let item = record.itemCents,
    shipping = record.shippingCents;
  if (record.currency !== "USD") {
    if (!record.usdConversion?.evidenceRef.trim()) return excluded("missing_fx_evidence");
    item = record.usdConversion.itemCents;
    shipping = record.usdConversion.shippingCents;
  }
  if (item === null) return excluded("missing_item_price");
  try {
    const total = cents(item);
    if (basis === "item") return { priceCents: Number(total), reason: null };
    if (record.shippingStatus === "unknown" || shipping === null)
      return excluded("missing_shipping_evidence");
    if (record.shippingStatus === "verified_free_shipping" && shipping !== 0)
      return excluded("inconsistent_free_shipping");
    const sum = total + cents(shipping);
    if (sum > BigInt(Number.MAX_SAFE_INTEGER)) return excluded("amount_out_of_range");
    return { priceCents: Number(sum), reason: null };
  } catch {
    return excluded("invalid_integer_cents");
  }
}

function evaluateComplete(records: readonly Candidate[], query: Query) {
  if (
    !query.sourceId ||
    ![30, 90, 180, 365].includes(query.days) ||
    !["item", "item_plus_observed_shipping"].includes(query.basis) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 200
  )
    throw new Error("invalid_query");
  for (const bound of [query.minPriceCents, query.maxPriceCents])
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0)) throw new Error("invalid_query");
  if (
    query.minPriceCents !== undefined &&
    query.maxPriceCents !== undefined &&
    query.minPriceCents > query.maxPriceCents
  )
    throw new Error("invalid_query");
  if (query.saleFormat !== undefined && !["fixed_price", "auction", "best_offer"].includes(query.saleFormat))
    throw new Error("invalid_query");
  // Validate fixed clock/window even when there are no candidates.
  inWindow({ precision: "unknown" }, query.asOf, query.days);
  const keyed = new Map<string, Candidate>(),
    conflicts = new Set<string>();
  const uncertain = new Set<string>();
  let unidentified = 0;
  for (const [index, record] of records.entries()) {
    if (record.sourceId !== query.sourceId) throw new Error("mixed_source_scope");
    if (!record.eventKey || !record.identityVerified) {
      unidentified++;
      const key = record.eventKey
        ? `source-record:${record.eventKey}`
        : (record.observationKey ?? `unkeyed-observation:${index}`);
      uncertain.add(key);
      continue;
    }
    const previous = keyed.get(record.eventKey);
    if (previous && canonicalJson(previous) !== canonicalJson(record)) conflicts.add(record.eventKey);
    else keyed.set(record.eventKey, record);
  }
  const observed = [...keyed]
    .filter(([key, r]) => !conflicts.has(key) && inWindow(r.time, query.asOf, query.days))
    .map(([, r]) => r);
  const matched = observed.filter((r) => r.comparable);
  const comparable = matched.filter((r) => {
    if (query.saleFormat !== undefined && r.format !== query.saleFormat) return false;
    const amount = priceQualification(r, query.basis).priceCents;
    // Unknown amounts remain diagnosed as unverified; never compare them as zero.
    return (
      amount === null ||
      ((query.minPriceCents === undefined || amount >= query.minPriceCents) &&
        (query.maxPriceCents === undefined || amount <= query.maxPriceCents))
    );
  });
  const qualifications = comparable.map((record) => ({
    record,
    decision: priceQualification(record, query.basis),
  }));
  const verified = qualifications.flatMap(({ record, decision }) =>
    decision.priceCents === null ? [] : [{ record, price: decision.priceCents }],
  );
  const n = verified.length;
  const comparableSet = new Set(comparable),
    prices = new Map(verified.map((x) => [x.record, x.price])),
    outliers = outlierCandidates(verified.map((x) => x.price));
  const recordDecisions = records.map((input) => {
    const record = input.eventKey ? (keyed.get(input.eventKey) ?? input) : input;
    const reason =
      !input.eventKey || !input.identityVerified
        ? "uncertain_identity"
        : conflicts.has(input.eventKey)
          ? "event_identity_conflict"
          : !inWindow(record.time, query.asOf, query.days)
            ? "outside_window"
            : !record.comparable
              ? record.strongAttributeEvidenceMissing
                ? "missing_strong_attribute_evidence"
                : "hard_attribute_mismatch"
              : !comparableSet.has(record)
                ? "query_filter"
                : priceQualification(record, query.basis).reason;
    const included = reason === null,
      price = prices.get(record);
    return {
      eventKey: input.eventKey,
      observationKey: input.observationKey ?? null,
      isComparable: input.identityVerified && !!input.eventKey && comparableSet.has(record),
      includeInPriceStats: included,
      exclusionReasons: reason ? [reason] : [],
      outlierCandidate: included && price !== undefined && outliers.has(price),
    };
  });
  const ordered = sortComparables(verified, query.presentationSort);
  const supplemental = analyzeSearch(verified, query.asOf, query.days, query.observationCoverage);
  return {
    engine_version: ENGINE_VERSION,
    candidate_set_hash: createHash("sha256")
      .update(
        canonicalJson({
          records: records.map(canonicalJson).sort(),
          sourceId: query.sourceId,
          asOf: query.asOf,
          days: query.days,
          basis: query.basis,
          minPriceCents: query.minPriceCents ?? null,
          maxPriceCents: query.maxPriceCents ?? null,
          saleFormat: query.saleFormat ?? null,
          observationCoverage: query.observationCoverage ?? [],
          versions: {
            engine: VERSIONS.engine,
            cleaner: VERSIONS.cleaner,
            normalizer: VERSIONS.normalizer,
          },
        }),
      )
      .digest("hex"),
    stats: {
      n_observed: keyed.size + uncertain.size,
      n_comparable: comparable.length,
      n_price_verified: n,
      n_excluded_unverified_price: comparable.length - n,
      sold_last_30d_observed: verified.filter((x) => inWindow(x.record.time, query.asOf, 30)).length,
      ...distribution(verified.map((x) => x.price)),
      buy_it_now_verified_count: verified.filter((x) => x.record.format === "fixed_price").length,
      best_offer_verified_count: verified.filter((x) => x.record.format === "best_offer").length,
      best_offer_displayed_only_count: comparable.filter(
        (x) => x.format === "best_offer" && x.priceStatus === "displayed_only",
      ).length,
    },
    quality: {
      data_insufficient: n < 8,
      quality_status: n < 8 ? "insufficient_sample" : n < 30 ? "limited_sample" : "sufficient_sample",
      verified_share: comparable.length ? n / comparable.length : null,
      coverage_status: "unknown",
      coverage_ratio: null,
      score: null,
    },
    supplemental_stats: supplemental,
    diagnostics: {
      unidentified_observations: unidentified,
      conflicting_event_keys: [...conflicts].sort(),
      duplicate_observations: records.length - unidentified - keyed.size,
      outside_window_events: keyed.size - conflicts.size - observed.length,
      hard_mismatch_events: observed.length - matched.length,
      query_filter_events: matched.length - comparable.length,
      uncertain_candidates: uncertain.size,
      duplicate_uncertain_observations: unidentified - uncertain.size,
      excluded_before_comparable: {
        uncertain_identity: uncertain.size,
        event_identity_conflict: conflicts.size,
        outside_window: keyed.size - conflicts.size - observed.length,
        hard_attribute_mismatch: observed.length - matched.length,
        ...(query.minPriceCents !== undefined ||
        query.maxPriceCents !== undefined ||
        query.saleFormat !== undefined
          ? { query_filter: matched.length - comparable.length }
          : {}),
      },
      price_exclusions: qualifications.flatMap((x) =>
        x.decision.reason === null ? [] : [{ eventKey: x.record.eventKey, reason: x.decision.reason }],
      ),
    },
    comps: ordered.slice(0, query.limit).map((x) => ({ eventKey: x.record.eventKey, priceCents: x.price })),
    available_comp_count: n,
    calculation_inputs: ordered.map((x) => ({ record: x.record, priceCents: x.price })),
    record_decisions: recordDecisions,
  };
}

/** Public result keeps presentation bounded; worker consumes the same full qualification pass. */
export function evaluate(records: readonly Candidate[], query: Query) {
  const {
    calculation_inputs: _inputs,
    record_decisions: _decisions,
    ...result
  } = evaluateComplete(records, query);
  return result;
}
export function evaluateSnapshot(records: readonly Candidate[], query: Query) {
  return evaluateComplete(records, query);
}
