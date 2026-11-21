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
  adRecords?: string;
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
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 240 &&
      /^[a-zA-Z0-9_.#[\]="' :(),-]+$/.test(value) &&
      !/[<>]/.test(value)) ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 240 &&
      /^[a-zA-Z0-9_.#[\]="' >-]+$/.test(value))
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
    (x.adRecords !== undefined && !selector(x.adRecords)) ||
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
    "adRecords",
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
      ...(x.adRecords ? [x.adRecords] : []),
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
  if (raw.byteLength > 1024 * 1024) return false;
  try {
    const $ = load(new TextDecoder("utf-8", { fatal: true }).decode(raw), { xml: { xmlMode: false } });
    $("script,style,template,noscript,iframe").remove();
    return profile.accessBlocks.some((rule) =>
      $(rule)
        .toArray()
        .some((node) => $(node).closest(profile.records).length === 0),
    );
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
    CAD: ["CA$", "C$"],
    AUD: ["AU$", "A$"],
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
function mapStandardCondition(raw: string | null): Candidate["condition"] | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (["brand new", "new", "new with tags", "new with box"].includes(normalized)) return "new";
  if (
    [
      "new (other)",
      "open box",
      "like new",
      "certified - refurbished",
      "excellent - refurbished",
      "new without tags",
      "new without box",
    ].includes(normalized)
  )
    return "like_new";
  if (["very good", "very good - refurbished"].includes(normalized)) return "very_good";
  if (["pre-owned", "good", "good - refurbished", "used"].includes(normalized)) return "good";
  if (["acceptable", "for parts or not working", "parts only"].includes(normalized)) return "fair";
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
    itm = /^\/itm\/(?:[^/]+\/)?(\d{6,19})\/?$/.exec(parsed.pathname);
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
export function createEbayUsSoldSearchHtmlProfile(
  overrides: Partial<
    Pick<
      HtmlProfile,
      "id" | "revision" | "listingHosts" | "imageHosts" | "allowSyntheticSeller" | "shippingContexts"
    >
  > = {},
): HtmlProfile {
  return validateHtmlProfile({
    schema: "soldbench.synthetic-html-profile.v1",
    synthetic: true,
    id: overrides.id ?? "ebay-us-sold-search-html",
    revision: overrides.revision ?? 1,
    bindingMode: "envelope",
    root: "div.srp-river-results",
    records: "li.s-item",
    adRecords: "li.s-item--sponsored",
    empty: "div.srp-save-null-search",
    primaryImages: "img.s-item__image-img",
    accessBlocks: ["form#captcha_form", "div.pgHeading", "section.access-wall", "form.access-login"],
    attributes: "span.s-item__specific",
    nextPage: { selector: "a.pagination__next", attribute: "href" },
    reportedCount: { selector: "h1.srp-controls__count-heading" },
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
      title: { selector: "div.s-item__title" },
      sold: { selector: "span.s-item__caption-label" },
      format: { selector: "span.s-item__purchase-options" },
      price: { selector: "span.s-item__price" },
      priceEvidence: { selector: "span.s-item__price-evidence" },
      currency: { selector: "span.s-item__currency", attribute: "data-currency" },
      shipping: { selector: "span.s-item__shipping" },
      shippingEvidence: { selector: "span.s-item__shipping", attribute: "data-evidence" },
      date: { selector: "span.s-item__caption-date" },
      dateSemantics: { selector: "span.s-item__caption-date", attribute: "data-semantic" },
      timeZone: { selector: "span.s-item__caption-date", attribute: "data-time-zone" },
      condition: { selector: "span.SECONDARY_INFO" },
      conditionId: { selector: "span.SECONDARY_INFO", attribute: "data-condition-id" },
      link: { selector: "a.s-item__link", attribute: "href" },
      sellerRef: { selector: "span.s-item__seller-info-text", attribute: "data-ref" },
    },
  });
}
export function parseHtmlPage(
  raw: Uint8Array,
  binding: { sourceId: string; queryHash: string; cursor: string; asOf: string },
  input: HtmlProfile,
): FixturePage {
  const profile = validateHtmlProfile(input),
    profileHash = digest(canonicalJson(profile)),
    envelope = profile.bindingMode === "envelope";
  if (raw.byteLength > 1024 * 1024) throw new Error("html_page_too_large");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (html.includes("\u0000")) throw new Error("html_text_invalid");
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: true, withStartIndices: true } });
  if ($("*").length > 12000) throw new Error("html_node_budget_exceeded");
  $("script,style,template,noscript,iframe").remove();
  const root = $(profile.root);
  if (root.length !== 1) throw new Error("html_page_binding_invalid");
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
  let next: string | null | undefined = root.attr("data-next-cursor");
  if (next === undefined) {
    if (!envelope) throw new Error("html_pagination_unknown");
    const rawNext = profile.nextPage
      ? (value(root, profile.nextPage) ?? value($($.root()), profile.nextPage))
      : null;
    next = rawNext ? extractNextCursor(rawNext, binding.cursor) : null;
  }
  const records: FixtureListing[] = [],
    nodes = root.find(profile.records);
  if (nodes.length > 1000) throw new Error("html_record_budget_exceeded");
  if (nodes.toArray().some((node) => $(node).parents(profile.records).length))
    throw new Error("html_nested_record");
  nodes.each((index, node) => {
    const row = $(node),
      kind = row.attr("data-kind");
    if (["advertisement", "recommendation"].includes(kind ?? "")) return;
    if (
      envelope &&
      profile.adRecords &&
      (row.is(profile.adRecords) || row.find(profile.adRecords).length > 0)
    )
      return;
    if (!envelope && kind !== "sold-record") throw new Error("html_record_kind_unknown");
    if (envelope && kind !== undefined && kind !== "sold-record") throw new Error("html_record_kind_unknown");
    const read = (key: FieldName) => {
      const field = profile.fields[key];
      return field ? value(row, field) : null;
    };
    const soldRaw = read("sold"),
      soldDateRaw = read("date");
    const soldConfirmed =
      soldRaw === "sold" ||
      (envelope && (/^Sold\b/i.test(soldRaw ?? "") || /^Sold\b/i.test(soldDateRaw ?? "")));
    if (!soldConfirmed) throw new Error("html_sale_not_confirmed");
    const rawLink = read("link"),
      parsedLink = rawLink ? canonicalListingLink(rawLink, profile.listingHosts, envelope) : null;
    const listingId = read("listingId") ?? parsedLink?.listingId ?? null,
      title = read("title"),
      currency = read("currency") ?? (envelope ? (profile.defaultCurrency ?? null) : null);
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
    const formatRaw = read("format"),
      priceRaw = read("price"),
      priceEvidenceRaw = read("priceEvidence");
    let format = formatRaw,
      priceEvidence = priceEvidenceRaw;
    if (envelope) {
      if (
        /best\s+offer\s+accepted/i.test(formatRaw ?? "") ||
        /best\s+offer\s+accepted|strikethrough/i.test(priceEvidenceRaw ?? "")
      ) {
        format = "best_offer";
        if (priceEvidence !== "actual_paid") priceEvidence = "displayed_only";
      } else if (/\b\d+\s+bids?\b/i.test(formatRaw ?? "") || /^auction$/i.test(formatRaw ?? "")) {
        format = "auction";
        if (priceEvidence === null) priceEvidence = "actual_paid";
      } else if (
        formatRaw === null ||
        /^(?:buy\s+it\s+now|or\s+best\s+offer|fixed_price)$/i.test(formatRaw)
      ) {
        format = "fixed_price";
        if (priceEvidence === null) priceEvidence = "actual_paid";
      }
    }
    if (!["fixed_price", "auction", "best_offer"].includes(format ?? ""))
      throw new Error("html_format_unknown");
    if (priceEvidence !== null && !["actual_paid", "displayed_only", "unknown"].includes(priceEvidence))
      throw new Error("html_price_evidence_unknown");
    const itemCents =
      priceRaw === null ? null : parseHtmlMoney(priceRaw, currency, profile.decimal, profile.grouping);
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
            .replace(/\s+(?:shipping|delivery|estimate)\b.*$/i, "")
            .trim()
        : shippingRaw;
      shippingStatus = "observed";
      shippingCents = parseHtmlMoney(cleaned, currency, profile.decimal, profile.grouping);
    } else if (envelope && shippingEvidence === null && shippingRaw) {
      if (/not\s+specified|calculate/i.test(shippingRaw)) {
        shippingStatus = "unknown";
        shippingCents = null;
      } else if (/^free\b|free\s+.*shipping|免费运费|免运费/i.test(shippingRaw)) {
        shippingStatus = "verified_free_shipping";
        shippingCents = 0;
      } else {
        const cleaned = shippingRaw
          .replace(/^\+\s*/, "")
          .replace(/\s+(?:shipping|delivery|estimate)\b.*$/i, "")
          .trim();
        shippingStatus = "observed";
        shippingCents = parseHtmlMoney(cleaned, currency, profile.decimal, profile.grouping);
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
          const match = /^\s*(\S+)\s+([1-9]\d{0,4})w\s*$/.exec(part);
          if (!match?.[1] || !match[2]) throw new Error("html_srcset_invalid");
          imageChoices.push({ url: safeUrl(match[1], profile.imageHosts), width: Number(match[2]) });
        }
      } else {
        const url = image.attr("data-src") || image.attr("src");
        if (url && !(envelope && (/^data:image\//i.test(url) || /\/s\.gif$|s-l64\./i.test(url))))
          imageChoices.push({ url: safeUrl(url, profile.imageHosts), width: 0 });
      }
    });
    imageChoices.sort((a, b) => b.width - a.width || a.url.localeCompare(b.url));
    const attributes: Record<string, string> = {},
      attrNodes = row.find(profile.attributes);
    if (attrNodes.length > 32) throw new Error("html_attribute_budget_exceeded");
    attrNodes.each((_, attrNode) => {
      const attr = $(attrNode),
        name = attr.attr("data-name"),
        text = attr.text().trim();
      if (
        !name ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(name) ||
        Object.hasOwn(attributes, name) ||
        !text ||
        text.length > 500
      )
        throw new Error("html_attribute_invalid");
      attributes[name] = text;
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
      attributes: attrNodes.length ? "present" : "missing",
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
  const emptyNodes = root.find(profile.empty);
  const emptyConfirmed =
    emptyNodes.length === 1 &&
    (emptyNodes.attr("data-confirmed") === "true" ||
      (envelope &&
        /no\s+exact\s+matches\s+found|0\s+results\s+found|no\s+results\s+for/i.test(emptyNodes.text())));
  if (!records.length && !emptyConfirmed) throw new Error("html_empty_not_confirmed");
  if (records.length && emptyNodes.length) throw new Error("html_empty_conflict");
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
    const rawCount = value(root, profile.reportedCount) ?? value($($.root()), profile.reportedCount);
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
