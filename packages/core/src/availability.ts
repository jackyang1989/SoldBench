import { instant } from "./time.ts";

// Candidate freshness policy only. This decision is not a wallet or a product API.
export function availability(input: {
  now: string;
  dataAsOf: string | null;
  currentRights: "allowed" | "revoked" | "not_cleared";
  snapshotExists: boolean;
  allowStale: boolean;
  verifiedSamples: number;
}) {
  if (!Number.isSafeInteger(input.verifiedSamples) || input.verifiedSamples < 0)
    throw new Error("invalid_sample_count");
  const state = (freshness: string, readable: boolean, potentialCredits: 0 | 1, reason: string) => ({
    freshness,
    readable,
    potentialCredits,
    reason,
    onlineVerified: false,
    actualChargePerformed: false,
  });
  if (input.currentRights !== "allowed") return state("forbidden", false, 0, input.currentRights);
  if (!input.snapshotExists || !input.dataAsOf) return state("unknown", false, 0, "no_covered_snapshot");
  const age = instant(input.now) - instant(input.dataAsOf);
  if (age < 0) throw new Error("future_watermark");
  if (age > 72 * 3_600_000) return state("expired", false, 0, "data_expired");
  if (age > 24 * 3_600_000)
    return state(
      "stale_acceptable",
      input.allowStale,
      0,
      input.allowStale ? "explicit_stale_consent" : "stale_consent_required",
    );
  return state(
    "fresh",
    true,
    input.verifiedSamples < 8 ? 0 : 1,
    input.verifiedSamples < 8 ? "insufficient_sample" : "eligible_standard_query",
  );
}
