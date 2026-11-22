import type { Candidate } from "@soldbench/core";
import { approvedImageUrl } from "@soldbench/media";
import { type CheerioAPI, load } from "cheerio/slim";
import { EBAY_ITEM_SPECIFIC_MAP, mapStandardCondition } from "./html.ts";

export type EbayItemDetailEvidence = {
  listingId: string;
  canonicalUrl: string;
  category: string | null;
  attributes: Record<string, string>;
  conditionId: string | null;
  conditionRaw: string | null;
  conditionStandard: Candidate["condition"] | null;
  description: string | null;
  defects: string | null;
  primaryImageUrl: string | null;
  soldStatus: "sold" | "ended" | "unknown";
  bestOfferAccepted: boolean;
};

export const EBAY_BREADCRUMB_CATEGORY_MAP: Readonly<Record<string, string>> = Object.freeze({
  "graphics/video cards": "gpu_hardware",
  "video cards": "gpu_hardware",
  "athletic shoes": "sneakers",
  sneakers: "sneakers",
  wristwatches: "watches",
  "video games & consoles": "video_games",
  "video game consoles": "video_games",
  "video games": "video_games",
  collectibles: "collectibles",
});

const GRADED_CARD_BREADCRUMBS = new Set([
  "sports trading cards",
  "ccg individual cards",
  "non-sport trading cards",
  "trading card singles",
]);

const DETAIL_ACCESS_BLOCKS = [
  "form#captcha_form",
  "div.pgHeading",
  "div#splashui-challenge",
  'form[action*="splashui/challenge"]',
  "section.access-wall",
  "form.access-login",
];

const DETAIL_CONTAINER_SELECTORS =
  'div.ux-layout-section--itemSpecifics, div.x-item-title, div#CenterPanel, div.itemAttr, main[itemtype*="Product"]';

export function mapEbayBreadcrumbsToCategory(
  crumbs: readonly string[],
  attributes: Readonly<Record<string, string>>,
): string | null {
  let matchedCollectibles = false;
  let matchedSpecific: string | null = null;
  for (const raw of crumbs) {
    const label = raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (!label) continue;
    if (GRADED_CARD_BREADCRUMBS.has(label)) {
      if (attributes.grading_company && attributes.grade) return "cards_graded";
      continue;
    }
    const direct = EBAY_BREADCRUMB_CATEGORY_MAP[label];
    if (!direct) continue;
    if (direct === "collectibles") matchedCollectibles = true;
    else matchedSpecific = direct;
  }
  return matchedSpecific ?? (matchedCollectibles ? "collectibles" : null);
}

export function hasEbayDetailAccessBlock(raw: Uint8Array): boolean {
  if (raw.byteLength > 4 * 1024 * 1024) return false;
  try {
    const $ = load(new TextDecoder("utf-8", { fatal: true }).decode(raw), { xml: { xmlMode: false } });
    $("script,style,template,noscript,iframe,svg").remove();
    if (DETAIL_ACCESS_BLOCKS.some((rule) => $(rule).length > 0)) return true;
    if ($(DETAIL_CONTAINER_SELECTORS).length === 0) {
      const challengeBanner =
        /pardon\s+our\s+interruption|security\s+measure|checking\s+your\s+browser\s+before\s+you\s+access\s+ebay|error\s+page\s*\|\s*ebay/i;
      if (
        $("title, h1, h2")
          .toArray()
          .some((el) => challengeBanner.test($(el).text()))
      )
        return true;
    }
    return false;
  } catch {
    return false;
  }
}

function cleanText(node: ReturnType<CheerioAPI>): string {
  const clone = node.clone();
  clone.find(".clipped, .LIGHT_HIGHLIGHT").remove();
  return clone.text().replace(/\s+/g, " ").trim();
}

function placeholderImage(url: string): boolean {
  return /^data:image\//i.test(url) || /\/s\.gif$|s-l64\.|s_1x2\.gif/i.test(url);
}

