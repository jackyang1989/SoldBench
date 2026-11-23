import { createHash } from "node:crypto";
import type { Identity } from "@soldbench/auth";
import {
  canonicalJson,
  convertMinorWithFx,
  evaluateSiteComparables,
  type FxSnapshotInput,
  type MarketplaceSite,
  type RegionalRecord,
  SITE_SPECS,
  type SiteCurrency,
  SUPPORTED_SITES,
  V15_SITES,
} from "@soldbench/core";
import { transaction } from "@soldbench/db";
import {
  AppError,
  assertRegionalCatalogComplete,
  formatRegionalDate,
  formatRegionalMoney,
  REGIONAL_LOCALES,
  type RegionalLocale,
  regionalMessage,
  regionalMessages,
} from "@soldbench/shared";
import type { QueryService } from "./index.ts";

type SiteRow = {
  site_id: MarketplaceSite;
  country_code: string;
  display_name: string;
  default_currency: SiteCurrency;
  timezone: string;
  required_locales: string[];
  shipping_tax_semantics: Record<string, unknown>;
  condition_mapping_version: string;
  source_gate_passed: boolean;
  translation_gate_passed: boolean;
  legal_gate_passed: boolean;
  economics_gate_passed: boolean;
  status: "preview_offline" | "gated" | "active";
};

type FxRow = {
  id: string;
  base_currency: SiteCurrency;
  quote_currency: SiteCurrency;
  rate_micros: string | number;
  evidence_ref: string;
  provider: string;
  captured_at: Date;
  expires_at: Date;
};

type RegionalRecordRow = {
  id: string;
  site_id: MarketplaceSite;
  source_id: string;
  permission_epoch: string | number;
  query_keyword: string;
  event_key: string;
  title: string;
  currency: string;
  item_minor: string | number | null;
  shipping_minor: string | number | null;
  shipping_status: "observed" | "verified_free_shipping" | "unknown";
  sale_price_status: "verified_actual" | "displayed_only" | "unknown";
  sale_format: "fixed_price" | "auction" | "best_offer";
  condition_raw: string | null;
  condition_std: string | null;
  sold_at: Date | null;
  sold_date_precision: "instant" | "day" | "unknown";
  comparable: boolean;
  retention_until: Date;
};

