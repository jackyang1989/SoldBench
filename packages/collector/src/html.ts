import { type Candidate, canonicalJson, instant, isStandardCondition } from "@soldbench/core";
import { approvedImageUrl } from "@soldbench/media";
import { type CheerioAPI, load } from "cheerio/slim";
import { digest, type FixtureListing, type FixturePage, parseFixturePage } from "./fixture.ts";
import { evidenceFields, type RecordEvidence } from "./record-evidence.ts";

type Field = { selector: string; attribute?: string };
const fieldNames = [
  "listingId",
  "eventKey",
  "eventProof",
  "title",
  "sold",
  "format",
  "price",
  "priceEvidence",
  "currency",
  "shipping",
  "shippingEvidence",
  "date",
  "dateSemantics",
  "timeZone",
  "condition",
  "conditionId",
  "link",
  "sellerRef",
] as const;
const detailFields = ["conditionStandard", "description", "defects", "shippingContextRef"] as const;
type FieldName = (typeof fieldNames)[number] | (typeof detailFields)[number];
export type HtmlProfile = {
  schema: "soldbench.synthetic-html-profile.v1";
  synthetic: true;
  id: string;
  revision: number;
  bindingMode?: "root_attributes" | "envelope";
  root: string;
  records: string;
  ignoredRecords?: string;
  adRecords?: string;
  rewriteBoundary?: string;
  empty: string;
  primaryImages: string;
  accessBlocks: string[];
  attributes: string;
  nextPage?: Field;
  reportedCount?: Field;
  defaultCurrency?: string;
  defaultTimeZone?: string;
  fields: Record<(typeof fieldNames)[number], Field> & Partial<Record<(typeof detailFields)[number], Field>>;
  listingHosts: string[];
  imageHosts: string[];
  allowSyntheticSeller: boolean;
  shippingContexts?: string[];
  decimal: "." | ",";
  grouping: "." | "," | " ";
};
function selector(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[a-zA-Z0-9_.#[\]="'*:/()+~ ,>-]+$/.test(value) &&
    !/</.test(value)
  );
}
function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length < 1 || zone.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
export function validateHtmlProfile(input: unknown): HtmlProfile {
  const x = input as HtmlProfile;
  if (
    x?.schema !== "soldbench.synthetic-html-profile.v1" ||
    x.synthetic !== true ||
    typeof x.id !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(x.id) ||
    !Number.isSafeInteger(x.revision) ||
    x.revision < 1 ||
    (x.bindingMode !== undefined && !["root_attributes", "envelope"].includes(x.bindingMode)) ||
    ![x.root, x.records, x.empty, x.primaryImages, x.attributes].every(selector) ||
    (x.ignoredRecords !== undefined && !selector(x.ignoredRecords)) ||
    (x.adRecords !== undefined && !selector(x.adRecords)) ||
    (x.rewriteBoundary !== undefined && !selector(x.rewriteBoundary)) ||
    (x.defaultCurrency !== undefined && !/^[A-Z]{3}$/.test(x.defaultCurrency)) ||
    (x.defaultTimeZone !== undefined && !validTimeZone(x.defaultTimeZone)) ||
    !Array.isArray(x.accessBlocks) ||
    x.accessBlocks.length < 1 ||
    x.accessBlocks.length > 8 ||
    !x.accessBlocks.every(selector) ||
    typeof x.allowSyntheticSeller !== "boolean" ||
    ![".", ","].includes(x.decimal) ||
    ![".", ",", " "].includes(x.grouping) ||
    x.grouping === x.decimal ||
    !x.fields ||
    Object.keys(x.fields).some((name) => ![...fieldNames, ...detailFields].includes(name as FieldName))
  )
    throw new Error("invalid_html_profile");
  const allowed = new Set([
    "schema",
    "synthetic",
    "id",
    "revision",
    "bindingMode",
    "root",
    "records",
    "ignoredRecords",
    "adRecords",
    "rewriteBoundary",
    "empty",
    "primaryImages",
    "accessBlocks",
    "attributes",
    "nextPage",
    "reportedCount",
    "defaultCurrency",
    "defaultTimeZone",
    "fields",
    "listingHosts",
    "imageHosts",
    "allowSyntheticSeller",
    "shippingContexts",
    "decimal",
    "grouping",
  ]);
  if (Object.keys(x).some((key) => !allowed.has(key))) throw new Error("invalid_html_profile");
  for (const optionalField of [x.nextPage, x.reportedCount]) {
    if (optionalField === undefined) continue;
    if (
      !optionalField ||
      !selector(optionalField.selector) ||
      (optionalField.attribute !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(optionalField.attribute))
    )
      throw new Error("invalid_html_profile");
  }
  for (const name of [...fieldNames, ...detailFields]) {
    const field = x.fields[name];
    if (field === undefined && detailFields.includes(name as (typeof detailFields)[number])) continue;
    if (
      !field ||
      !selector(field.selector) ||
      (field.attribute !== undefined &&
        (name === "description" || name === "defects" || !/^[a-z][a-z0-9-]{0,63}$/.test(field.attribute)))
    )
      throw new Error("invalid_html_profile");
  }
  if (
    (x.fields.shippingContextRef !== undefined || x.shippingContexts !== undefined) &&
    (!x.fields.shippingContextRef ||
      !Array.isArray(x.shippingContexts) ||
      !x.shippingContexts.length ||
      x.shippingContexts.length > 16 ||
      new Set(x.shippingContexts).size !== x.shippingContexts.length ||
      x.shippingContexts.some(
        (context) => typeof context !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(context),
      ))
  )
    throw new Error("invalid_html_profile");
  try {
    const $ = load("<main></main>");
    for (const rule of [
      x.root,
      x.records,
      ...(x.ignoredRecords ? [x.ignoredRecords] : []),
      ...(x.adRecords ? [x.adRecords] : []),
      ...(x.rewriteBoundary ? [x.rewriteBoundary] : []),
      x.empty,
      x.primaryImages,
      x.attributes,
      ...(x.nextPage ? [x.nextPage.selector] : []),
      ...(x.reportedCount ? [x.reportedCount.selector] : []),
      ...x.accessBlocks,
      ...Object.values(x.fields).map((field) => field.selector),
    ])
      $(rule);
  } catch {
    throw new Error("invalid_html_profile");
  }
  for (const hosts of [x.listingHosts, x.imageHosts])
    if (
      !Array.isArray(hosts) ||
      hosts.length < 1 ||
      hosts.length > 8 ||
      hosts.some((host) => typeof host !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(host))
    )
      throw new Error("invalid_html_profile");
  const copy = structuredClone(x);
  for (const field of Object.values(copy.fields)) Object.freeze(field);
  if (copy.nextPage) Object.freeze(copy.nextPage);
  if (copy.reportedCount) Object.freeze(copy.reportedCount);
  Object.freeze(copy.fields);
  Object.freeze(copy.listingHosts);
  Object.freeze(copy.imageHosts);
  Object.freeze(copy.accessBlocks);
  Object.freeze(copy.shippingContexts);
  return Object.freeze(copy);
}
/** Explicit profile markers only; product text, navigation and scripts are not access verdicts. */
export function hasHtmlAccessBlock(raw: Uint8Array, profile: HtmlProfile): boolean {
  const maxBytes = profile.bindingMode === "envelope" ? 4 * 1024 * 1024 : 1024 * 1024;
  if (raw.byteLength > maxBytes) return false;
  try {
    const $ = load(new TextDecoder("utf-8", { fatal: true }).decode(raw), { xml: { xmlMode: false } });
    $("script,style,template,noscript,iframe,svg").remove();
    if (
      profile.accessBlocks.some((rule) =>
        $(rule)
          .toArray()
          .some((node) => $(node).closest(profile.records).length === 0),
      )
    )
      return true;
    if (profile.bindingMode === "envelope" && $(profile.root).length === 0) {
      const challengeBanner =
        /pardon\s+our\s+interruption|security\s+measure|checking\s+your\s+browser\s+before\s+you\s+access\s+ebay/i;
      if (
        $("title, h1, h2")
          .toArray()
          .some(
            (node) => $(node).closest(profile.records).length === 0 && challengeBanner.test($(node).text()),
          )
      )
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
/** Parses a declared locale, never guesses currency, ranges, or exchange rates. */
export function parseHtmlMoney(raw: string, currency: string, decimal: string, grouping: string): number {
  if (!/^[A-Z]{3}$/.test(currency) || raw.length > 160) throw new Error("html_money_invalid");
  const symbols: Record<string, string[]> = {
    USD: ["US$", "US $", "$"],
    EUR: ["€"],
    GBP: ["£"],
    CAD: ["CA$", "CA $", "C$", "C $"],
    AUD: ["AU$", "AU $", "A$", "A $"],
  };
  let text = raw.replace(/[\u00a0\u202f]/g, " ").trim();
  for (const token of [currency, ...(symbols[currency] ?? [])].sort((a, b) => b.length - a.length)) {
    if (text.startsWith(token)) {
      text = text.slice(token.length).trim();
      break;
    }
    if (text.endsWith(token)) {
      text = text.slice(0, -token.length).trim();
      break;
    }
  }
  const pieces = text.split(decimal);
  if (pieces.length > 2 || (pieces[1] !== undefined && !/^\d{1,2}$/.test(pieces[1])))
    throw new Error("html_money_invalid");
  const whole = pieces[0] ?? "";
  const groups = whole.split(grouping);
  if (
    groups.length > 1 &&
    (!/^[1-9]\d{0,2}$/.test(groups[0] ?? "") || groups.slice(1).some((v) => !/^\d{3}$/.test(v)))
  )
    throw new Error("html_money_invalid");
  const digits = groups.join("");
  if (!/^\d{1,16}$/.test(digits)) throw new Error("html_money_invalid");
  const amount = BigInt(digits) * 100n + BigInt((pieces[1] ?? "").padEnd(2, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("html_money_invalid");
  return Number(amount);
}
type Scope = ReturnType<CheerioAPI>;
function value(scope: Scope, field: Field): string | null {
  const nodes = scope.find(field.selector);
  if (nodes.length > 1) throw new Error("html_field_ambiguous");
  if (!nodes.length) return null;
  const text = (field.attribute ? nodes.attr(field.attribute) : nodes.text())?.trim() ?? "";
  if (text.length > 2000) throw new Error("html_field_too_large");
  return text || null;
}
function splitCssSelectorList(input: string): string[] {
  const parts: string[] = [];
  let bracket = 0,
    paren = 0,
    quote: "'" | '"' | null = null,
    start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[") bracket++;
    else if (ch === "]" && bracket > 0) bracket--;
    else if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;
    else if (ch === "," && bracket === 0 && paren === 0) {
      const part = input.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}
function cleanEnvelopeText(node: Scope): string {
  const clone = node.clone();
  clone.find(".clipped, .LIGHT_HIGHLIGHT, .s-item__title--tag, .s-card__title--tag").remove();
  return clone.text().replace(/\s+/g, " ").trim();
}
function envelopeField(
  scope: Scope,
  $: CheerioAPI,
  field: Field,
  options: { joinMultiple?: boolean; dedupeListingHosts?: readonly string[] } = {},
): { text: string | null; node: Scope | null } {
  const branches = splitCssSelectorList(field.selector);
  if (options.joinMultiple) {
    const parts: string[] = [];
    const seen = new Set<string>();
    let firstNode: Scope | null = null;
    for (const branch of branches) {
      const nodes = scope.find(branch);
      for (const el of nodes.toArray()) {
        const wrapped = $(el);
        const raw = field.attribute
          ? (wrapped.attr(field.attribute)?.trim() ?? "")
          : cleanEnvelopeText(wrapped);
        if (!raw) continue;
        if (raw.length > 2000) throw new Error("html_field_too_large");
        if (!seen.has(raw)) {
          seen.add(raw);
          parts.push(raw);
          firstNode ??= wrapped;
        }
      }
    }
    return { text: parts.length ? parts.join(" | ") : null, node: firstNode };
  }
  for (const branch of branches) {
    const nodes = scope.find(branch);
    if (!nodes.length) continue;
    if (nodes.length > 1) {
      const dedupeHosts = options.dedupeListingHosts;
      if (dedupeHosts && field.attribute) {
        const attrName = field.attribute;
        const candidates = nodes
          .toArray()
          .map((el) => $(el).attr(attrName)?.trim() ?? "")
          .filter(Boolean);
        if (candidates.length > 1) {
          const canonical = new Set(
            candidates.map((href) => canonicalListingLink(href, dedupeHosts, true).url),
          );
          if (canonical.size === 1 && candidates[0]) {
            if (candidates[0].length > 2000) throw new Error("html_field_too_large");
            return { text: candidates[0], node: nodes.first() };
          }
        }
      }
      throw new Error("html_field_ambiguous");
    }
    const node = nodes.first();
    const raw = field.attribute ? (node.attr(field.attribute)?.trim() ?? "") : cleanEnvelopeText(node);
    if (raw.length > 2000) throw new Error("html_field_too_large");
    if (raw) return { text: raw, node };
  }
  return { text: null, node: null };
}
export function detectHtmlCurrency(raw: string, fallback: string | null = null): string | null {
  const text = raw.replace(/[\u00a0\u202f]/g, " ").trim();
  if (!text) return fallback;
  const explicit: ReadonlyArray<readonly [string, string]> = [
    ["US $", "USD"],
    ["US$", "USD"],
    ["USD", "USD"],
    ["CA $", "CAD"],
    ["CA$", "CAD"],
    ["C $", "CAD"],
    ["C$", "CAD"],
    ["CAD", "CAD"],
    ["AU $", "AUD"],
    ["AU$", "AUD"],
    ["A $", "AUD"],
    ["A$", "AUD"],
    ["AUD", "AUD"],
    ["GBP", "GBP"],
    ["£", "GBP"],
    ["EUR", "EUR"],
    ["€", "EUR"],
  ];
  for (const [token, code] of explicit) {
    if (text.includes(token)) return code;
  }
  if (/^(?:[+-]\s*)?\$(?=\d)/.test(text)) return fallback;
  if (text.includes("$")) return null;
  return fallback;
}
export function isHtmlPriceRange(raw: string): boolean {
  const text = raw
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /\d[\d.,]*(?:\s*[A-Z]{3})?\s+to\s+(?:[^\d\s]+\s*){0,2}\d[\d.,]*/i.test(text);
}
export const EBAY_ITEM_SPECIFIC_MAP: Readonly<Record<string, string>> = Object.freeze({
  category: "category",
  brand: "brand",
  manufacturer: "brand",
  "card manufacturer": "brand",
  "watch brand": "brand",
  model: "model",
  "model number": "model",
  "game name": "model",
  "card name": "model",
  "professional grader": "grading_company",
  grader: "grading_company",
  "grading company": "grading_company",
  "grading service": "grading_company",
  grade: "grade",
  "card number": "card_number",
  language: "language",
  set: "set",
  edition: "edition",
  year: "year",
  "year manufactured": "year",
  "release year": "year",
  "us shoe size": "size",
  "shoe size": "size",
  size: "size",
  "size system": "size_system",
  colorway: "colorway",
  color: "colorway",
  "reference number": "reference",
  reference: "reference",
  "with original box/packaging": "box",
  "original box/packaging": "box",
  "with original packaging": "box",
  "original box": "box",
  box: "box",
  "with papers": "papers",
  papers: "papers",
  platform: "platform",
  "region code": "region",
  region: "region",
  variant: "variant",
  completeness: "completeness",
  "memory size": "vram_gb",
  vram: "vram_gb",
  "video memory": "vram_gb",
  "chipset/gpu model": "chipset",
  "gpu model": "chipset",
  chipset: "chipset",
  series: "series",
  number: "number",
});
function safeUrl(raw: string, hosts: readonly string[], listing = false): string {
  const url = approvedImageUrl(raw, hosts);
  if (listing && new URL(url).search) throw new Error("html_listing_url_not_canonical");
  return url;
}
const months: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
export function parseNaturalSoldDate(raw: string): string | null {
  const match =
    /^(?:Sold(?:\s+on)?\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})$/i.exec(
      raw.trim(),
    );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const month = months[match[1].slice(0, 3).toLowerCase()],
    day = Number(match[2]),
    year = Number(match[3]);
  if (month === undefined || year < 1995 || year > 9999 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day)
    return null;
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
/** Maps unambiguous eBay condition labels to SoldBench standard conditions without equating Open Box or Pre-Owned. */
export function mapStandardCondition(raw: string | null): Candidate["condition"] | null {
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (["new with tags", "new with box"].includes(normalized)) return "new_with_tags";
  if (["new without tags", "new without box"].includes(normalized)) return "new_without_tags";
  if (normalized === "like new") return "like_new";
  if (normalized === "good") return "good";
  if (["acceptable", "fair"].includes(normalized)) return "fair";
  if (["for parts or not working", "parts only", "defective"].includes(normalized)) return "defective";
  return null;
}
function canonicalListingLink(
  raw: string,
  hosts: readonly string[],
  envelope: boolean,
): { url: string; listingId: string | null } {
  if (!envelope) return { url: safeUrl(raw, hosts, true), listingId: null };
  const url = approvedImageUrl(raw, hosts),
    parsed = new URL(url),
    itm = /^\/itm\/(?:.+\/)?(\d{6,19})\/?$/.exec(parsed.pathname);
  if (itm?.[1]) return { url: `${parsed.origin}/itm/${itm[1]}`, listingId: itm[1] };
  if (parsed.search) throw new Error("html_listing_url_not_canonical");
  const item = /^\/item\/([a-zA-Z0-9_-]{1,64})\/?$/.exec(parsed.pathname);
  return { url, listingId: item?.[1] ?? null };
}
function extractNextCursor(raw: string, currentCursor: string): string {
  const trimmed = raw.trim();
  let candidate: string | null = null;
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    candidate = trimmed;
  } else {
    const pgn = /[?&]_pgn=([1-9]\d{0,4})(?:&|$)/.exec(trimmed),
      cursor = /[?&]cursor=([a-zA-Z0-9_-]{1,64})(?:&|$)/.exec(trimmed);
    if (pgn?.[1]) candidate = `page-${pgn[1]}`;
    else if (cursor?.[1]) candidate = cursor[1];
  }
  if (!candidate || candidate === currentCursor) throw new Error("html_pagination_unknown");
  return candidate;
}
export type EbayProfileOverrides = Partial<
  Pick<
    HtmlProfile,
    "id" | "revision" | "listingHosts" | "imageHosts" | "allowSyntheticSeller" | "shippingContexts"
  >
>;
const EBAY_ACCESS_BLOCKS = [
  "form#captcha_form",
  "div.pgHeading",
  "div#splashui-challenge",
  'form[action*="splashui/challenge"]',
  "section.access-wall",
  "form.access-login",
];
export function createEbayUsSoldSearchHtmlProfile(overrides: EbayProfileOverrides = {}): HtmlProfile {
  return validateHtmlProfile({
    schema: "soldbench.synthetic-html-profile.v1",
    synthetic: true,
    id: overrides.id ?? "ebay-us-sold-search-html",
    revision: overrides.revision ?? 2,
    bindingMode: "envelope",
    root: "div.srp-river-results",
    records: "li.s-item",
    ignoredRecords: "li.s-item--watch-list-banner, li.s-item--carousel",
    adRecords: "li.s-item--sponsored, span.s-item__ad-badge",
    rewriteBoundary: "li.srp-river-answer--REWRITE_START",
    empty: "div.srp-save-null-search, h3.srp-save-null-search__heading",
    primaryImages: "div.s-item__image img, img.s-item__image-img",
    accessBlocks: EBAY_ACCESS_BLOCKS,
    attributes: "span.s-item__specific, dl.s-item__attributes, div.s-item__item-specifics > span",
    nextPage: { selector: "a.pagination__next, nav.pagination a[rel='next']", attribute: "href" },
    reportedCount: { selector: "h1.srp-controls__count-heading, div.srp-controls__count-heading" },
    defaultCurrency: "USD",
    defaultTimeZone: "America/Los_Angeles",
    listingHosts: overrides.listingHosts ?? ["www.ebay.com", "ebay.com"],
    imageHosts: overrides.imageHosts ?? ["i.ebayimg.com"],
    allowSyntheticSeller: overrides.allowSyntheticSeller ?? false,
    ...(overrides.shippingContexts ? { shippingContexts: overrides.shippingContexts } : {}),
    decimal: ".",
    grouping: ",",
    fields: {
      listingId: { selector: "span.s-item__item-id", attribute: "data-listing-id" },
      eventKey: { selector: "span.s-item__event-id", attribute: "data-event-key" },
      eventProof: { selector: "span.s-item__event-id", attribute: "data-event-proof" },
      title: {
        selector:
          "div.s-item__title > span[role='heading'], h3.s-item__title > span[role='heading'], div.s-item__title, h3.s-item__title",
      },
      sold: {
        selector:
          "span.s-item__caption-label, div.s-item__caption span.POSITIVE, div.s-item__title--tag span.POSITIVE, span.s-item__caption--signal",
      },
      format: {
        selector:
          "span.s-item__purchase-options, span.s-item__bids, span.s-item__dynamic.s-item__purchaseOptions, span.s-item__format",
      },
      price: { selector: "span.s-item__price" },
      priceEvidence: { selector: "span.s-item__price-evidence" },
      currency: { selector: "span.s-item__currency", attribute: "data-currency" },
      shipping: { selector: "span.s-item__shipping, span.s-item__logisticsCost" },
      shippingEvidence: { selector: "span.s-item__shipping", attribute: "data-evidence" },
      date: {
        selector:
          "span.s-item__caption-date, div.s-item__caption span.POSITIVE, div.s-item__title--tag span.POSITIVE, span.s-item__caption--signal",
      },
      dateSemantics: { selector: "span.s-item__caption-date", attribute: "data-semantic" },
      timeZone: { selector: "span.s-item__caption-date", attribute: "data-time-zone" },
      condition: { selector: "span.SECONDARY_INFO, div.s-item__subtitle > span.SECONDARY_INFO" },
      conditionId: { selector: "span.SECONDARY_INFO", attribute: "data-condition-id" },
      link: { selector: "div.s-item__info > a.s-item__link, a.s-item__link", attribute: "href" },
      sellerRef: { selector: "span.s-item__seller-info-text", attribute: "data-ref" },
    },
  });
}
export function createEbayUsSoldCardHtmlProfile(overrides: EbayProfileOverrides = {}): HtmlProfile {
  return validateHtmlProfile({
    schema: "soldbench.synthetic-html-profile.v1",
    synthetic: true,
    id: overrides.id ?? "ebay-us-sold-card-html",
    revision: overrides.revision ?? 1,
    bindingMode: "envelope",
    root: "div.srp-river-results",
    records: "li.s-card",
    ignoredRecords: "li.s-card--watch-list-banner, li.s-card--carousel",
    adRecords: "li.s-card--sponsored, span.s-card__ad-badge",
    rewriteBoundary: "li.srp-river-answer--REWRITE_START",
    empty: "div.srp-save-null-search, h3.srp-save-null-search__heading",
    primaryImages: "div.s-card__media img, img.s-card__image",
    accessBlocks: EBAY_ACCESS_BLOCKS,
    attributes: "span.s-card__specific, dl.s-card__attributes, span.s-card__attribute-text",
    nextPage: { selector: "a.pagination__next, nav.pagination a[rel='next']", attribute: "href" },
    reportedCount: { selector: "h1.srp-controls__count-heading, div.srp-controls__count-heading" },
    defaultCurrency: "USD",
    defaultTimeZone: "America/Los_Angeles",
    listingHosts: overrides.listingHosts ?? ["www.ebay.com", "ebay.com"],
    imageHosts: overrides.imageHosts ?? ["i.ebayimg.com"],
    allowSyntheticSeller: overrides.allowSyntheticSeller ?? false,
    ...(overrides.shippingContexts ? { shippingContexts: overrides.shippingContexts } : {}),
    decimal: ".",
    grouping: ",",
    fields: {
      listingId: { selector: "span.s-card__item-id", attribute: "data-listing-id" },
      eventKey: { selector: "span.s-card__event-id", attribute: "data-event-key" },
      eventProof: { selector: "span.s-card__event-id", attribute: "data-event-proof" },
      title: {
        selector:
          "div.s-card__title > span.su-styled-text, div.s-card__title > span[role='heading'], div.s-card__title, span.s-card__title",
      },
      sold: {
        selector:
          "div.s-card__caption span.positive, div.s-card__caption span.POSITIVE, div.s-card__caption span, div.s-card__title--tag span.positive",
      },
      format: { selector: "span.s-card__purchase-options, span.s-card__bids, span.s-card__format" },
      price: { selector: "span.s-card__price" },
      priceEvidence: { selector: "span.s-card__price-evidence" },
      currency: { selector: "span.s-card__currency", attribute: "data-currency" },
      shipping: { selector: "span.s-card__shipping, span.s-card__logistics-cost" },
      shippingEvidence: { selector: "span.s-card__shipping", attribute: "data-evidence" },
      date: {
        selector:
          "div.s-card__caption span.positive, div.s-card__caption span.POSITIVE, div.s-card__caption span, div.s-card__title--tag span.positive",
      },
      dateSemantics: { selector: "div.s-card__caption span", attribute: "data-semantic" },
      timeZone: { selector: "div.s-card__caption span", attribute: "data-time-zone" },
      condition: {
        selector:
          "div.s-card__subtitle span.su-styled-text, div.s-card__subtitle span.SECONDARY_INFO, div.s-card__subtitle",
      },
      conditionId: { selector: "div.s-card__subtitle span", attribute: "data-condition-id" },
      link: {
        selector: "div.s-card__details a.s-card__link, div.s-card__title a, a.s-card__link",
        attribute: "href",
      },
      sellerRef: {
        selector: "span.s-card__seller-info, span.s-card__seller-info-text",
        attribute: "data-ref",
      },
    },
  });
}
export function detectEbayUsSoldHtmlProfile(
  raw: Uint8Array,
  overrides: EbayProfileOverrides = {},
): HtmlProfile {
  if (raw.byteLength > 0 && raw.byteLength <= 4 * 1024 * 1024) {
    try {
      const $ = load(new TextDecoder("utf-8", { fatal: true }).decode(raw), { xml: { xmlMode: false } });
      $("script,style,template,noscript,iframe,svg").remove();
      const root = $("div.srp-river-results");
      if (root.length && root.find("li.s-card").length > 0 && root.find("li.s-item").length === 0)
        return createEbayUsSoldCardHtmlProfile(overrides);
    } catch {
      /* Fall back to the classic s-item profile which will validate and quarantine malformed bytes. */
    }
  }
  return createEbayUsSoldSearchHtmlProfile(overrides);
}
export function parseHtmlPage(
  raw: Uint8Array,
  binding: { sourceId: string; queryHash: string; cursor: string; asOf: string },
  input: HtmlProfile,
): FixturePage {
  const profile = validateHtmlProfile(input),
    profileHash = digest(canonicalJson(profile)),
    envelope = profile.bindingMode === "envelope",
    maxBytes = envelope ? 4 * 1024 * 1024 : 1024 * 1024;
  if (raw.byteLength > maxBytes) throw new Error("html_page_too_large");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (html.includes("\u0000")) throw new Error("html_text_invalid");
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: true, withStartIndices: true } });
  if (!envelope && $("*").length > 12000) throw new Error("html_node_budget_exceeded");
  $("script,style,template,noscript,iframe,svg").remove();
  const root = $(profile.root);
  if (root.length !== 1) throw new Error("html_page_binding_invalid");
  if (envelope && ($("*").length > 35000 || root.find("*").length > 20000))
    throw new Error("html_node_budget_exceeded");
  if (!envelope) {
    if (
      root.attr("data-sb-schema") !== "soldbench.synthetic-html.v1" ||
      root.attr("data-source-id") !== binding.sourceId ||
      root.attr("data-query-hash") !== binding.queryHash ||
      root.attr("data-cursor") !== binding.cursor
    )
      throw new Error("html_page_binding_invalid");
  } else if (
    (root.attr("data-source-id") && root.attr("data-source-id") !== binding.sourceId) ||
    (root.attr("data-query-hash") && root.attr("data-query-hash") !== binding.queryHash) ||
    (root.attr("data-cursor") && root.attr("data-cursor") !== binding.cursor)
  ) {
    throw new Error("html_page_binding_invalid");
  }
  const asOf = root.attr("data-as-of") ?? (envelope ? binding.asOf : "");
  if (instant(asOf) > instant(binding.asOf)) throw new Error("html_page_future_watermark");
  let rewriteStartIndex: number | null = null;
  if (envelope && profile.rewriteBoundary) {
    const boundary = root.find(profile.rewriteBoundary).first();
    if (boundary.length) {
      const idx = (boundary[0] as { startIndex?: number | null } | undefined)?.startIndex;
      if (typeof idx === "number") rewriteStartIndex = idx;
    }
  }
  let next: string | null | undefined = root.attr("data-next-cursor");
  if (next === undefined) {
    if (!envelope) throw new Error("html_pagination_unknown");
    if (rewriteStartIndex !== null) next = null;
    else {
      const rawNext = profile.nextPage
        ? (envelopeField(root, $, profile.nextPage).text ??
          envelopeField($($.root()), $, profile.nextPage).text)
        : null;
      next = rawNext ? extractNextCursor(rawNext, binding.cursor) : null;
    }
  }
  const records: FixtureListing[] = [],
    nodes = root.find(profile.records);
  if (nodes.length > 1000) throw new Error("html_record_budget_exceeded");
  if (nodes.toArray().some((node) => $(node).parents(profile.records).length))
    throw new Error("html_nested_record");
  const placeholderImage = (url: string) =>
    /^data:image\//i.test(url) || /\/s\.gif$|s-l64\.|s_1x2\.gif/i.test(url);
  nodes.each((index, node) => {
    if (rewriteStartIndex !== null) {
      const startIndex = (node as { startIndex?: number | null }).startIndex;
      if (typeof startIndex === "number" && startIndex > rewriteStartIndex) return;
    }
    const row = $(node),
      kind = row.attr("data-kind");
    if (["advertisement", "recommendation"].includes(kind ?? "")) return;
    if (
      envelope &&
      profile.ignoredRecords &&
      (row.is(profile.ignoredRecords) || row.find(profile.ignoredRecords).length > 0)
    )
      return;
    if (
      envelope &&
      profile.adRecords &&
      (row.is(profile.adRecords) || row.find(profile.adRecords).length > 0)
    )
      return;
    if (!envelope && kind !== "sold-record") throw new Error("html_record_kind_unknown");
    if (envelope && kind !== undefined && kind !== "sold-record") throw new Error("html_record_kind_unknown");
    const readField = (
      key: FieldName,
      options?: { joinMultiple?: boolean; dedupeListingHosts?: readonly string[] },
    ) => {
      const field = profile.fields[key];
      if (!field) return { text: null, node: null };
      if (!envelope) return { text: value(row, field), node: null };
      return envelopeField(row, $, field, options);
    };
    const read = (key: FieldName) => readField(key).text;
    const soldRaw = read("sold"),
      soldDateRaw = read("date");
    const soldConfirmed =
      soldRaw === "sold" ||
      (envelope && (/^Sold\b/i.test(soldRaw ?? "") || /^Sold\b/i.test(soldDateRaw ?? "")));
    if (!soldConfirmed) {
      if (envelope) {
        const ghostTitle = read("title");
        if (ghostTitle && /^shop on ebay$/i.test(ghostTitle)) return;
        const ghostLink = readField("link", { dedupeListingHosts: profile.listingHosts }).text;
        if (ghostLink && /^https?:\/\/(?:www\.)?ebay\.com\/itm\/123456(?:[/?#]|$)/i.test(ghostLink)) return;
      }
      throw new Error("html_sale_not_confirmed");
    }
    const rawLink = readField(
        "link",
        envelope ? { dedupeListingHosts: profile.listingHosts } : undefined,
      ).text,
      parsedLink = rawLink ? canonicalListingLink(rawLink, profile.listingHosts, envelope) : null;
    const listingId = read("listingId") ?? parsedLink?.listingId ?? null,
      title = read("title");
    const formatRaw = readField("format", envelope ? { joinMultiple: true } : undefined).text,
      priceField = readField("price"),
      priceRaw = priceField.text,
      priceEvidenceRaw = read("priceEvidence");
    const priceRange = envelope && priceRaw !== null && isHtmlPriceRange(priceRaw);
    const currency =
      read("currency") ??
      (envelope
        ? priceRaw
          ? detectHtmlCurrency(priceRaw, profile.defaultCurrency ?? null)
          : (profile.defaultCurrency ?? null)
        : null);
    if (!listingId || !title || !currency) throw new Error("html_required_field_missing");
    const zone = read("timeZone") ?? (envelope ? (profile.defaultTimeZone ?? null) : null);
    let time: Candidate["time"] = { precision: "unknown" };
    const dateSemantics = read("dateSemantics");
    if ((dateSemantics === "sold" || (envelope && dateSemantics !== "ended")) && soldDateRaw) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(soldDateRaw))
        time = { precision: "day", value: soldDateRaw, timeZone: zone };
      else {
        const natural = envelope ? parseNaturalSoldDate(soldDateRaw) : null;
        if (natural) time = { precision: "day", value: natural, timeZone: zone };
        else {
          instant(soldDateRaw);
          time = { precision: "instant", value: soldDateRaw };
        }
      }
    }
    const rawEvent = read("eventKey"),
      proofRaw = read("eventProof"),
      independent =
        proofRaw === "independent_event" ||
        (envelope && proofRaw !== "listing_only" && (rawEvent !== null || time.precision !== "unknown"));
    const derivedEventKey =
      rawEvent ??
      (envelope && independent && time.precision !== "unknown" ? `${listingId}:${time.value}` : null);
    if (independent && !derivedEventKey) throw new Error("html_event_proof_incomplete");
    const eventKey = independent ? derivedEventKey : null;
    const strikethrough =
      envelope &&
      priceField.node !== null &&
      (priceField.node.is(".STRIKETHROUGH, s, del") ||
        priceField.node.find(".STRIKETHROUGH, s, del").length > 0);
    let format = formatRaw,
      priceEvidence = priceEvidenceRaw;
    if (envelope) {
      if (
        /best\s+offer\s+accepted/i.test(formatRaw ?? "") ||
        /best\s+offer\s+accepted/i.test(priceEvidenceRaw ?? "")
      ) {
        format = "best_offer";
        if (priceEvidence !== "actual_paid") priceEvidence = "displayed_only";
      } else if (strikethrough || /strikethrough/i.test(priceEvidenceRaw ?? "")) {
        if (/\b\d+\s+bids?\b/i.test(formatRaw ?? "") || /^auction$/i.test(formatRaw ?? ""))
          format = "auction";
        else if (/\bbuy\s+it\s+now\b/i.test(formatRaw ?? "") && !/best\s+offer/i.test(formatRaw ?? ""))
          format = "fixed_price";
        else format = "best_offer";
        if (priceEvidence !== "actual_paid") priceEvidence = "displayed_only";
      } else if (/\b\d+\s+bids?\b/i.test(formatRaw ?? "") || /^auction$/i.test(formatRaw ?? "")) {
        format = "auction";
        if (priceEvidence === null) priceEvidence = "actual_paid";
      } else if (
        formatRaw === null ||
        /^(?:buy\s+it\s+now|or\s+best\s+offer|fixed_price)(?:\s*\|\s*(?:buy\s+it\s+now|or\s+best\s+offer|fixed_price))*$/i.test(
          formatRaw,
        )
      ) {
        format = "fixed_price";
        if (priceEvidence === null) priceEvidence = "actual_paid";
      }
    }
    if (priceRange) priceEvidence = "unknown";
    if (!["fixed_price", "auction", "best_offer"].includes(format ?? ""))
      throw new Error("html_format_unknown");
    if (priceEvidence !== null && !["actual_paid", "displayed_only", "unknown"].includes(priceEvidence))
      throw new Error("html_price_evidence_unknown");
    const itemCents =
      priceRaw === null || priceRange
        ? null
        : parseHtmlMoney(priceRaw, currency, profile.decimal, profile.grouping);
    if (priceEvidence === "actual_paid" && itemCents === null) throw new Error("html_actual_price_missing");
    const shippingRaw = read("shipping"),
      shippingEvidence = read("shippingEvidence");
    if (
      shippingEvidence !== null &&
      !["verified_free_shipping", "observed", "unknown"].includes(shippingEvidence)
    )
      throw new Error("html_shipping_evidence_unknown");
    let shippingStatus: Candidate["shippingStatus"] = "unknown",
      shippingCents: number | null = null;
    if (shippingEvidence === "verified_free_shipping") {
      if (
        shippingRaw !== "Free shipping" &&
        shippingRaw !== "免费运费" &&
        !(envelope && shippingRaw && /^free\b|free\s+.*shipping|免运费/i.test(shippingRaw)) &&
        !(shippingRaw && parseHtmlMoney(shippingRaw, currency, profile.decimal, profile.grouping) === 0)
      )
        throw new Error("html_free_shipping_inconsistent");
      shippingStatus = "verified_free_shipping";
      shippingCents = 0;
    } else if (shippingEvidence === "observed") {
      if (!shippingRaw) throw new Error("html_shipping_missing");
      const cleaned = envelope
        ? shippingRaw
            .replace(/^\+\s*/, "")
            .replace(/\s+(?:shipping|delivery|postage|estimate|international)\b.*$/i, "")
            .trim()
        : shippingRaw;
      shippingStatus = "observed";
      shippingCents = parseHtmlMoney(cleaned, currency, profile.decimal, profile.grouping);
    } else if (envelope && shippingEvidence === null && shippingRaw) {
      if (
        /local\s+pickup|pickup\s+(?:only|in\s+store)|freight|not\s+specified|calculate|see\s+item\s+description/i.test(
          shippingRaw,
        )
      ) {
        shippingStatus = "unknown";
        shippingCents = null;
      } else if (
        /^free\b.*(?:shipping|delivery|postage)|free\s+(?:shipping|delivery|postage)|免费运费|免运费/i.test(
          shippingRaw,
        )
      ) {
        shippingStatus = "verified_free_shipping";
        shippingCents = 0;
      } else {
        const cleaned = shippingRaw
          .replace(/^\+\s*/, "")
          .replace(/\s+(?:shipping|delivery|postage|estimate|international)\b.*$/i, "")
          .trim();
        const shipCurrency = detectHtmlCurrency(cleaned, currency);
        if (shipCurrency === currency) {
          shippingStatus = "observed";
          shippingCents = parseHtmlMoney(cleaned, currency, profile.decimal, profile.grouping);
        } else {
          shippingStatus = "unknown";
          shippingCents = null;
        }
      }
    }
    const shippingContext = read("shippingContextRef");
    if (shippingContext !== null && !profile.shippingContexts?.includes(shippingContext))
      throw new Error("html_shipping_context_unknown");
    const conditionRaw = read("condition"),
      conditionId = read("conditionId"),
      conditionStandard = read("conditionStandard") ?? (envelope ? mapStandardCondition(conditionRaw) : null),
      description = read("description"),
      defects = read("defects");
    if (conditionStandard !== null && !isStandardCondition(conditionStandard))
      throw new Error("html_standard_condition_invalid");
    const images = row.find(profile.primaryImages),
      imageChoices: Array<{ url: string; width: number }> = [];
    if (images.length > 8) throw new Error("html_image_budget_exceeded");
    images.each((_, imageNode) => {
      const image = $(imageNode),
        role = image.attr("data-role");
      if (
        (!envelope && role !== "primary") ||
        (envelope && role !== undefined && role !== "primary") ||
        (image.attr("data-listing-id") && image.attr("data-listing-id") !== listingId) ||
        (image.attr("data-event-key") && image.attr("data-event-key") !== rawEvent)
      )
        throw new Error("html_image_identity_mismatch");
      const srcset = image.attr("srcset");
      if (srcset) {
        const choices = srcset.split(",");
        if (choices.length > 16) throw new Error("html_image_budget_exceeded");
        for (const part of choices) {
          const widthMatch = /^\s*(\S+)\s+([1-9]\d{0,4})w\s*$/.exec(part);
          if (widthMatch?.[1] && widthMatch[2]) {
            if (!(envelope && placeholderImage(widthMatch[1])))
              imageChoices.push({
                url: safeUrl(widthMatch[1], profile.imageHosts),
                width: Number(widthMatch[2]),
              });
            continue;
          }
          const densityMatch = envelope ? /^\s*(\S+)\s+([1-9]\d?(?:\.\d+)?)x\s*$/.exec(part) : null;
          if (densityMatch?.[1] && densityMatch[2]) {
            if (!placeholderImage(densityMatch[1]))
              imageChoices.push({
                url: safeUrl(densityMatch[1], profile.imageHosts),
                width: Math.round(Number(densityMatch[2]) * 1000),
              });
            continue;
          }
          if (!envelope) throw new Error("html_srcset_invalid");
          const bare = /^\s*(\S+)\s*$/.exec(part);
          if (bare?.[1] && !placeholderImage(bare[1]))
            imageChoices.push({ url: safeUrl(bare[1], profile.imageHosts), width: 0 });
          else if (!bare?.[1]) throw new Error("html_srcset_invalid");
        }
      } else {
        const url =
          (envelope ? image.attr("data-high-res-src") : undefined) ||
          image.attr("data-src") ||
          image.attr("src");
        if (url && !(envelope && placeholderImage(url)))
          imageChoices.push({ url: safeUrl(url, profile.imageHosts), width: 0 });
      }
    });
    imageChoices.sort((a, b) => b.width - a.width || a.url.localeCompare(b.url));
    const attributes: Record<string, string> = {},
      attrNodes = row.find(profile.attributes);
    if (attrNodes.length > 32) throw new Error("html_attribute_budget_exceeded");
    const recordMappedAttribute = (rawLabel: string, rawVal: string) => {
      const label = rawLabel.replace(/:$/, "").replace(/\s+/g, " ").trim().toLowerCase();
      const key = EBAY_ITEM_SPECIFIC_MAP[label];
      if (!key) return;
      let normalized = rawVal.replace(/\s+/g, " ").trim();
      if (!normalized || normalized.length > 500) return;
      if (key === "vram_gb") {
        const gb = /^(\d{1,3})\s*gb$/i.exec(normalized);
        if (gb?.[1]) normalized = gb[1];
      }
      if (Object.hasOwn(attributes, key)) {
        if (attributes[key] !== normalized) throw new Error("html_attribute_invalid");
        return;
      }
      if (Object.keys(attributes).length >= 32) throw new Error("html_attribute_budget_exceeded");
      attributes[key] = normalized;
    };
    attrNodes.each((_, attrNode) => {
      const attr = $(attrNode),
        name = attr.attr("data-name");
      if (!envelope || name !== undefined) {
        const text = attr.text().trim();
        if (
          !name ||
          !/^[a-z][a-z0-9_]{0,63}$/.test(name) ||
          Object.hasOwn(attributes, name) ||
          !text ||
          text.length > 500
        )
          throw new Error("html_attribute_invalid");
        attributes[name] = text;
        return;
      }
      if (attr.is("dl")) {
        attr.find("dt").each((__, dtNode) => {
          const dt = $(dtNode);
          const dd = dt.next("dd");
          if (dd.length) recordMappedAttribute(cleanEnvelopeText(dt), cleanEnvelopeText(dd));
        });
        return;
      }
      const pair = /^([^:]{1,64}):\s*(.+)$/.exec(cleanEnvelopeText(attr));
      if (pair?.[1] && pair[2]) recordMappedAttribute(pair[1], pair[2]);
    });
    const sellerRef = profile.allowSyntheticSeller ? read("sellerRef") : null;
    if (sellerRef !== null && !/^synthetic-[a-z0-9_-]{1,64}$/.test(sellerRef))
      throw new Error("html_synthetic_seller_invalid");
    const listingUrl = parsedLink?.url ?? null;
    const evidence: Extract<RecordEvidence, { schema: "soldbench.record-evidence.v2" }> = {
      schema: "soldbench.record-evidence.v2",
      profileHash,
      recordIndex: index,
      listingUrl,
      conditionId,
      conditionRaw,
      conditionStandard,
      description,
      defects,
      priceRaw,
      shippingRaw,
      soldDateRaw,
      sourceTimeZone: zone,
      attributes,
      fields: Object.fromEntries(evidenceFields.map((key) => [key, "missing"])) as typeof evidence.fields,
    };
    Object.assign(evidence.fields, {
      listingUrl: listingUrl ? "present" : "missing",
      condition: conditionRaw || conditionId || conditionStandard ? "present" : "missing",
      price: priceRaw ? "present" : "missing",
      shipping: shippingRaw ? "present" : "missing",
      soldDate: time.precision !== "unknown" ? "present" : "missing",
      seller: profile.allowSyntheticSeller ? (sellerRef ? "present" : "missing") : "withheld",
      primaryImage: imageChoices.length ? "present" : "missing",
      attributes: Object.keys(attributes).length ? "present" : "missing",
      description: description ? "present" : "missing",
      defects: defects ? "present" : "missing",
    });
    const comparableAttr = row.attr("data-comparable");
    records.push({
      listingId,
      title,
      recordEvidence: evidence,
      candidate: {
        sourceId: binding.sourceId,
        title,
        eventKey,
        identityVerified: independent,
        comparable: comparableAttr !== undefined ? comparableAttr === "true" : envelope,
        priceStatus:
          priceEvidence === "actual_paid"
            ? "verified_actual"
            : itemCents === null
              ? "unknown"
              : "displayed_only",
        format: format as Candidate["format"],
        currency,
        itemCents,
        shippingCents,
        shippingStatus,
        ...(shippingContext && shippingStatus !== "unknown" ? { shippingContextRef: shippingContext } : {}),
        time,
        ...(conditionStandard ? { condition: conditionStandard } : {}),
        ...(sellerRef ? { sellerRef } : {}),
      },
      ...(imageChoices[0] ? { primaryImage: { role: "primary" as const, url: imageChoices[0].url } } : {}),
    });
  });
  let emptyConfirmed = false;
  let emptyConflict = false;
  if (!envelope) {
    const emptyNodes = root.find(profile.empty);
    emptyConfirmed = emptyNodes.length === 1 && emptyNodes.attr("data-confirmed") === "true";
    emptyConflict = records.length > 0 && emptyNodes.length > 0;
  } else {
    for (const branch of splitCssSelectorList(profile.empty)) {
      const emptyNodes = root.find(branch);
      if (emptyNodes.length === 1) {
        const node = emptyNodes.first();
        if (
          node.attr("data-confirmed") === "true" ||
          /no\s+exact\s+matches\s+found|0\s+results\s+found|no\s+results\s+for/i.test(cleanEnvelopeText(node))
        ) {
          emptyConfirmed = true;
          break;
        }
      }
    }
    emptyConflict = records.length > 0 && emptyConfirmed;
  }
  if (!records.length && !emptyConfirmed) throw new Error("html_empty_not_confirmed");
  if (emptyConflict) throw new Error("html_empty_conflict");
  const page: FixturePage = {
    schema: "soldbench.synthetic-page.v1",
    synthetic: true,
    ...binding,
    asOf,
    cursor: binding.cursor,
    nextCursor: next || null,
    empty: records.length === 0,
    records,
  };
  const count = root.attr("data-reported-count");
  if (count !== undefined) {
    const unit = root.attr("data-reported-unit"),
      estimated = root.attr("data-reported-estimated");
    if (
      !/^\d{1,16}$/.test(count) ||
      !["listings", "items", "events", "unknown"].includes(unit ?? "") ||
      !["true", "false"].includes(estimated ?? "")
    )
      throw new Error("html_reported_count_invalid");
    page.sourceReported = {
      count: Number(count),
      unit: unit as NonNullable<FixturePage["sourceReported"]>["unit"],
      estimated: estimated === "true",
    };
  } else if (envelope && profile.reportedCount) {
    const rawCount =
      envelopeField(root, $, profile.reportedCount).text ??
      envelopeField($($.root()), $, profile.reportedCount).text;
    if (rawCount) {
      const match = /^([0-9][0-9,]{0,15})\+?\s+results?\b/i.exec(rawCount.trim());
      if (!match?.[1]) throw new Error("html_reported_count_invalid");
      const parsedCount = Number(match[1].replaceAll(",", ""));
      if (!Number.isSafeInteger(parsedCount) || parsedCount < 0)
        throw new Error("html_reported_count_invalid");
      page.sourceReported = { count: parsedCount, unit: "listings", estimated: true };
    }
  }
  return parseFixturePage(Buffer.from(JSON.stringify(page)), binding, profile.shippingContexts);
}
