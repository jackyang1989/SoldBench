import { createHash } from "node:crypto";
import { canonicalJson } from "./pricing.ts";
import { distribution } from "./statistics.ts";

export const SECOND_MARKETPLACES = ["mercari_us"] as const;
export type SecondMarketplaceId = (typeof SECOND_MARKETPLACES)[number];

export type SecondMarketplaceListingState = "sold" | "active" | "ended_unsold";

export type SecondMarketplaceRecordInput = {
  id: string;
  marketplace: SecondMarketplaceId;
  listingId: string;
  eventKey: string;
  listingState: SecondMarketplaceListingState;
  title: string;
  currency: string;
  itemMinor: number | null;
  shippingMinor: number | null;
  shippingStatus: "observed" | "verified_free_shipping" | "unknown";
  salePriceStatus: "verified_actual" | "displayed_only" | "unknown";
  conditionStd: string | null;
  observedAt: string;
  soldAt: string | null;
  comparable: boolean;
  primaryImagePath: string | null;
  mediaStatus: "available" | "missing" | "revoked";
};

const MERCARI_CONDITION_MAP = {
  new: "new_with_tags",
  "brand new": "new_with_tags",
  "like new": "like_new",
  like_new: "like_new",
  good: "good",
  fair: "fair",
  poor: "poor",
} as const;

export type SecondMarketplaceConditionStd =
  | (typeof MERCARI_CONDITION_MAP)[keyof typeof MERCARI_CONDITION_MAP]
  | "unknown";

/**
 * Normalize native second-marketplace condition strings using explicit per-platform dictionaries.
 */
export function mapSecondMarketplaceCondition(
  marketplace: SecondMarketplaceId,
  raw: string | null | undefined,
): SecondMarketplaceConditionStd {
  if (marketplace !== "mercari_us" || !raw) return "unknown";
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return MERCARI_CONDITION_MAP[key as keyof typeof MERCARI_CONDITION_MAP] ?? "unknown";
}

/**
 * Compute deterministic request identity hash for second-marketplace preview queries.
 */
export function secondMarketplaceCanonicalHash(input: {
  marketplace: SecondMarketplaceId;
  q: string;
  priceBasis: "item" | "item_plus_observed_shipping";
  condition?: string;
  limit: number;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: "second-marketplace-1.0.0",
        marketplace: input.marketplace,
        q: input.q.trim().toLowerCase().replace(/\s+/g, " "),
        price_basis: input.priceBasis,
        ...(input.condition ? { condition: input.condition.trim().toLowerCase() } : {}),
        limit: input.limit,
      }),
    )
    .digest("hex");
}