function extractListingIdFromProof(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{6,19}$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const m = /^\/itm\/(?:.+\/)?(\d{6,19})\/?$/.exec(parsed.pathname);
    return m?.[1] ?? null;
  } catch {
    const m = /\/itm\/(?:.+\/)?(\d{6,19})(?:[/?#]|$)/.exec(trimmed);
    if (m?.[1]) return m[1];
    const digits = /\b(\d{6,19})\b/.exec(trimmed);
    return digits?.[1] ?? null;
  }
}

export function parseEbayUsItemDetailHtml(
  raw: Uint8Array,
  binding: { listingId: string; imageHosts?: readonly string[]; listingHosts?: readonly string[] },
): EbayItemDetailEvidence {
  if (!/^\d{6,19}$/.test(binding.listingId)) throw new Error("invalid_ebay_listing_id");
  if (raw.byteLength > 4 * 1024 * 1024) throw new Error("html_page_too_large");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (html.includes("\u0000")) throw new Error("html_text_invalid");
  const $ = load(html, { xml: { xmlMode: false, decodeEntities: true } });
  $("script,style,template,noscript,iframe,svg").remove();
  if ($("*").length > 40000) throw new Error("html_node_budget_exceeded");

  const listingHosts = binding.listingHosts ?? ["www.ebay.com", "ebay.com"];
  const imageHosts = binding.imageHosts ?? ["i.ebayimg.com"];

  const proofs: string[] = [];
  const canonicalHref = $('link[rel="canonical"]').attr("href")?.trim();
  if (canonicalHref) {
    approvedImageUrl(canonicalHref, listingHosts);
    const id = extractListingIdFromProof(canonicalHref);
    if (id) proofs.push(id);
  }
  const ogUrl = $('meta[property="og:url"]').attr("content")?.trim();
  if (ogUrl) {
    approvedImageUrl(ogUrl, listingHosts);
    const id = extractListingIdFromProof(ogUrl);
    if (id) proofs.push(id);
  }
  const itemNumEl = $(
    'div.ux-layout-section--itemId .ux-textspans--BOLD, [data-testid="x-item-id"], #descItemNumber',
  ).first();
  if (itemNumEl.length) {
    const id = extractListingIdFromProof(cleanText(itemNumEl));
    if (id) proofs.push(id);
  }
  if (!proofs.length || proofs.some((id) => id !== binding.listingId)) {
    throw new Error("detail_listing_id_mismatch");
  }
  const canonicalUrl = approvedImageUrl(`https://www.ebay.com/itm/${binding.listingId}`, listingHosts);

  const attributes: Record<string, string> = {};
  const recordAttribute = (rawLabel: string, rawValue: string) => {
    const label = rawLabel.replace(/:$/, "").replace(/\s+/g, " ").trim().toLowerCase();
    const key = EBAY_ITEM_SPECIFIC_MAP[label];
    if (!key) return;
    let normalized = rawValue.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 500) return;
    if (key === "vram_gb") {
      const gb = /^(\d{1,3})\s*gb$/i.exec(normalized);
      if (gb?.[1]) normalized = gb[1];
    }
    if (Object.hasOwn(attributes, key)) {
      if (attributes[key] !== normalized) throw new Error("detail_attribute_conflict");
      return;
    }
    if (Object.keys(attributes).length >= 32) throw new Error("html_attribute_budget_exceeded");
    attributes[key] = normalized;
  };

  $("div.ux-layout-section--itemSpecifics dl.ux-labels-values").each((_, dl) => {
    $(dl)
      .find("dt")
      .each((__, dtEl) => {
        const dt = $(dtEl);
        const dd = dt.next("dd");
        if (dd.length) recordAttribute(cleanText(dt), cleanText(dd));
      });
  });

  $("div.ux-layout-section--itemSpecifics div.ux-labels-values").each((_, row) => {
    const labelEl = $(row).find(".ux-labels-values__labels").first();
    const valEl = $(row).find(".ux-labels-values__values").first();
    if (labelEl.length && valEl.length) recordAttribute(cleanText(labelEl), cleanText(valEl));
  });

  $("div.itemAttr table td.attrLabels").each((_, labelTd) => {
    const labelEl = $(labelTd);
    const valEl = labelEl.next("td");
    if (valEl.length) recordAttribute(cleanText(labelEl), cleanText(valEl));
  });

  const crumbs = $("nav.breadcrumbs a, ul.breadcrumbs a, #vi-VR-brumb-lnkLst a")
    .toArray()
    .map((el) => cleanText($(el)))
    .filter(Boolean);
  const category = mapEbayBreadcrumbsToCategory(crumbs, attributes);
  if (category) {
    if (Object.hasOwn(attributes, "category")) {
      if (attributes.category !== category) throw new Error("detail_attribute_conflict");
    } else {
      if (Object.keys(attributes).length >= 32) throw new Error("html_attribute_budget_exceeded");
      attributes.category = category;
    }
  }

  const condEl = $(
    '[data-testid="x-item-condition-atf"] .ux-textspans, div.x-item-condition-text .ux-textspans, #vi-itm-cond',
  ).first();
  const conditionRawText = condEl.length ? cleanText(condEl).slice(0, 500) : "";
  const conditionRaw = conditionRawText || null;
  const condIdRaw = $(
    '[data-testid="x-item-condition-atf"] [data-condition-id], div.x-item-condition-text[data-condition-id], #vi-itm-cond[data-condition-id]',
  )
    .first()
    .attr("data-condition-id")
    ?.trim();
  const conditionId = condIdRaw && condIdRaw.length <= 64 ? condIdRaw : null;
  const conditionStandard = mapStandardCondition(conditionRaw);

  const defectsEl = $(
    '.x-item-condition-desc .ux-textspans, [data-testid="x-item-condition-desc"], #vi-cond-addl-info',
  ).first();
  const defectsText = defectsEl.length ? cleanText(defectsEl).slice(0, 2000) : "";
  const defects = defectsText || null;

  const descEl = $(
    "div.d-item-description, div.x-item-description, #viTabs_0_is .d-item-description-content",
  ).first();
  const descText = descEl.length ? cleanText(descEl).slice(0, 2000) : "";
  const description = descText || null;

  let primaryImageUrl: string | null = null;
  const imgNodes = $(".ux-image-carousel-item.active img, div.ux-image-magnify__container img, img#icImg");
  for (const el of imgNodes.toArray()) {
    const img = $(el);
    const candidate =
      img.attr("data-zoom-src")?.trim() || img.attr("data-src")?.trim() || img.attr("src")?.trim();
    if (candidate && !placeholderImage(candidate)) {
      primaryImageUrl = approvedImageUrl(candidate, imageHosts);
      break;
    }
  }

  const statusText = cleanText($(".d-statusmessage, [data-testid='d-statusmessage']").first());
  const priceBox = $(".x-price-primary").first();
  const priceText = cleanText(priceBox);
  let soldStatus: EbayItemDetailEvidence["soldStatus"] = "unknown";
  if (/this\s+listing\s+was\s+sold|winning\s+bid|sold\s+for/i.test(statusText)) soldStatus = "sold";
  else if (/this\s+listing\s+has\s+ended|bidding\s+has\s+ended/i.test(statusText)) soldStatus = "ended";

  const bestOfferAccepted =
    /best\s+offer\s+accepted/i.test(`${statusText} ${priceText}`) ||
    priceBox.find(".STRIKETHROUGH, s, del").length > 0;

  return {
    listingId: binding.listingId,
    canonicalUrl,
    category,
    attributes,
    conditionId,
    conditionRaw,
    conditionStandard,
    description,
    defects,
    primaryImageUrl,
    soldStatus,
    bestOfferAccepted,
  };
}
