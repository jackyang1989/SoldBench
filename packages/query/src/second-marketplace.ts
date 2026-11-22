import { createHash } from "node:crypto";
import type { Identity } from "@soldbench/auth";
import {
  evaluateSecondMarketplaceRecords,
  mapSecondMarketplaceCondition,
  SECOND_MARKETPLACES,
  type SecondMarketplaceId,
  type SecondMarketplaceListingState,
  type SecondMarketplaceRecordInput,
  secondMarketplaceCanonicalHash,
} from "@soldbench/core";
import { transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import type { QueryService } from "./index.ts";

type CatalogRow = {
  marketplace_id: string;
  display_name: string;
  selection_status: "selected_first_vertical" | "deferred_candidate";
  default_currency: string;
  supports_sold: boolean;
  supports_active: boolean;
  sold_vs_active_policy: string;
  selection_rationale: string;
  source_gate_passed: boolean;
  media_gate_passed: boolean;
  quality_gate_passed: boolean;
  economics_gate_passed: boolean;
  status: "preview_offline" | "gated" | "active";
};

type SecondMarketplaceRecordRow = {
  id: string;
  marketplace_id: SecondMarketplaceId;
  source_id: string;
  permission_epoch: string | number;
  listing_id: string;
  event_key: string;
  listing_state: SecondMarketplaceListingState;
  query_keyword: string;
  title: string;
  currency: string;
  item_minor: string | number | null;
  shipping_minor: string | number | null;
  shipping_status: "observed" | "verified_free_shipping" | "unknown";
  sale_price_status: "verified_actual" | "displayed_only" | "unknown";
  condition_raw: string | null;
  condition_std: string | null;
  observed_at: Date;
  sold_at: Date | null;
  comparable: boolean;
  primary_image_sha256: string | null;
  primary_image_mime: "image/webp" | "image/png" | "image/jpeg" | null;
  media_rights_status: "authorized" | "missing" | "revoked";
  retention_until: Date;
};

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

function isEnabledSecondMarketplace(value: string): value is SecondMarketplaceId {
  return (SECOND_MARKETPLACES as readonly string[]).includes(value);
}

function hasPrimaryImagePermission(permittedFields: unknown): boolean {
  if (!permittedFields || typeof permittedFields !== "object") return false;
  const research = (permittedFields as Record<string, unknown>).research;
  return Array.isArray(research) && research.includes("primary_image");
}

/**
 * Coordinates second-marketplace vertical onboarding (`TASK-052`, `AT-069`):
 * `mercari_us` strict sold-vs-active partitioning, deduplicated observations,
 * controlled local image serving, and immediate per-marketplace revocation.
 */
export class SecondMarketplaceService {
  constructor(readonly query: QueryService) {}

  async listMarketplaces() {
    const rows = (
      await this.query.db.query<CatalogRow>(
        `SELECT marketplace_id,display_name,selection_status,default_currency,
                supports_sold,supports_active,sold_vs_active_policy,selection_rationale,
                source_gate_passed,media_gate_passed,quality_gate_passed,economics_gate_passed,status
         FROM second_marketplace_catalog
         ORDER BY CASE marketplace_id WHEN 'mercari_us' THEN 0 ELSE 1 END, marketplace_id ASC`,
      )
    ).rows;
    return rows.map((r) => ({
      marketplace_id: r.marketplace_id,
      display_name: r.display_name,
      selection_status: r.selection_status,
      default_currency: r.default_currency,
      supports_sold: r.supports_sold,
      supports_active: r.supports_active,
      sold_vs_active_policy: r.sold_vs_active_policy,
      selection_rationale: r.selection_rationale,
      gates: {
        source_gate_passed: r.source_gate_passed,
        media_gate_passed: r.media_gate_passed,
        quality_gate_passed: r.quality_gate_passed,
        economics_gate_passed: r.economics_gate_passed,
      },
      status: r.status,
    }));
  }

  async ingestRecord(input: {
    marketplace: string;
    sourceId: string;
    listingId: string;
    eventKey: string;
    listingState: SecondMarketplaceListingState;
    queryKeyword: string;
    title: string;
    currency: string;
    itemMinor: number | null;
    shippingMinor: number | null;
    shippingStatus: "observed" | "verified_free_shipping" | "unknown";
    salePriceStatus: "verified_actual" | "displayed_only" | "unknown";
    conditionRaw?: string | null;
    conditionStd?: string | null;
    observedAt: string;
    soldAt?: string | null;
    comparable?: boolean;
    retentionUntil: string;
    primaryImageBytes?: Buffer | null;
    primaryImageMime?: "image/webp" | "image/png" | "image/jpeg" | null;
  }) {
    if (!isEnabledSecondMarketplace(input.marketplace))
      fail("invalid_parameter", 400, "Unsupported or deferred second marketplace.");
    if (!uuidRe.test(input.sourceId)) fail("invalid_parameter", 400, "Invalid sourceId.");
    if (input.currency !== "USD") fail("invalid_parameter", 422, "mercari_us accepts USD only.");
    const imageBytes = input.primaryImageBytes ?? null;
    const imageMime = imageBytes ? (input.primaryImageMime ?? "image/png") : null;
    const imageSha = imageBytes ? createHash("sha256").update(imageBytes).digest("hex") : null;
    const mediaStatus = imageBytes ? "authorized" : "missing";
    const conditionStd =
      input.conditionStd ?? mapSecondMarketplaceCondition(input.marketplace, input.conditionRaw);

    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const sourceRow = (
        await c.query<{ permission_epoch: string }>(
          `SELECT s.permission_epoch
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.id=$1 AND s.marketplace=$2 AND s.status='active'
             AND s.access_method='offline_fixture' AND x.provider='synthetic_fixture'
             AND x.status IN ('draft','reviewed','active')
             AND (x.effective_at IS NULL OR x.effective_at<=$3)
             AND (x.expires_at IS NULL OR x.expires_at>$3)
           FOR SHARE OF s, x`,
          [input.sourceId, input.marketplace, now],
        )
      ).rows[0];
      if (!sourceRow)
        fail("forbidden", 403, `Source ${input.sourceId} is not active for ${input.marketplace}.`);

      const row = (
        await c.query<{ id: string }>(
          `INSERT INTO second_marketplace_records(
             marketplace_id,source_id,permission_epoch,listing_id,event_key,listing_state,
             query_keyword,title,currency,item_minor,shipping_minor,shipping_status,sale_price_status,
             condition_raw,condition_std,observed_at,sold_at,comparable,
             primary_image_sha256,primary_image_mime,primary_image_bytes,media_rights_status,retention_until
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           ON CONFLICT (marketplace_id,source_id,event_key) DO UPDATE SET
             listing_state = CASE
               WHEN second_marketplace_records.listing_state = 'sold' THEN 'sold'
               ELSE EXCLUDED.listing_state
             END,
             title = EXCLUDED.title,
             item_minor = EXCLUDED.item_minor,
             shipping_minor = EXCLUDED.shipping_minor,
             shipping_status = EXCLUDED.shipping_status,
             sale_price_status = EXCLUDED.sale_price_status,
             condition_raw = EXCLUDED.condition_raw,
             condition_std = EXCLUDED.condition_std,
             observed_at = GREATEST(second_marketplace_records.observed_at, EXCLUDED.observed_at),
             sold_at = COALESCE(second_marketplace_records.sold_at, EXCLUDED.sold_at),
             comparable = EXCLUDED.comparable,
             primary_image_sha256 = COALESCE(EXCLUDED.primary_image_sha256, second_marketplace_records.primary_image_sha256),
             primary_image_mime = COALESCE(EXCLUDED.primary_image_mime, second_marketplace_records.primary_image_mime),
             primary_image_bytes = COALESCE(EXCLUDED.primary_image_bytes, second_marketplace_records.primary_image_bytes),
             media_rights_status = CASE
               WHEN EXCLUDED.primary_image_bytes IS NOT NULL THEN 'authorized'
               ELSE second_marketplace_records.media_rights_status
             END,
             retention_until = GREATEST(second_marketplace_records.retention_until, EXCLUDED.retention_until),
             updated_at = now()
           RETURNING id`,
          [
            input.marketplace,
            input.sourceId,
            Number(sourceRow.permission_epoch),
            input.listingId,
            input.eventKey,
            input.listingState,
            input.queryKeyword.trim(),
            input.title.trim(),
            input.currency,
            input.itemMinor,
            input.shippingMinor,
            input.shippingStatus,
            input.salePriceStatus,
            input.conditionRaw ?? null,
            conditionStd,
            input.observedAt,
            input.soldAt ?? null,
            input.comparable ?? true,
            imageSha,
            imageMime,
            imageBytes,
            mediaStatus,
            input.retentionUntil,
          ],
        )
      ).rows[0];
      if (!row) fail("internal_error", 500, "Failed to persist second marketplace record.");
      return { id: row.id };
    });
  }

  async queryMarketplace(
    identity: Identity,
    input: {
      marketplace: string;
      q: string;
      price_basis?: string;
      condition?: string;
      limit?: number;
    },
  ) {
    if (!input.marketplace) fail("invalid_parameter", 400, "marketplace is required.");
    if (!isEnabledSecondMarketplace(input.marketplace)) {
      if (["poshmark_us", "grailed", "depop"].includes(input.marketplace)) {
        fail(
          "marketplace_not_enabled",
          422,
          `${input.marketplace} is a deferred candidate outside the first vertical (mercari_us).`,
        );
      }
      fail("invalid_parameter", 400, "Unsupported marketplace identifier.");
    }
    const q = input.q.trim();
    if (!q || q.length > 120) fail("invalid_parameter", 400, "q must be 1..120 characters.");
    const priceBasis = input.price_basis ?? "item";
    if (priceBasis !== "item" && priceBasis !== "item_plus_observed_shipping") {
      fail("invalid_parameter", 400, "price_basis must be item or item_plus_observed_shipping.");
    }
    const condition = input.condition?.trim().toLowerCase() || undefined;
    if (condition && !/^[a-z0-9_]{1,40}$/.test(condition)) {
      fail("invalid_parameter", 400, "Invalid condition filter.");
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      fail("invalid_parameter", 400, "limit must be between 1 and 200.");
    }

    const canonicalHash = secondMarketplaceCanonicalHash({
      marketplace: input.marketplace,
      q,
      priceBasis,
      condition,
      limit,
    });

    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const catalogRow = (
        await c.query<CatalogRow>(
          `SELECT marketplace_id,display_name,selection_status,default_currency,
                  supports_sold,supports_active,sold_vs_active_policy,selection_rationale,
                  source_gate_passed,media_gate_passed,quality_gate_passed,economics_gate_passed,status
           FROM second_marketplace_catalog WHERE marketplace_id=$1`,
          [input.marketplace],
        )
      ).rows[0];
      if (!catalogRow) fail("not_found", 404, "Second marketplace catalog entry not found.");

      const activeSources = (
        await c.query<{ id: string; permission_epoch: string; permitted_fields: unknown }>(
          `SELECT s.id,s.permission_epoch,x.permitted_fields
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.marketplace=$1
             AND s.access_method='offline_fixture'
             AND x.provider='synthetic_fixture'
             AND s.status='active'
             AND x.status IN ('draft','reviewed','active')
             AND (x.effective_at IS NULL OR x.effective_at<=$2)
             AND (x.expires_at IS NULL OR x.expires_at>$2)`,
          [input.marketplace, now],
        )
      ).rows;
      if (!activeSources.length) {
        fail("forbidden", 403, `Source rights are unavailable or revoked for ${input.marketplace}.`);
      }

      const sourceMap = new Map(
        activeSources.map((s) => [
          s.id,
          {
            epoch: BigInt(s.permission_epoch),
            imagePermitted: hasPrimaryImagePermission(s.permitted_fields),
          },
        ]),
      );

      const rawRows = (
        await c.query<SecondMarketplaceRecordRow>(
          `SELECT id,marketplace_id,source_id,permission_epoch,listing_id,event_key,listing_state,
                  query_keyword,title,currency,item_minor,shipping_minor,shipping_status,sale_price_status,
                  condition_raw,condition_std,observed_at,sold_at,comparable,
                  primary_image_sha256,primary_image_mime,media_rights_status,retention_until
           FROM second_marketplace_records
           WHERE marketplace_id=$1 AND lower(query_keyword)=lower($2) AND retention_until>$3
           ORDER BY sold_at DESC NULLS LAST, observed_at DESC, id ASC
           LIMIT 400`,
          [input.marketplace, q, now],
        )
      ).rows.filter((r) => {
        const src = sourceMap.get(r.source_id);
        if (!src || src.epoch !== BigInt(r.permission_epoch)) return false;
        if (condition && r.condition_std !== condition) return false;
        return true;
      });

      const mapped: SecondMarketplaceRecordInput[] = rawRows.map((r) => {
        const src = sourceMap.get(r.source_id);
        const mediaAuthorized =
          Boolean(src?.imagePermitted) &&
          r.media_rights_status === "authorized" &&
          Boolean(r.primary_image_sha256);
        const mediaStatus: "available" | "missing" | "revoked" =
          r.media_rights_status === "revoked" ? "revoked" : mediaAuthorized ? "available" : "missing";
        return {
          id: r.id,
          marketplace: r.marketplace_id,
          listingId: r.listing_id,
          eventKey: r.event_key,
          listingState: r.listing_state,
          title: r.title,
          currency: r.currency,
          itemMinor: r.item_minor === null ? null : Number(r.item_minor),
          shippingMinor: r.shipping_minor === null ? null : Number(r.shipping_minor),
          shippingStatus: r.shipping_status,
          salePriceStatus: r.sale_price_status,
          conditionStd: r.condition_std,
          observedAt: r.observed_at.toISOString(),
          soldAt: r.sold_at ? r.sold_at.toISOString() : null,
          comparable: r.comparable,
          primaryImagePath: mediaAuthorized
            ? `/v1/marketplaces/${r.marketplace_id}/records/${r.id}/image`
            : null,
          mediaStatus,
        };
      });

      const evaluated = evaluateSecondMarketplaceRecords(mapped, {
        priceBasis,
        expectedCurrency: catalogRow.default_currency,
        limit,
      });

      return {
        marketplace: catalogRow.marketplace_id,
        display_name: catalogRow.display_name,
        selection_status: catalogRow.selection_status,
        currency: catalogRow.default_currency,
        data_mode: "offline_fixture",
        source_status: "active",
        canonical_query_hash: canonicalHash,
        credits_charged: 0 as const,
        sold_vs_active_policy: catalogRow.sold_vs_active_policy,
        gates: {
          source_gate_passed: catalogRow.source_gate_passed,
          media_gate_passed: catalogRow.media_gate_passed,
          quality_gate_passed: catalogRow.quality_gate_passed,
          economics_gate_passed: catalogRow.economics_gate_passed,
        },
        status: catalogRow.status,
        data_as_of: now.toISOString(),
        ...evaluated,
      };
    });
  }

  async getRecordImage(identity: Identity, marketplace: string, recordId: string) {
    if (!isEnabledSecondMarketplace(marketplace)) {
      fail("invalid_parameter", 400, "Unsupported second marketplace.");
    }
    if (!uuidRe.test(recordId)) {
      fail("invalid_parameter", 400, "Invalid record_id.");
    }
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const row = (
        await c.query<{
          primary_image_bytes: Buffer | null;
          primary_image_mime: string | null;
          primary_image_sha256: string | null;
          media_rights_status: string;
          record_epoch: string;
          source_epoch: string;
          source_status: string;
          clearance_status: string;
          permitted_fields: unknown;
          retention_until: Date;
        }>(
          `SELECT r.primary_image_bytes,r.primary_image_mime,r.primary_image_sha256,
                  r.media_rights_status,r.permission_epoch AS record_epoch,r.retention_until,
                  s.permission_epoch AS source_epoch,s.status AS source_status,
                  x.status AS clearance_status,x.permitted_fields
           FROM second_marketplace_records r
           JOIN sources s ON s.id=r.source_id
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE r.id=$1 AND r.marketplace_id=$2 AND s.marketplace=$2
             AND s.access_method='offline_fixture' AND x.provider='synthetic_fixture'`,
          [recordId, marketplace],
        )
      ).rows[0];
      if (!row) fail("not_found", 404, "Record image not found.");
      if (
        row.source_status !== "active" ||
        !["draft", "reviewed", "active"].includes(row.clearance_status) ||
        BigInt(row.source_epoch) !== BigInt(row.record_epoch) ||
        row.media_rights_status !== "authorized" ||
        !hasPrimaryImagePermission(row.permitted_fields)
      ) {
        fail("forbidden", 403, "Image rights revoked or unavailable.");
      }
      if (row.retention_until <= now || !row.primary_image_bytes || !row.primary_image_mime) {
        fail("not_found", 404, "Record image expired or missing.");
      }
      return {
        bytes: row.primary_image_bytes,
        mime: row.primary_image_mime,
        sha256: row.primary_image_sha256 ?? "",
      };
    });
  }

  async reconcileRetention() {
    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const res = await c.query(
        `UPDATE second_marketplace_records r
         SET primary_image_bytes = NULL,
             primary_image_mime = NULL,
             primary_image_sha256 = NULL,
             media_rights_status = 'revoked',
             updated_at = now()
         FROM sources s
         WHERE r.source_id = s.id
           AND r.primary_image_bytes IS NOT NULL
           AND (
             r.retention_until <= $1
             OR s.status <> 'active'
             OR s.permission_epoch <> r.permission_epoch
           )`,
        [now],
      );
      return { cleaned_images: res.rowCount ?? 0 };
    });
  }
}
