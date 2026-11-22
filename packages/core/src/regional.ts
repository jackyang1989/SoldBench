import { distribution } from "./statistics.ts";
import { inWindow, type SaleTime } from "./time.ts";

export const SUPPORTED_SITES = ["ebay_us", "ebay_uk", "ebay_de"] as const;
export type MarketplaceSite = (typeof SUPPORTED_SITES)[number];
export type SiteCurrency = "USD" | "GBP" | "EUR";

export const SITE_SPECS: Record<
  MarketplaceSite,
  {
    site: MarketplaceSite;
    countryCode: "US" | "GB" | "DE";
    currency: SiteCurrency;
    timeZone: string;
    primaryLocale: "en" | "en-GB" | "de";
    host: string;
  }
> = {
  ebay_us: {
    site: "ebay_us",
    countryCode: "US",
    currency: "USD",
    timeZone: "America/Los_Angeles",
    primaryLocale: "en",
    host: "www.ebay.com",
  },
  ebay_uk: {
    site: "ebay_uk",
    countryCode: "GB",
    currency: "GBP",
    timeZone: "Europe/London",
    primaryLocale: "en-GB",
    host: "www.ebay.co.uk",
  },
  ebay_de: {
    site: "ebay_de",
    countryCode: "DE",
    currency: "EUR",
    timeZone: "Europe/Berlin",
    primaryLocale: "de",
    host: "www.ebay.de",
  },
};

export type StandardCondition =
  | "new_with_tags"
  | "new_without_tags"
  | "like_new"
  | "good"
  | "fair"
  | "defective"
  | "unknown";

/**
 * Map regional UK English and German listing conditions cleanly without falsely upgrading Used/Open-Box items.
 */
export function mapRegionalCondition(
  site: MarketplaceSite,
  raw: string | null | undefined,
): StandardCondition {
  const norm = (raw ?? "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!norm) return "unknown";

  if (site === "ebay_de") {
    if (["neu", "brandneu", "neu mit etikett", "neu mit karton"].includes(norm)) return "new_with_tags";
    if (["neu ohne etikett", "neu ohne karton"].includes(norm)) return "new_without_tags";
    if (
      norm.startsWith("neu: sonstige") ||
      norm.startsWith("neu (siehe details)") ||
      norm.includes("geöffnet")
    )
      return "like_new";
    if (
      [
        "gebraucht",
        "sehr gut",
        "gut",
        "vom hersteller generalüberholt",
        "vom verkäufer generalüberholt",
        "generalüberholt",
      ].includes(norm)
    )
      return "good";
    if (["akzeptabel"].includes(norm)) return "fair";
    if (norm.includes("ersatzteil") || norm.includes("defekt")) return "defective";
    return "unknown";
  }

  // US & UK English variants
  if (["brand new", "new with tags", "new with box"].includes(norm)) return "new_with_tags";
  if (["new without tags", "new without box"].includes(norm)) return "new_without_tags";
  if (
    norm.startsWith("new other") ||
    norm.startsWith("open box") ||
    norm.includes("opened – never used") ||
    norm.includes("opened - never used") ||
    norm === "like new"
  )
    return "like_new";
  if (["used", "pre-owned", "seller refurbished", "manufacturer refurbished", "good"].includes(norm))
    return "good";
  if (["fair", "acceptable"].includes(norm)) return "fair";
  if (norm.includes("for parts") || norm.includes("not working")) return "defective";
  return "unknown";
}

const UK_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DE_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mär: 3,
  maer: 3,
  mar: 3,
  apr: 4,
  mai: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  okt: 10,
  nov: 11,
  dez: 12,
};

function isoDay(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseRegionalSoldDate(site: MarketplaceSite, raw: string): SaleTime {
  const clean = raw.normalize("NFC").trim();
  const tz = SITE_SPECS[site].timeZone;

  if (site === "ebay_de") {
    const dotNumeric = /(?:verkauft(?:\s+am)?\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})/i.exec(clean);
    if (dotNumeric?.[1] && dotNumeric[2] && dotNumeric[3]) {
      const value = isoDay(Number(dotNumeric[3]), Number(dotNumeric[2]), Number(dotNumeric[1]));
      if (value) return { precision: "day", value, timeZone: tz };
    }
    const textDe = /(?:verkauft(?:\s+am)?\s+)?(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜ]+)\.?\s+(\d{4})/i.exec(clean);
    if (textDe?.[1] && textDe[2] && textDe[3]) {
      const m =
        DE_MONTHS[textDe[2].slice(0, 4).toLowerCase()] ?? DE_MONTHS[textDe[2].slice(0, 3).toLowerCase()];
      const value = m ? isoDay(Number(textDe[3]), m, Number(textDe[1])) : null;
      if (value) return { precision: "day", value, timeZone: tz };
    }
    return { precision: "unknown" };
  }

  if (site === "ebay_uk") {
    const ukText = /(?:sold\s+)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i.exec(clean);
    if (ukText?.[1] && ukText[2] && ukText[3]) {
      const m = UK_MONTHS[ukText[2].slice(0, 3).toLowerCase()];
      const value = m ? isoDay(Number(ukText[3]), m, Number(ukText[1])) : null;
      if (value) return { precision: "day", value, timeZone: tz };
    }
  }

  const usText = /(?:sold\s+)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(clean);
  if (usText?.[1] && usText[2] && usText[3]) {
    const m = UK_MONTHS[usText[1].slice(0, 3).toLowerCase()];
    const value = m ? isoDay(Number(usText[3]), m, Number(usText[2])) : null;
    if (value) return { precision: "day", value, timeZone: tz };
  }

  return { precision: "unknown" };
}