function soldEffectiveMinor(
  row: SecondMarketplaceRecordInput,
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
 * Partition second-marketplace records so active listings NEVER enter sold statistics,
 * reusing the canonical Type-7 distribution engine (`<8` -> null, unknown never zero-filled).
 */
export function evaluateSecondMarketplaceRecords(
  records: readonly SecondMarketplaceRecordInput[],
  options: {
    priceBasis: "item" | "item_plus_observed_shipping";
    expectedCurrency?: string;
    limit?: number;
  },
) {
  const expectedCurrency = options.expectedCurrency ?? "USD";
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));

  const soldRows = records.filter((r) => r.listingState === "sold");
  const activeRows = records.filter((r) => r.listingState === "active");
  const endedUnsoldCount = records.filter((r) => r.listingState === "ended_unsold").length;

  const verifiedSoldValues: number[] = [];
  const excludedCounts = {
    non_comparable: 0,
    unverified_price: 0,
    unknown_shipping: 0,
    currency_mismatch: 0,
    active_isolated: activeRows.length,
    ended_unsold: endedUnsoldCount,
  };

  const soldComps: Array<{
    id: string;
    listing_id: string;
    event_key: string;
    listing_state: "sold";
    title: string;
    currency: string;
    item_cents: number | null;
    shipping_cents: number | null;
    effective_price_cents: number | null;
    shipping_status: "observed" | "verified_free_shipping" | "unknown";
    sale_price_status: "verified_actual" | "displayed_only" | "unknown";
    condition_std: string | null;
    sold_at: string | null;
    primary_image_path: string | null;
    media_status: "available" | "missing" | "revoked";
    included_in_stats: boolean;
  }> = [];

  for (const row of soldRows) {
    if (row.currency !== expectedCurrency) {
      excludedCounts.currency_mismatch++;
      continue;
    }
    if (!row.comparable) {
      excludedCounts.non_comparable++;
      continue;
    }
    if (row.salePriceStatus !== "verified_actual" || row.itemMinor === null) {
      excludedCounts.unverified_price++;
      soldComps.push({
        id: row.id,
        listing_id: row.listingId,
        event_key: row.eventKey,
        listing_state: "sold",
        title: row.title,
        currency: row.currency,
        item_cents: row.itemMinor,
        shipping_cents: row.shippingMinor,
        effective_price_cents: null,
        shipping_status: row.shippingStatus,
        sale_price_status: row.salePriceStatus,
        condition_std: row.conditionStd,
        sold_at: row.soldAt,
        primary_image_path: row.primaryImagePath,
        media_status: row.mediaStatus,
        included_in_stats: false,
      });
      continue;
    }

    const effective = soldEffectiveMinor(row, options.priceBasis);
    if (effective === null) {
      excludedCounts.unknown_shipping++;
      soldComps.push({
        id: row.id,
        listing_id: row.listingId,
        event_key: row.eventKey,
        listing_state: "sold",
        title: row.title,
        currency: row.currency,
        item_cents: row.itemMinor,
        shipping_cents: row.shippingMinor,
        effective_price_cents: null,
        shipping_status: row.shippingStatus,
        sale_price_status: row.salePriceStatus,
        condition_std: row.conditionStd,
        sold_at: row.soldAt,
        primary_image_path: row.primaryImagePath,
        media_status: row.mediaStatus,
        included_in_stats: false,
      });
      continue;
    }

    verifiedSoldValues.push(effective);
    soldComps.push({
      id: row.id,
      listing_id: row.listingId,
      event_key: row.eventKey,
      listing_state: "sold",
      title: row.title,
      currency: row.currency,
      item_cents: row.itemMinor,
      shipping_cents: row.shippingMinor,
      effective_price_cents: effective,
      shipping_status: row.shippingStatus,
      sale_price_status: row.salePriceStatus,
      condition_std: row.conditionStd,
      sold_at: row.soldAt,
      primary_image_path: row.primaryImagePath,
      media_status: row.mediaStatus,
      included_in_stats: true,
    });
  }

  const dist = distribution(verifiedSoldValues);
  const sampleCount = verifiedSoldValues.length;

  const activeItems = activeRows
    .filter((r) => r.currency === expectedCurrency)
    .map((r) => ({
      id: r.id,
      listing_id: r.listingId,
      event_key: r.eventKey,
      listing_state: "active" as const,
      title: r.title,
      currency: r.currency,
      asking_price_cents: r.itemMinor,
      shipping_cents: r.shippingMinor,
      shipping_status: r.shippingStatus,
      condition_std: r.conditionStd,
      observed_at: r.observedAt,
      primary_image_path: r.primaryImagePath,
      media_status: r.mediaStatus,
    }));

  const askingPrices = activeItems
    .map((a) => a.asking_price_cents)
    .filter((v): v is number => v !== null && Number.isSafeInteger(v) && v >= 0);

  return {
    sold_stats: {
      currency: expectedCurrency,
      price_basis: options.priceBasis,
      n_sold_observed: soldRows.length,
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
    sold_comps: soldComps.slice(0, limit),
    total_sold_comps: soldComps.length,
    active_listings: {
      excluded_from_sold_stats: true as const,
      active_count: activeItems.length,
      min_asking_cents: askingPrices.length ? Math.min(...askingPrices) : null,
      max_asking_cents: askingPrices.length ? Math.max(...askingPrices) : null,
      items: activeItems.slice(0, limit),
    },
    excluded_counts: excludedCounts,
  };
}