function fail(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

function isSite(value: string): value is MarketplaceSite {
  return (SUPPORTED_SITES as readonly string[]).includes(value);
}

function isV15Site(value: string): boolean {
  return (V15_SITES as readonly string[]).includes(value);
}

function isRegionalLocale(value: string): value is RegionalLocale {
  return (REGIONAL_LOCALES as readonly string[]).includes(value);
}

/**
 * Coordinates site-explicit US/UK/DE marketplace localization, native currency statistics,
 * FX evidence conversion, and per-site source rights isolation (`TASK-049`, `AT-066`).
 */
export class RegionalSiteService {
  constructor(readonly query: QueryService) {
    assertRegionalCatalogComplete();
  }

  async listSites(includeGlobal = false) {
    const rows = (
      await this.query.db.query<SiteRow>(
        `SELECT site_id,country_code,display_name,default_currency,timezone,required_locales,
                shipping_tax_semantics,condition_mapping_version,source_gate_passed,
                translation_gate_passed,legal_gate_passed,economics_gate_passed,status
         FROM marketplace_sites
         ${includeGlobal ? "" : "WHERE site_id IN ('ebay_us','ebay_uk','ebay_de')"}
         ORDER BY array_position(ARRAY['ebay_us','ebay_uk','ebay_de','ebay_fr','ebay_it','ebay_es','ebay_ca','ebay_au'], site_id)`,
      )
    ).rows;
    return rows.map((r) => ({
      site_id: r.site_id,
      country_code: r.country_code,
      display_name: r.display_name,
      default_currency: r.default_currency,
      timezone: r.timezone,
      required_locales: r.required_locales,
      shipping_tax_semantics: r.shipping_tax_semantics,
      condition_mapping_version: r.condition_mapping_version,
      gates: {
        source_gate_passed: r.source_gate_passed,
        translation_gate_passed: r.translation_gate_passed,
        legal_gate_passed: r.legal_gate_passed,
        economics_gate_passed: r.economics_gate_passed,
      },
      status: r.status,
    }));
  }

  async getSiteLocalization(siteParam: string, requestedLocale?: string, v15Only = false) {
    if (!isSite(siteParam) || (v15Only && !isV15Site(siteParam))) {
      fail("invalid_parameter", 400, "Unsupported marketplace site.");
    }
    assertRegionalCatalogComplete();
    const spec = SITE_SPECS[siteParam];
    let locale: RegionalLocale = spec.primaryLocale;
    if (requestedLocale !== undefined) {
      if (!isRegionalLocale(requestedLocale))
        fail("invalid_parameter", 400, "Unsupported regional display locale.");
      locale = requestedLocale;
    }

    const siteRow = (
      await this.query.db.query<SiteRow>(
        `SELECT site_id,country_code,display_name,default_currency,timezone,required_locales,
                shipping_tax_semantics,condition_mapping_version,source_gate_passed,
                translation_gate_passed,legal_gate_passed,economics_gate_passed,status
         FROM marketplace_sites WHERE site_id=$1`,
        [siteParam],
      )
    ).rows[0];
    if (!siteRow) fail("not_found", 404, "Site configuration not found.");

    const now = await transaction(this.query.db, (c) => this.query.now(c));
    return {
      site_id: siteRow.site_id,
      country_code: siteRow.country_code,
      display_name: siteRow.display_name,
      default_currency: siteRow.default_currency,
      timezone: siteRow.timezone,
      locale,
      locale_follows_site_selection: false,
      ui_messages: regionalMessages[locale],
      email_previews: {
        verify_subject: regionalMessage(locale, "email.verify_subject"),
        verify_body: regionalMessage(locale, "email.verify_body", {
          url: "https://soldbench.com/verify?token=preview",
          expiresMinutes: 30,
        }),
        reset_subject: regionalMessage(locale, "email.reset_subject"),
        reset_body: regionalMessage(locale, "email.reset_body", {
          url: "https://soldbench.com/reset?token=preview",
          expiresMinutes: 30,
        }),
      },
      sample_formats: {
        money_example: formatRegionalMoney(locale, 12345, siteRow.default_currency),
        day_date_example: formatRegionalDate(locale, now.toISOString(), siteRow.timezone, "day"),
        instant_date_example: formatRegionalDate(locale, now.toISOString(), siteRow.timezone, "instant"),
      },
      shipping_tax_semantics: siteRow.shipping_tax_semantics,
      gates: {
        source_gate_passed: siteRow.source_gate_passed,
        translation_gate_passed: siteRow.translation_gate_passed,
        legal_gate_passed: siteRow.legal_gate_passed,
        economics_gate_passed: siteRow.economics_gate_passed,
      },
      status: siteRow.status,
    };
  }

  async listFxSnapshots(baseCurrency?: SiteCurrency, quoteCurrency?: SiteCurrency, v15Only = false) {
    const now = await transaction(this.query.db, (c) => this.query.now(c));
    const clauses = ["expires_at>$1"];
    if (v15Only) {
      clauses.push("base_currency IN ('USD','GBP','EUR') AND quote_currency IN ('USD','GBP','EUR')");
    }
    const params: unknown[] = [now];
    if (baseCurrency) {
      params.push(baseCurrency);
      clauses.push(`base_currency=$${params.length}`);
    }
    if (quoteCurrency) {
      params.push(quoteCurrency);
      clauses.push(`quote_currency=$${params.length}`);
    }
    const rows = (
      await this.query.db.query<FxRow>(
        `SELECT id,base_currency,quote_currency,rate_micros,evidence_ref,provider,captured_at,expires_at
         FROM fx_rate_snapshots
         WHERE ${clauses.join(" AND ")}
         ORDER BY captured_at DESC, id ASC LIMIT 50`,
        params,
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      base_currency: r.base_currency,
      quote_currency: r.quote_currency,
      rate_micros: Number(r.rate_micros),
      evidence_ref: r.evidence_ref,
      provider: r.provider,
      captured_at: r.captured_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
    }));
  }

  async querySiteSoldPreview(
    identity: Identity,
    input: {
      site: string;
      q: string;
      window_days?: number;
      price_basis?: string;
      condition?: string;
      compare_currency?: SiteCurrency;
    },
    v15Only = false,
  ) {
    if (!isSite(input.site) || (v15Only && !isV15Site(input.site))) {
      fail("invalid_parameter", 400, "Unsupported marketplace site.");
    }
    const q = input.q.normalize("NFC").trim().replace(/\s+/g, " ");
    if (!q || q.length > 120) fail("invalid_parameter", 400, "Query must contain 1–120 characters.");

    const windowDays = input.window_days ?? 90;
    if (![30, 90, 180, 365].includes(windowDays))
      fail("invalid_parameter", 400, "window_days must be 30, 90, 180, or 365.");

    const basis = input.price_basis ?? "item_plus_observed_shipping";
    if (basis !== "item" && basis !== "item_plus_observed_shipping")
      fail("invalid_parameter", 400, "Invalid price_basis.");

    const condition = input.condition?.trim() || undefined;
    const allowedCompare = v15Only ? ["USD", "GBP", "EUR"] : ["USD", "GBP", "EUR", "CAD", "AUD"];
    if (input.compare_currency && !allowedCompare.includes(input.compare_currency)) {
      fail("invalid_parameter", 400, `compare_currency must be one of ${allowedCompare.join(", ")}.`);
    }

    const canonicalQueryHash = createHash("sha256")
      .update(
        canonicalJson({
          version: "regional-1.0.0",
          site: input.site,
          q,
          window_days: windowDays,
          price_basis: basis,
          ...(condition ? { condition } : {}),
        }),
      )
      .digest("hex");

    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const siteRow = (
        await c.query<SiteRow>(
          `SELECT site_id,country_code,display_name,default_currency,timezone,required_locales,
                  shipping_tax_semantics,condition_mapping_version,source_gate_passed,
                  translation_gate_passed,legal_gate_passed,economics_gate_passed,status
           FROM marketplace_sites WHERE site_id=$1`,
          [input.site],
        )
      ).rows[0];
      if (!siteRow) fail("not_found", 404, "Site configuration not found.");

      const activeSources = (
        await c.query<{ id: string; permission_epoch: string }>(
          `SELECT s.id,s.permission_epoch
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.marketplace=$1
             AND s.access_method='offline_fixture'
             AND x.provider='synthetic_fixture'
             AND s.status='active'
             AND x.status IN ('draft','reviewed','active')
             AND (x.effective_at IS NULL OR x.effective_at<=$2)
             AND (x.expires_at IS NULL OR x.expires_at>$2)`,
          [input.site, now],
        )
      ).rows;
      if (!activeSources.length) {
        fail("forbidden", 403, `Source rights are unavailable for ${input.site}.`);
      }

      const sourceMap = new Map(activeSources.map((s) => [s.id, BigInt(s.permission_epoch)]));
      const recordRows = (
        await c.query<RegionalRecordRow>(
          `SELECT * FROM regional_site_records
           WHERE site_id=$1 AND lower(query_keyword)=lower($2) AND retention_until>$3
           ORDER BY sold_at DESC NULLS LAST, id ASC LIMIT 200`,
          [input.site, q, now],
        )
      ).rows.filter((r) => sourceMap.get(r.source_id) === BigInt(r.permission_epoch));

      const siteSpec = SITE_SPECS[siteRow.site_id];
      let fxSnapshot: FxSnapshotInput | null = null;
      if (input.compare_currency && input.compare_currency !== siteSpec.currency) {
        const fxRow = (
          await c.query<FxRow>(
            `SELECT id,base_currency,quote_currency,rate_micros,evidence_ref,provider,captured_at,expires_at
             FROM fx_rate_snapshots
             WHERE base_currency=$1 AND quote_currency=$2 AND expires_at>$3
             ORDER BY captured_at DESC, id ASC LIMIT 1`,
            [siteSpec.currency, input.compare_currency, now],
          )
        ).rows[0];
        if (fxRow) {
          fxSnapshot = {
            baseCurrency: fxRow.base_currency,
            quoteCurrency: fxRow.quote_currency,
            rateMicros: Number(fxRow.rate_micros),
            evidenceRef: fxRow.evidence_ref,
            provider: fxRow.provider,
            capturedAt: fxRow.captured_at.toISOString(),
            expiresAt: fxRow.expires_at.toISOString(),
          };
        }
      }

      const records: RegionalRecord[] = recordRows.map((r) => ({
        eventKey: r.event_key,
        currency: r.currency,
        itemMinor: r.item_minor === null ? null : Number(r.item_minor),
        shippingMinor: r.shipping_minor === null ? null : Number(r.shipping_minor),
        shippingStatus: r.shipping_status,
        salePriceStatus: r.sale_price_status,
        saleFormat: r.sale_format,
        conditionStd: r.condition_std,
        comparable: r.comparable,
        time:
          r.sold_at === null || r.sold_date_precision === "unknown"
            ? { precision: "unknown" }
            : r.sold_date_precision === "day"
              ? {
                  precision: "day",
                  value: r.sold_at.toISOString().slice(0, 10),
                  timeZone: siteSpec.timeZone,
                }
              : { precision: "instant", value: r.sold_at.toISOString() },
      }));

      const evaluated = evaluateSiteComparables(records, {
        site: siteRow.site_id,
        asOf: now.toISOString(),
        days: windowDays as 30 | 90 | 180 | 365,
        basis,
        condition,
        compareCurrency: input.compare_currency,
        fxSnapshot,
      });

      return {
        site: siteRow.site_id,
        country_code: siteRow.country_code,
        display_name: siteRow.display_name,
        canonical_query_hash: canonicalQueryHash,
        native_currency: evaluated.native_currency,
        timezone: siteSpec.timeZone,
        shipping_tax_semantics: siteRow.shipping_tax_semantics,
        gates: {
          source_gate_passed: siteRow.source_gate_passed,
          translation_gate_passed: siteRow.translation_gate_passed,
          legal_gate_passed: siteRow.legal_gate_passed,
          economics_gate_passed: siteRow.economics_gate_passed,
        },
        status: siteRow.status,
        currency_mismatch_count: evaluated.currency_mismatch_count,
        native_stats: evaluated.native_stats,
        fx_status: evaluated.fx_status,
        fx_evidence: evaluated.fx_evidence
          ? {
              base_currency: evaluated.fx_evidence.baseCurrency,
              quote_currency: evaluated.fx_evidence.quoteCurrency,
              rate_micros: evaluated.fx_evidence.rateMicros,
              evidence_ref: evaluated.fx_evidence.evidenceRef,
              provider: evaluated.fx_evidence.provider,
              captured_at: evaluated.fx_evidence.capturedAt,
              expires_at: evaluated.fx_evidence.expiresAt,
            }
          : null,
        comparable_view: evaluated.comparable_view,
        data_as_of: now.toISOString(),
        credits_charged: 0,
        comps: recordRows.slice(0, 50).map((r) => {
          const itemMinor = r.item_minor === null ? null : Number(r.item_minor);
          const shippingMinor = r.shipping_minor === null ? null : Number(r.shipping_minor);
          const convertedItem =
            itemMinor !== null && r.currency === evaluated.native_currency && evaluated.fx_evidence
              ? convertMinorWithFx(itemMinor, evaluated.fx_evidence.rateMicros)
              : null;
          return {
            event_key: r.event_key,
            title: r.title,
            currency: r.currency,
            item_minor: itemMinor,
            shipping_minor: shippingMinor,
            shipping_status: r.shipping_status,
            sale_price_status: r.sale_price_status,
            sale_format: r.sale_format,
            condition_raw: r.condition_raw,
            condition_std: r.condition_std,
            sold_at: r.sold_at?.toISOString() ?? null,
            sold_date_precision: r.sold_date_precision,
            comparable: r.comparable,
            converted_item_minor: convertedItem,
          };
        }),
      };
    });
  }
}
