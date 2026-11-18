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
  root: string;
  records: string;
  empty: string;
  primaryImages: string;
  accessBlocks: string[];
  attributes: string;
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
    value.length <= 240 &&
    /^[a-zA-Z0-9_.#[\]="' >-]+$/.test(value)
  );
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
    ![x.root, x.records, x.empty, x.primaryImages, x.attributes].every(selector) ||
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
    "root",
    "records",
    "empty",
    "primaryImages",
    "accessBlocks",
    "attributes",
    "fields",
    "listingHosts",
    "imageHosts",
    "allowSyntheticSeller",
    "shippingContexts",
    "decimal",
    "grouping",
  ]);
  if (Object.keys(x).some((key) => !allowed.has(key))) throw new Error("invalid_html_profile");
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
      x.empty,
      x.primaryImages,
      x.attributes,
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
export function parseHtmlPage(
  raw: Uint8Array,
  binding: { sourceId: string; queryHash: string; cursor: string; asOf: string },
  input: HtmlProfile,
): FixturePage {
  const profile = validateHtmlProfile(input),
    profileHash = digest(canonicalJson(profile));
  if (raw.byteLength > 1024 * 1024) throw new Error("html_page_too_large");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (html.includes("\u0000")) throw new Error("html_text_invalid");
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: true, withStartIndices: true } });
  if ($("*").length > 12000) throw new Error("html_node_budget_exceeded");
  $("script,style,template,noscript,iframe").remove();
  const root = $(profile.root);
  if (
    root.length !== 1 ||
    root.attr("data-sb-schema") !== "soldbench.synthetic-html.v1" ||
    root.attr("data-source-id") !== binding.sourceId ||
    root.attr("data-query-hash") !== binding.queryHash ||
    root.attr("data-cursor") !== binding.cursor
  )
    throw new Error("html_page_binding_invalid");
  const asOf = root.attr("data-as-of") ?? "";
  if (instant(asOf) > instant(binding.asOf)) throw new Error("html_page_future_watermark");
  const next = root.attr("data-next-cursor");
  if (next === undefined) throw new Error("html_pagination_unknown");
  const records: FixtureListing[] = [],
    nodes = root.find(profile.records);
  if (nodes.length > 1000) throw new Error("html_record_budget_exceeded");
  if (nodes.toArray().some((node) => $(node).parents(profile.records).length))
    throw new Error("html_nested_record");
  nodes.each((index, node) => {
    const row = $(node),
      kind = row.attr("data-kind");
    if (["advertisement", "recommendation"].includes(kind ?? "")) return;
    if (kind !== "sold-record") throw new Error("html_record_kind_unknown");
    const read = (key: FieldName) => {
      const field = profile.fields[key];
      return field ? value(row, field) : null;
    };
    if (read("sold") !== "sold") throw new Error("html_sale_not_confirmed");
    const listingId = read("listingId"),
      title = read("title"),
      currency = read("currency");
    if (!listingId || !title || !currency) throw new Error("html_required_field_missing");
    const rawEvent = read("eventKey"),
      independent = read("eventProof") === "independent_event";
    if (independent && !rawEvent) throw new Error("html_event_proof_incomplete");
    const eventKey = independent ? rawEvent : null;
    const format = read("format");
    if (!["fixed_price", "auction", "best_offer"].includes(format ?? ""))
      throw new Error("html_format_unknown");
    const priceRaw = read("price"),
      priceEvidence = read("priceEvidence");
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
        !(shippingRaw && parseHtmlMoney(shippingRaw, currency, profile.decimal, profile.grouping) === 0)
      )
        throw new Error("html_free_shipping_inconsistent");
      shippingStatus = "verified_free_shipping";
      shippingCents = 0;
    } else if (shippingEvidence === "observed") {
      if (!shippingRaw) throw new Error("html_shipping_missing");
      shippingStatus = "observed";
      shippingCents = parseHtmlMoney(shippingRaw, currency, profile.decimal, profile.grouping);
    }
    const shippingContext = read("shippingContextRef");
    if (shippingContext !== null && !profile.shippingContexts?.includes(shippingContext))
      throw new Error("html_shipping_context_unknown");
    const soldDateRaw = read("date"),
      zone = read("timeZone");
    let time: Candidate["time"] = { precision: "unknown" };
    if (read("dateSemantics") === "sold" && soldDateRaw) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(soldDateRaw))
        time = { precision: "day", value: soldDateRaw, timeZone: zone };
      else {
        instant(soldDateRaw);
        time = { precision: "instant", value: soldDateRaw };
      }
    }
    const conditionRaw = read("condition"),
      conditionId = read("conditionId"),
      conditionStandard = read("conditionStandard"),
      description = read("description"),
      defects = read("defects"),
      link = read("link");
    if (conditionStandard !== null && !isStandardCondition(conditionStandard))
      throw new Error("html_standard_condition_invalid");
    const images = row.find(profile.primaryImages),
      imageChoices: Array<{ url: string; width: number }> = [];
    if (images.length > 8) throw new Error("html_image_budget_exceeded");
    images.each((_, imageNode) => {
      const image = $(imageNode);
      if (
        image.attr("data-role") !== "primary" ||
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
        if (url) imageChoices.push({ url: safeUrl(url, profile.imageHosts), width: 0 });
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
    const evidence: Extract<RecordEvidence, { schema: "soldbench.record-evidence.v2" }> = {
      schema: "soldbench.record-evidence.v2",
      profileHash,
      recordIndex: index,
      listingUrl: link ? safeUrl(link, profile.listingHosts, true) : null,
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
      listingUrl: link ? "present" : "missing",
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
    records.push({
      listingId,
      title,
      recordEvidence: evidence,
      candidate: {
        sourceId: binding.sourceId,
        title,
        eventKey,
        identityVerified: independent,
        comparable: row.attr("data-comparable") === "true",
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
  if (
    !records.length &&
    (root.find(profile.empty).length !== 1 || root.find(profile.empty).attr("data-confirmed") !== "true")
  )
    throw new Error("html_empty_not_confirmed");
  if (records.length && root.find(profile.empty).length) throw new Error("html_empty_conflict");
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
  }
  return parseFixturePage(Buffer.from(JSON.stringify(page)), binding, profile.shippingContexts);
}