/**
 * Exact BigInt half-up FX minor-unit conversion using integer micro-rates (`1_000_000 = 1.0`).
 */
export function convertMinorWithFx(minorUnits: number, rateMicros: number): number {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) throw new Error("invalid_minor_units");
  if (!Number.isSafeInteger(rateMicros) || rateMicros <= 0) throw new Error("invalid_fx_rate_micros");
  const converted = (BigInt(minorUnits) * BigInt(rateMicros) + 500_000n) / 1_000_000n;
  if (converted > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount_out_of_range");
  return Number(converted);
}

export type RegionalRecord = {
  eventKey: string;
  currency: string;
  itemMinor: number | null;
  shippingMinor: number | null;
  shippingStatus: "observed" | "verified_free_shipping" | "unknown";
  salePriceStatus: "verified_actual" | "displayed_only" | "unknown";
  saleFormat: "fixed_price" | "auction" | "best_offer";
  conditionStd: string | null;
  comparable: boolean;
  time: SaleTime;
};

export type FxSnapshotInput = {
  baseCurrency: SiteCurrency;
  quoteCurrency: SiteCurrency;
  rateMicros: number;
  evidenceRef: string;
  provider: string;
  capturedAt: string;
  expiresAt: string;
};

/**
 * Evaluate site-level comparables strictly in one native currency; attach FX comparable view only when verified non-expired FX evidence exists.
 */
export function evaluateSiteComparables(
  records: readonly RegionalRecord[],
  options: {
    site: MarketplaceSite;
    asOf: string;
    days: 30 | 90 | 180 | 365;
    basis: "item" | "item_plus_observed_shipping";
    condition?: string;
    compareCurrency?: SiteCurrency;
    fxSnapshot?: FxSnapshotInput | null;
  },
) {
  const spec = SITE_SPECS[options.site];
  const nativeCurrency = spec.currency;
  const prices: number[] = [];
  let inWindowCount = 0;
  let comparableCount = 0;
  let currencyMismatchCount = 0;

  for (const r of records) {
    if (!inWindow(r.time, options.asOf, options.days)) continue;
    inWindowCount++;
    if (r.currency !== nativeCurrency) {
      currencyMismatchCount++;
      continue;
    }
    if (!r.comparable) continue;
    if (options.condition && r.conditionStd !== options.condition) continue;
    comparableCount++;
    if (r.salePriceStatus !== "verified_actual" || r.itemMinor === null) continue;
    if (options.basis === "item_plus_observed_shipping") {
      if (r.shippingStatus === "unknown" || r.shippingMinor === null) continue;
      if (r.shippingStatus === "verified_free_shipping" && r.shippingMinor !== 0) continue;
      prices.push(r.itemMinor + r.shippingMinor);
    } else {
      prices.push(r.itemMinor);
    }
  }

  const dist = distribution(prices);
  const nativeStats = {
    currency: nativeCurrency,
    n_total: inWindowCount,
    n_comparable: comparableCount,
    n_price_verified: prices.length,
    median_minor: dist.median_cents,
    p25_minor: dist.p25_cents,
    p75_minor: dist.p75_cents,
    trimmed_mean_minor: dist.trimmed_mean_cents,
  };

  let comparableView: {
    currency: SiteCurrency;
    median_minor: number | null;
    p25_minor: number | null;
    p75_minor: number | null;
    trimmed_mean_minor: number | null;
  } | null = null;
  let fxStatus: "not_requested" | "same_currency" | "converted_with_evidence" | "fx_evidence_unavailable" =
    "not_requested";
  let fxEvidence: FxSnapshotInput | null = null;

  if (options.compareCurrency) {
    if (options.compareCurrency === nativeCurrency) {
      fxStatus = "same_currency";
    } else {
      const fx = options.fxSnapshot;
      const fxValid =
        fx &&
        fx.baseCurrency === nativeCurrency &&
        fx.quoteCurrency === options.compareCurrency &&
        Date.parse(fx.expiresAt) > Date.parse(options.asOf);
      if (!fxValid) {
        fxStatus = "fx_evidence_unavailable";
      } else {
        fxStatus = "converted_with_evidence";
        fxEvidence = fx;
        comparableView = {
          currency: options.compareCurrency,
          median_minor:
            dist.median_cents === null ? null : convertMinorWithFx(dist.median_cents, fx.rateMicros),
          p25_minor: dist.p25_cents === null ? null : convertMinorWithFx(dist.p25_cents, fx.rateMicros),
          p75_minor: dist.p75_cents === null ? null : convertMinorWithFx(dist.p75_cents, fx.rateMicros),
          trimmed_mean_minor:
            dist.trimmed_mean_cents === null
              ? null
              : convertMinorWithFx(dist.trimmed_mean_cents, fx.rateMicros),
        };
      }
    }
  }

  return {
    site: options.site,
    native_currency: nativeCurrency,
    currency_mismatch_count: currencyMismatchCount,
    native_stats: nativeStats,
    fx_status: fxStatus,
    fx_evidence: fxEvidence,
    comparable_view: comparableView,
  };
}
