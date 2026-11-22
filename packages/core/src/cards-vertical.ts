import { createHash } from "node:crypto";
import { canonicalJson } from "./pricing.ts";
import { distribution } from "./statistics.ts";

export const TCG_GAMES = ["pokemon", "mtg", "yugioh", "sports", "other"] as const;
export type TcgGame = (typeof TCG_GAMES)[number];

export const CARD_EDITIONS = [
  "1st_edition",
  "unlimited",
  "shadowless",
  "holo",
  "reverse_holo",
  "promo",
  "standard",
] as const;
export type CardEdition = (typeof CARD_EDITIONS)[number];

export const GRADING_COMPANIES = ["PSA", "BGS", "CGC", "SGC", "TAG"] as const;
export type GradingCompany = (typeof GRADING_COMPANIES)[number];

export const RAW_CARD_CONDITIONS = [
  "near_mint",
  "lightly_played",
  "moderately_played",
  "heavily_played",
  "damaged",
] as const;
export type RawCardCondition = (typeof RAW_CARD_CONDITIONS)[number];

export type CardSaleInput = {
  id: string;
  productId: string;
  eventKey: string;
  gradingState: "raw" | "graded";
  gradingCompany: GradingCompany | null;
  gradeValue: string | null;
  rawCondition: RawCardCondition | null;
  edition: CardEdition;
  currency: string;
  itemMinor: number | null;
  shippingMinor: number | null;
  shippingStatus: "observed" | "verified_free_shipping" | "unknown";
  salePriceStatus: "verified_actual" | "displayed_only" | "unknown";
  soldAt: string | null;
  comparable: boolean;
};

export function cardValuationCanonicalHash(input: {
  productId: string;
  gradingState: "raw" | "graded";
  edition: CardEdition;
  gradingCompany?: GradingCompany;
  gradeValue?: string;
  rawCondition?: RawCardCondition;
  priceBasis: "item" | "item_plus_observed_shipping";
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: "cards-vertical-1.0.0",
        product_id: input.productId,
        grading_state: input.gradingState,
        edition: input.edition,
        ...(input.gradingCompany ? { grading_company: input.gradingCompany } : {}),
        ...(input.gradeValue ? { grade_value: input.gradeValue } : {}),
        ...(input.rawCondition ? { raw_condition: input.rawCondition } : {}),
        price_basis: input.priceBasis,
      }),
    )
    .digest("hex");
}

function cardEffectiveMinor(
  row: CardSaleInput,
  priceBasis: "item" | "item_plus_observed_shipping",
): number | null {
  if (row.itemMinor === null || !Number.isSafeInteger(row.itemMinor) || row.itemMinor < 0) return null;
  if (priceBasis === "item") return row.itemMinor;
  if (row.shippingStatus === "verified_free_shipping") return row.itemMinor;
  if (
    row.shippingStatus === "observed" &&
    row.shippingMinor !== null &&
    Number.isSafeInteger(row.shippingMinor)
  ) {
    return row.itemMinor + row.shippingMinor;
  }
  return null;
}

/**
 * Evaluates structured card sale records with strict isolation of `raw` vs `graded`,
 * exact `edition`/`grading_company`/`grade_value`/`raw_condition` filtering,
 * and shared Type-7 statistics (`<8` -> null, unknown shipping never zero-filled).
 */
export function evaluateCardComparables(
  records: readonly CardSaleInput[],
  filter: {
    productId: string;
    expectedEdition: CardEdition;
    gradingState: "raw" | "graded";
    gradingCompany?: GradingCompany;
    gradeValue?: string;
    rawCondition?: RawCardCondition;
    priceBasis: "item" | "item_plus_observed_shipping";
    expectedCurrency?: string;
    limit?: number;
  },
) {
  const expectedCurrency = filter.expectedCurrency ?? "USD";
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));

  const excludedCounts = {
    product_mismatch: 0,
    edition_mismatch: 0,
    grading_state_mismatch: 0,
    grading_company_mismatch: 0,
    grade_mismatch: 0,
    raw_condition_mismatch: 0,
    currency_mismatch: 0,
    non_comparable: 0,
    unverified_price: 0,
    unknown_shipping: 0,
  };

  const verifiedValues: number[] = [];
  const matchedComps: Array<{
    id: string;
    product_id: string;
    event_key: string;
    grading_state: "raw" | "graded";
    grading_company: GradingCompany | null;
    grade_value: string | null;
    raw_condition: RawCardCondition | null;
    edition: CardEdition;
    currency: string;
    item_cents: number | null;
    shipping_cents: number | null;
    effective_price_cents: number | null;
    shipping_status: "observed" | "verified_free_shipping" | "unknown";
    sale_price_status: "verified_actual" | "displayed_only" | "unknown";
    sold_at: string | null;
  }> = [];

  for (const r of records) {
    if (r.productId !== filter.productId) {
      excludedCounts.product_mismatch++;
      continue;
    }
    if (r.edition !== filter.expectedEdition) {
      excludedCounts.edition_mismatch++;
      continue;
    }
    if (r.gradingState !== filter.gradingState) {
      excludedCounts.grading_state_mismatch++;
      continue;
    }
    if (filter.gradingState === "graded") {
      if (filter.gradingCompany && r.gradingCompany !== filter.gradingCompany) {
        excludedCounts.grading_company_mismatch++;
        continue;
      }
      if (filter.gradeValue && r.gradeValue !== filter.gradeValue) {
        excludedCounts.grade_mismatch++;
        continue;
      }
    } else if (filter.rawCondition && r.rawCondition !== filter.rawCondition) {
      excludedCounts.raw_condition_mismatch++;
      continue;
    }
    if (r.currency !== expectedCurrency) {
      excludedCounts.currency_mismatch++;
      continue;
    }
    if (!r.comparable) {
      excludedCounts.non_comparable++;
      continue;
    }
    if (r.salePriceStatus !== "verified_actual" || r.itemMinor === null) {
      excludedCounts.unverified_price++;
      continue;
    }
    const effective = cardEffectiveMinor(r, filter.priceBasis);
    if (effective === null) {
      excludedCounts.unknown_shipping++;
      continue;
    }

    verifiedValues.push(effective);
    matchedComps.push({
      id: r.id,
      product_id: r.productId,
      event_key: r.eventKey,
      grading_state: r.gradingState,
      grading_company: r.gradingCompany,
      grade_value: r.gradeValue,
      raw_condition: r.rawCondition,
      edition: r.edition,
      currency: r.currency,
      item_cents: r.itemMinor,
      shipping_cents: r.shippingMinor,
      effective_price_cents: effective,
      shipping_status: r.shippingStatus,
      sale_price_status: r.salePriceStatus,
      sold_at: r.soldAt,
    });
  }

  const dist = distribution(verifiedValues);
  const sampleCount = verifiedValues.length;
  return {
    stats: {
      currency: expectedCurrency,
      price_basis: filter.priceBasis,
      n_price_verified: sampleCount,
      sample_tier:
        sampleCount < 8
          ? ("low_sample" as const)
          : sampleCount < 30
            ? ("limited" as const)
            : ("sufficient" as const),
      sufficient_sample: sampleCount >= 8,
      median_cents: dist.median_cents,
      p25_cents: dist.p25_cents,
      p75_cents: dist.p75_cents,
      trimmed_mean_cents: dist.trimmed_mean_cents,
      observed_min_cents: dist.observed_min_cents,
      observed_max_cents: dist.observed_max_cents,
      quality_score: null,
    },
    comps: matchedComps.slice(0, limit),
    excluded_counts: excludedCounts,
  };
}
