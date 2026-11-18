import type { ComparisonScope, evaluate } from "@soldbench/core";

type Evaluation = ReturnType<typeof evaluate>;
export type SummaryParts = Pick<Evaluation, "stats" | "quality"> & {
  diagnostics: Evaluation["diagnostics"] & { comparison_scope?: ComparisonScope };
  data_as_of: Date | null;
};
export function qualityReport(
  snapshot: SummaryParts,
  stale: boolean,
  modelVisibility: "details" | "aggregate" | "hidden",
) {
  const { stats, quality, diagnostics } = snapshot;
  const scope = diagnostics.comparison_scope;
  return {
    data_insufficient: stats.n_price_verified < 8,
    quality_status: quality.quality_status,
    match: {
      matched: stats.n_comparable,
      excluded_hard_mismatch: diagnostics.hard_mismatch_events,
      excluded_before_comparable: stats.n_observed - stats.n_comparable,
      mean_rule_match_score: null,
    },
    price: {
      verified_share: quality.verified_share,
      unverified_best_offer_count: stats.best_offer_displayed_only_count,
    },
    sample: { verified_count: stats.n_price_verified, recent_30d_count: stats.sold_last_30d_observed },
    freshness: { data_as_of: snapshot.data_as_of?.toISOString() ?? null, stale },
    coverage: { status: "unknown", ratio: null, source_scope: null },
    score: null,
    ...(modelVisibility === "details" && scope ? { comparison_scope: scope } : {}),
    warnings: [
      { code: "synthetic_fixture", message: "Synthetic regression data, not real market sales." },
      { code: "coverage_unknown", message: "Observed samples are not complete market sales." },
      ...(modelVisibility !== "hidden" && scope?.status === "mixed_models"
        ? [
            {
              code: "mixed_models",
              message:
                "The price summary spans multiple observed models. Select a model for a more specific comparison.",
            },
          ]
        : []),
    ],
  };
}

const countFields = [
  "n_observed",
  "n_comparable",
  "n_price_verified",
  "n_excluded_unverified_price",
  "sold_last_30d_observed",
  "buy_it_now_verified_count",
  "best_offer_verified_count",
  "best_offer_displayed_only_count",
] as const;
const priceFields = [
  "median_cents",
  "p25_cents",
  "p75_cents",
  "trimmed_mean_cents",
  "observed_min_cents",
  "observed_max_cents",
] as const;
/** Project only the public aggregate contract; never spread extensible persisted JSON into a public response. */
export function publicSummary(snapshot: SummaryParts, stale: boolean, allowModelAggregate: boolean) {
  const stats = Object.fromEntries(
    [...countFields, ...priceFields].map((key) => [key, snapshot.stats[key]]),
  ) as Evaluation["stats"];
  const valid = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const { verified_share, quality_status } = snapshot.quality;
  if (
    !countFields.every((key) => valid(stats[key])) ||
    !priceFields.every((key) => stats[key] === null || valid(stats[key])) ||
    !valid(snapshot.diagnostics.hard_mismatch_events) ||
    !["insufficient_sample", "limited_sample", "sufficient_sample"].includes(quality_status) ||
    (verified_share !== null &&
      (typeof verified_share !== "number" ||
        !Number.isFinite(verified_share) ||
        verified_share < 0 ||
        verified_share > 1))
  )
    throw new Error("invalid_public_summary");
  return {
    stats,
    quality: qualityReport({ ...snapshot, stats }, stale, allowModelAggregate ? "aggregate" : "hidden"),
  };
}
