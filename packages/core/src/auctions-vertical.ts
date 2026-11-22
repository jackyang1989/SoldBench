import { createHash } from "node:crypto";
import type { GradingCompany } from "./cards-vertical.ts";
import { canonicalJson } from "./pricing.ts";
import { distribution } from "./statistics.ts";

export const AUCTION_HOUSES = ["goldin_us"] as const;
export type AuctionHouseId = (typeof AUCTION_HOUSES)[number];

export const AUCTION_PRICE_BASES = ["total_with_premium", "hammer_only"] as const;
export type AuctionPriceBasis = (typeof AUCTION_PRICE_BASES)[number];

export type AuctionLotInput = {
  id: string;
  auctionHouse: AuctionHouseId;
  sessionCode: string;
  sessionName: string;
  lotNumber: string;
  eventKey: string;
  title: string;
  gradingCompany: GradingCompany | null;
  gradeValue: string | null;
  certNumber: string | null;
  currency: string;
  hammerMinor: number | null;
  buyersPremiumStatus: "known" | "none" | "unknown";
  buyersPremiumBps: number | null;
  buyersPremiumMinor: number | null;
  totalWithPremiumMinor: number | null;
  taxIncluded: boolean;
  saleStatus: "sold" | "unsold" | "withdrawn";
  soldAt: string | null;
  comparable: boolean;
  primaryImagePath: string | null;
  mediaStatus: "available" | "missing" | "revoked";
};

export function auctionCanonicalHash(input: {
  house: AuctionHouseId;
  q: string;
  priceBasis: AuctionPriceBasis;
  gradingCompany?: GradingCompany;
  gradeValue?: string;
  limit: number;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: "auctions-vertical-1.0.0",
        auction_house: input.house,
        q: input.q.trim().toLowerCase().replace(/\s+/g, " "),
        price_basis: input.priceBasis,
        ...(input.gradingCompany ? { grading_company: input.gradingCompany } : {}),
        ...(input.gradeValue ? { grade_value: input.gradeValue } : {}),
        limit: input.limit,
      }),
    )
    .digest("hex");
}

/**
 * Evaluates auction lots under a strict single pricing basis (`total_with_premium` OR `hammer_only`).
 * Unknown buyer's premium NEVER becomes zero and never enters `total_with_premium` statistics.
 */
export function evaluateAuctionLots(
  records: readonly AuctionLotInput[],
  options: {
    priceBasis: AuctionPriceBasis;
    expectedCurrency: string;
    gradingCompany?: GradingCompany;
    gradeValue?: string;
    limit?: number;
  },
) {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const excludedCounts = {
    unsold_or_withdrawn: 0,
    non_comparable: 0,
    currency_mismatch: 0,
    grading_mismatch: 0,
    unknown_buyers_premium: 0,
    missing_hammer_price: 0,
  };

  const verifiedValues: number[] = [];
  const lots: Array<{
    id: string;
    session_code: string;
    session_name: string;
    lot_number: string;
    event_key: string;
    title: string;
    grading_company: GradingCompany | null;
    grade_value: string | null;
    cert_number: string | null;
    currency: string;
    hammer_minor: number | null;
    buyers_premium_status: "known" | "none" | "unknown";
    buyers_premium_bps: number | null;
    buyers_premium_minor: number | null;
    total_with_premium_minor: number | null;
    tax_included: boolean;
    basis_applied_minor: number | null;
    included_in_stats: boolean;
    sold_at: string | null;
    primary_image_path: string | null;
    media_status: "available" | "missing" | "revoked";
  }> = [];

  for (const r of records) {
    if (r.saleStatus !== "sold") {
      excludedCounts.unsold_or_withdrawn++;
      continue;
    }
    if (r.currency !== options.expectedCurrency) {
      excludedCounts.currency_mismatch++;
      continue;
    }
    if (!r.comparable) {
      excludedCounts.non_comparable++;
      continue;
    }
    if (
      (options.gradingCompany && r.gradingCompany !== options.gradingCompany) ||
      (options.gradeValue && r.gradeValue !== options.gradeValue)
    ) {
      excludedCounts.grading_mismatch++;
      continue;
    }

    let basisValue: number | null = null;
    if (options.priceBasis === "total_with_premium") {
      if (r.buyersPremiumStatus === "unknown" || r.totalWithPremiumMinor === null) {
        excludedCounts.unknown_buyers_premium++;
      } else {
        basisValue = r.totalWithPremiumMinor;
      }
    } else if (r.hammerMinor === null) {
      excludedCounts.missing_hammer_price++;
    } else {
      basisValue = r.hammerMinor;
    }

    if (basisValue !== null) verifiedValues.push(basisValue);
    lots.push({
      id: r.id,
      session_code: r.sessionCode,
      session_name: r.sessionName,
      lot_number: r.lotNumber,
      event_key: r.eventKey,
      title: r.title,
      grading_company: r.gradingCompany,
      grade_value: r.gradeValue,
      cert_number: r.certNumber,
      currency: r.currency,
      hammer_minor: r.hammerMinor,
      buyers_premium_status: r.buyersPremiumStatus,
      buyers_premium_bps: r.buyersPremiumBps,
      buyers_premium_minor: r.buyersPremiumMinor,
      total_with_premium_minor: r.totalWithPremiumMinor,
      tax_included: r.taxIncluded,
      basis_applied_minor: basisValue,
      included_in_stats: basisValue !== null,
      sold_at: r.soldAt,
      primary_image_path: r.primaryImagePath,
      media_status: r.mediaStatus,
    });
  }

  const dist = distribution(verifiedValues);
  const sampleCount = verifiedValues.length;
  return {
    stats: {
      currency: options.expectedCurrency,
      price_basis: options.priceBasis,
      n_sold_lots: lots.length,
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
    lots: lots.slice(0, limit),
    excluded_counts: excludedCounts,
  };
}
