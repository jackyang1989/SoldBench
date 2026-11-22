import { canonicalJson, type SoldQuery } from "@soldbench/core";
import { digest, type FixturePage } from "./fixture.ts";
import {
  createEbayUsSoldSearchHtmlProfile,
  detectEbayUsSoldHtmlProfile,
  type HtmlProfile,
  hasHtmlAccessBlock,
  parseHtmlPage,
  validateHtmlProfile,
} from "./html.ts";

export function parseEbayUsCursorNumber(cursor: string): number {
  if (cursor === "start") return 1;
  const match = /^page-([1-9]\d{0,2})$/.exec(cursor);
  if (!match?.[1]) throw new Error("invalid_ebay_cursor");
  const page = Number(match[1]);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error("invalid_ebay_cursor");
  return page;
}

function formatUsdDollars(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("invalid_ebay_price_bound");
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

export function validateEbayUsOrigin(origin = "https://www.ebay.com", allowLoopback = false): URL {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new Error("invalid_ebay_origin");
  }
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash)
    throw new Error("invalid_ebay_origin");
  if (base.protocol === "https:" && base.hostname === "www.ebay.com" && !base.port) return base;
  if (allowLoopback && base.protocol === "http:" && base.hostname === "127.0.0.1" && base.port) return base;
  throw new Error("invalid_ebay_origin");
}

export function buildEbayUsSoldSearchUrl(
  query: SoldQuery,
  options: { cursor?: string; itemsPerPage?: 60 | 120 | 240; origin?: string } = {},
): URL {
  if (query.marketplace !== "ebay_us") throw new Error("unsupported_marketplace");
  const base = validateEbayUsOrigin(options.origin ?? "https://www.ebay.com", true);
  const pageNumber = parseEbayUsCursorNumber(options.cursor ?? "start");
  const itemsPerPage = options.itemsPerPage ?? 60;
  if (![60, 120, 240].includes(itemsPerPage)) throw new Error("invalid_ebay_items_per_page");
  const url = new URL("/sch/i.html", base);
  url.searchParams.set("_nkw", query.q);
  url.searchParams.set("LH_Sold", "1");
  url.searchParams.set("LH_Complete", "1");
  url.searchParams.set("_sop", "13");
  url.searchParams.set("_ipg", String(itemsPerPage));
  url.searchParams.set("rt", "nc");
  if (query.sale_format === "auction") url.searchParams.set("LH_Auction", "1");
  else if (query.sale_format === "fixed_price") url.searchParams.set("LH_BIN", "1");
  else if (query.sale_format === "best_offer") url.searchParams.set("LH_BO", "1");
  if (query.min_price_cents !== undefined)
    url.searchParams.set("_udlo", formatUsdDollars(query.min_price_cents));
  if (query.max_price_cents !== undefined)
    url.searchParams.set("_udhi", formatUsdDollars(query.max_price_cents));
  if (pageNumber >= 2) url.searchParams.set("_pgn", String(pageNumber));
  return url;
}

export function buildEbayUsItemDetailUrl(listingId: string, options: { origin?: string } = {}): URL {
  if (!/^\d{6,19}$/.test(listingId)) throw new Error("invalid_ebay_listing_id");
  const base = validateEbayUsOrigin(options.origin ?? "https://www.ebay.com", true);
  return new URL(`/itm/${listingId}`, base);
}

export type EbayHtmlAuditResult =
  | {
      ok: true;
      profileId: string;
      profileHash: string;
      page: FixturePage;
      summary: {
        records: number;
        verifiedActual: number;
        displayedOnly: number;
        unknownPrice: number;
        currencies: string[];
        withPrimaryImage: number;
        withAttributes: number;
        nextCursor: string | null;
        sourceReported: FixturePage["sourceReported"] | null;
        empty: boolean;
      };
    }
  | {
      ok: false;
      kind: "access_blocked" | "structure_invalid";
      profileId: string;
      profileHash: string;
      error: string;
    };

export function auditEbayUsHtmlPage(
  raw: Uint8Array,
  binding: { sourceId: string; queryHash: string; cursor: string; asOf: string },
  profile?: HtmlProfile,
): EbayHtmlAuditResult {
  const chosen = profile ? validateHtmlProfile(profile) : detectEbayUsSoldHtmlProfile(raw);
  const profileHash = digest(canonicalJson(chosen));
  if (hasHtmlAccessBlock(raw, chosen)) {
    return {
      ok: false,
      kind: "access_blocked",
      profileId: chosen.id,
      profileHash,
      error: "source_access_refused",
    };
  }
  try {
    const page = parseHtmlPage(raw, binding, chosen);
    const currencies = [...new Set(page.records.map((r) => r.candidate.currency))].sort();
    return {
      ok: true,
      profileId: chosen.id,
      profileHash,
      page,
      summary: {
        records: page.records.length,
        verifiedActual: page.records.filter((r) => r.candidate.priceStatus === "verified_actual").length,
        displayedOnly: page.records.filter((r) => r.candidate.priceStatus === "displayed_only").length,
        unknownPrice: page.records.filter((r) => r.candidate.priceStatus === "unknown").length,
        currencies,
        withPrimaryImage: page.records.filter((r) => r.primaryImage !== undefined).length,
        withAttributes: page.records.filter(
          (r) => r.recordEvidence !== undefined && Object.keys(r.recordEvidence.attributes).length > 0,
        ).length,
        nextCursor: page.nextCursor,
        sourceReported: page.sourceReported ?? null,
        empty: page.empty,
      },
    };
  } catch (error) {
    return {
      ok: false,
      kind: "structure_invalid",
      profileId: chosen.id,
      profileHash,
      error: error instanceof Error ? error.message : "page_structure_invalid",
    };
  }
}

export { createEbayUsSoldSearchHtmlProfile };
