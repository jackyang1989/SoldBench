import { createHash } from "node:crypto";
import type { Identity } from "@soldbench/auth";
import {
  AUCTION_HOUSES,
  AUCTION_PRICE_BASES,
  type AuctionHouseId,
  type AuctionLotInput,
  type AuctionPriceBasis,
  auctionCanonicalHash,
  evaluateAuctionLots,
  GRADING_COMPANIES,
  type GradingCompany,
} from "@soldbench/core";
import { transaction } from "@soldbench/db";
import { AppError, sqlSourceEligibilityClause, sqlSourceKindClause } from "@soldbench/shared";
import type { QueryService } from "./index.ts";

type AuctionCatalogRow = {
  house_id: string;
  display_name: string;
  selection_status: "selected_first_auction" | "deferred_candidate";
  default_currency: string;
  premium_disclosure: string;
  source_gate_passed: boolean;
  media_gate_passed: boolean;
  quality_gate_passed: boolean;
  status: "preview_offline" | "gated" | "active";
};

type AuctionLotRow = {
  id: string;
  auction_house: AuctionHouseId;
  session_code: string;
  session_name: string;
  source_id: string;
  permission_epoch: string | number;
  lot_number: string;
  event_key: string;
  title: string;
  grading_company: GradingCompany | null;
  grade_value: string | null;
  cert_number: string | null;
  currency: string;
  hammer_minor: string | number | null;
  buyers_premium_status: "known" | "none" | "unknown";
  buyers_premium_bps: number | null;
  buyers_premium_minor: string | number | null;
  total_with_premium_minor: string | number | null;
  tax_included: boolean;
  sale_status: "sold" | "unsold" | "withdrawn";
  sold_at: Date | null;
  comparable: boolean;
  primary_image_sha256: string | null;
  media_rights_status: "authorized" | "missing" | "revoked";
};

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

function isEnabledHouse(value: string): value is AuctionHouseId {
  return (AUCTION_HOUSES as readonly string[]).includes(value);
}

function hasPrimaryImagePermission(permittedFields: unknown): boolean {
  if (!permittedFields || typeof permittedFields !== "object") return false;
  const research = (permittedFields as Record<string, unknown>).research;
  return Array.isArray(research) && research.includes("primary_image");
}

/**
 * Coordinates auction sales comparables (`TASK-054`, `AT-071`):
 * traceable sessions/lots/certs, separated hammer vs buyer's premium vs all-in totals,
 * strict non-zeroing of unknown buyer's premium, mixed-basis rejection, and independent source/media rights.
 */
export class AuctionsVerticalService {
  constructor(readonly query: QueryService) {}

  async listAuctionHouses() {
    const rows = (
      await this.query.db.query<AuctionCatalogRow>(
        `SELECT house_id,display_name,selection_status,default_currency,premium_disclosure,
                source_gate_passed,media_gate_passed,quality_gate_passed,status
         FROM auction_house_catalog
         ORDER BY CASE house_id WHEN 'goldin_us' THEN 0 ELSE 1 END, house_id ASC`,
      )
    ).rows;
    return rows.map((r) => ({
      house_id: r.house_id,
      display_name: r.display_name,
      selection_status: r.selection_status,
      default_currency: r.default_currency,
      premium_disclosure: r.premium_disclosure,
      gates: {
        source_gate_passed: r.source_gate_passed,
        media_gate_passed: r.media_gate_passed,
        quality_gate_passed: r.quality_gate_passed,
      },
      status: r.status,
    }));
  }

  async upsertSession(input: {
    house: string;
    sessionCode: string;
    sessionName: string;
    currency: string;
    taxSemantics: string;
    closedAt?: string | null;
  }) {
    if (!isEnabledHouse(input.house)) {
      fail("invalid_parameter", 400, "Unsupported auction house.");
    }
    const row = (
      await this.query.db.query<{ id: string }>(
        `INSERT INTO auction_sessions(auction_house,session_code,session_name,currency,tax_semantics,closed_at)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (auction_house,session_code) DO UPDATE SET
           session_name = EXCLUDED.session_name,
           tax_semantics = EXCLUDED.tax_semantics,
           closed_at = COALESCE(EXCLUDED.closed_at, auction_sessions.closed_at)
         RETURNING id`,
        [
          input.house,
          input.sessionCode,
          input.sessionName,
          input.currency,
          input.taxSemantics,
          input.closedAt ?? null,
        ],
      )
    ).rows[0];
    if (!row) fail("internal_error", 500, "Failed to upsert auction session.");
    return { id: row.id };
  }

  async ingestLot(input: {
    house: string;
    sessionId: string;
    sourceId: string;
    lotNumber: string;
    eventKey: string;
    queryKeyword: string;
    title: string;
    gradingCompany?: GradingCompany | null;
    gradeValue?: string | null;
    certNumber?: string | null;
    currency: string;
    hammerMinor: number | null;
    buyersPremiumStatus: "known" | "none" | "unknown";
    buyersPremiumBps?: number | null;
    buyersPremiumMinor?: number | null;
    taxIncluded?: boolean;
    saleStatus: "sold" | "unsold" | "withdrawn";
    soldAt?: string | null;
    comparable?: boolean;
    retentionUntil: string;
    primaryImageBytes?: Buffer | null;
    primaryImageMime?: "image/webp" | "image/png" | "image/jpeg" | null;
  }) {
    if (!isEnabledHouse(input.house)) fail("invalid_parameter", 400, "Unsupported auction house.");
    if (!uuidRe.test(input.sessionId) || !uuidRe.test(input.sourceId)) {
      fail("invalid_parameter", 400, "Invalid UUID identifier.");
    }

    let premiumBps: number | null = input.buyersPremiumBps ?? null;
    let premiumMinor: number | null = input.buyersPremiumMinor ?? null;
    let totalMinor: number | null = null;
    if (input.buyersPremiumStatus === "unknown") {
      premiumBps = null;
      premiumMinor = null;
      totalMinor = null;
    } else if (input.buyersPremiumStatus === "none") {
      premiumBps = 0;
      premiumMinor = 0;
      totalMinor = input.hammerMinor;
    } else {
      if (premiumMinor === null || !Number.isSafeInteger(premiumMinor) || premiumMinor < 0) {
        fail(
          "invalid_parameter",
          422,
          "Known buyers_premium_status requires non-negative buyers_premium_minor.",
        );
      }
      totalMinor = input.hammerMinor !== null ? input.hammerMinor + premiumMinor : null;
    }

    const imageBytes = input.primaryImageBytes ?? null;
    const imageMime = imageBytes ? (input.primaryImageMime ?? "image/png") : null;
    const imageSha = imageBytes ? createHash("sha256").update(imageBytes).digest("hex") : null;
    const mediaStatus = imageBytes ? "authorized" : "missing";

    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const sourceRow = (
        await c.query<{ permission_epoch: string }>(
          `SELECT s.permission_epoch
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.id=$1 AND s.marketplace=$2 AND s.status='active'
             AND ${sqlSourceEligibilityClause(this.query.dataMode)}
             AND (x.effective_at IS NULL OR x.effective_at<=$3)
             AND (x.expires_at IS NULL OR x.expires_at>$3)`,
          [input.sourceId, input.house, now],
        )
      ).rows[0];
      if (!sourceRow) fail("forbidden", 403, `Source ${input.sourceId} is unavailable for ${input.house}.`);

      const row = (
        await c.query<{ id: string }>(
          `INSERT INTO auction_lot_records(
             auction_house,session_id,source_id,permission_epoch,lot_number,event_key,query_keyword,title,
             grading_company,grade_value,cert_number,currency,hammer_minor,
             buyers_premium_status,buyers_premium_bps,buyers_premium_minor,total_with_premium_minor,
             tax_included,sale_status,sold_at,comparable,
             primary_image_sha256,primary_image_mime,primary_image_bytes,media_rights_status,retention_until
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
           ON CONFLICT (auction_house,source_id,event_key) DO UPDATE SET
             title = EXCLUDED.title,
             hammer_minor = EXCLUDED.hammer_minor,
             buyers_premium_status = EXCLUDED.buyers_premium_status,
             buyers_premium_bps = EXCLUDED.buyers_premium_bps,
             buyers_premium_minor = EXCLUDED.buyers_premium_minor,
             total_with_premium_minor = EXCLUDED.total_with_premium_minor,
             sale_status = EXCLUDED.sale_status,
             comparable = EXCLUDED.comparable,
             retention_until = GREATEST(auction_lot_records.retention_until, EXCLUDED.retention_until)
           RETURNING id`,
          [
            input.house,
            input.sessionId,
            input.sourceId,
            Number(sourceRow.permission_epoch),
            input.lotNumber,
            input.eventKey,
            input.queryKeyword.trim(),
            input.title.trim(),
            input.gradingCompany ?? null,
            input.gradeValue ?? null,
            input.certNumber ?? null,
            input.currency,
            input.hammerMinor,
            input.buyersPremiumStatus,
            premiumBps,
            premiumMinor,
            totalMinor,
            input.taxIncluded ?? false,
            input.saleStatus,
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
      if (!row) fail("internal_error", 500, "Failed to persist auction lot record.");
      return { id: row.id };
    });
  }

  async queryAuctionLots(
    identity: Identity,
    input: {
      house: string;
      q: string;
      price_basis?: string;
      grading_company?: string;
      grade_value?: string;
      limit?: number;
    },
  ) {
    if (!input.house) fail("invalid_parameter", 400, "auction house is required.");
    if (!isEnabledHouse(input.house)) {
      if (["fanatics_collect", "pristine_auction", "myslabs"].includes(input.house)) {
        fail(
          "auction_house_not_enabled",
          422,
          `${input.house} is a deferred candidate outside the first auction package (goldin_us).`,
        );
      }
      fail("invalid_parameter", 400, "Unsupported auction house identifier.");
    }
    const q = input.q.trim();
    if (!q || q.length > 120) fail("invalid_parameter", 400, "q must be 1..120 characters.");

    const priceBasis = input.price_basis ?? "total_with_premium";
    if (!(AUCTION_PRICE_BASES as readonly string[]).includes(priceBasis)) {
      fail(
        "invalid_parameter",
        400,
        "price_basis must be strictly 'total_with_premium' or 'hammer_only'; mixed basis statistics are prohibited.",
      );
    }
    const typedBasis = priceBasis as AuctionPriceBasis;

    const gradingCompany = input.grading_company?.trim().toUpperCase() || undefined;
    const gradeValue = input.grade_value?.trim() || undefined;
    if (gradingCompany && !(GRADING_COMPANIES as readonly string[]).includes(gradingCompany)) {
      fail("invalid_parameter", 400, "Unsupported grading_company filter.");
    }
    if (gradeValue && !/^[0-9]+(\.[0-9]+)?$/.test(gradeValue)) {
      fail("invalid_parameter", 400, "Invalid numeric grade_value.");
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      fail("invalid_parameter", 400, "limit must be between 1 and 200.");
    }

    const canonicalHash = auctionCanonicalHash({
      house: input.house,
      q,
      priceBasis: typedBasis,
      gradingCompany: gradingCompany as GradingCompany | undefined,
      gradeValue,
      limit,
    });

    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const catalog = (
        await c.query<AuctionCatalogRow>(
          `SELECT house_id,display_name,selection_status,default_currency,premium_disclosure,
                  source_gate_passed,media_gate_passed,quality_gate_passed,status
           FROM auction_house_catalog WHERE house_id=$1`,
          [input.house],
        )
      ).rows[0];
      if (!catalog) fail("not_found", 404, "Auction house catalog entry not found.");

      const activeSources = (
        await c.query<{ id: string; permission_epoch: string; permitted_fields: unknown }>(
          `SELECT s.id,s.permission_epoch,x.permitted_fields
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.marketplace=$1
             AND ${sqlSourceEligibilityClause(this.query.dataMode)}
             AND s.status='active'
             AND (x.effective_at IS NULL OR x.effective_at<=$2)
             AND (x.expires_at IS NULL OR x.expires_at>$2)`,
          [input.house, now],
        )
      ).rows;
      if (!activeSources.length) {
        fail("forbidden", 403, `Source rights are unavailable or revoked for ${input.house}.`);
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

      const rows = (
        await c.query<AuctionLotRow>(
          `SELECT r.id,r.auction_house,s.session_code,s.session_name,r.source_id,r.permission_epoch,
                  r.lot_number,r.event_key,r.title,r.grading_company,r.grade_value,r.cert_number,
                  r.currency,r.hammer_minor,r.buyers_premium_status,r.buyers_premium_bps,
                  r.buyers_premium_minor,r.total_with_premium_minor,r.tax_included,r.sale_status,
                  r.sold_at,r.comparable,r.primary_image_sha256,r.media_rights_status
           FROM auction_lot_records r
           JOIN auction_sessions s ON s.id=r.session_id
           WHERE r.auction_house=$1 AND lower(r.query_keyword)=lower($2) AND r.retention_until>$3
           ORDER BY r.sold_at DESC NULLS LAST, r.id ASC
           LIMIT 400`,
          [input.house, q, now],
        )
      ).rows.filter((r) => sourceMap.get(r.source_id)?.epoch === BigInt(r.permission_epoch));

      const mapped: AuctionLotInput[] = rows.map((r) => {
        const src = sourceMap.get(r.source_id);
        const mediaAuthorized =
          Boolean(src?.imagePermitted) &&
          r.media_rights_status === "authorized" &&
          Boolean(r.primary_image_sha256);
        const mediaStatus: "available" | "missing" | "revoked" =
          r.media_rights_status === "revoked" ? "revoked" : mediaAuthorized ? "available" : "missing";
        return {
          id: r.id,
          auctionHouse: r.auction_house,
          sessionCode: r.session_code,
          sessionName: r.session_name,
          lotNumber: r.lot_number,
          eventKey: r.event_key,
          title: r.title,
          gradingCompany: r.grading_company,
          gradeValue: r.grade_value,
          certNumber: r.cert_number,
          currency: r.currency,
          hammerMinor: r.hammer_minor === null ? null : Number(r.hammer_minor),
          buyersPremiumStatus: r.buyers_premium_status,
          buyersPremiumBps: r.buyers_premium_bps,
          buyersPremiumMinor: r.buyers_premium_minor === null ? null : Number(r.buyers_premium_minor),
          totalWithPremiumMinor:
            r.total_with_premium_minor === null ? null : Number(r.total_with_premium_minor),
          taxIncluded: r.tax_included,
          saleStatus: r.sale_status,
          soldAt: r.sold_at ? r.sold_at.toISOString() : null,
          comparable: r.comparable,
          primaryImagePath: mediaAuthorized ? `/v1/auctions/${r.auction_house}/lots/${r.id}/image` : null,
          mediaStatus,
        };
      });

      const evaluated = evaluateAuctionLots(mapped, {
        priceBasis: typedBasis,
        expectedCurrency: catalog.default_currency,
        gradingCompany: gradingCompany as GradingCompany | undefined,
        gradeValue,
        limit,
      });

      return {
        auction_house: catalog.house_id,
        display_name: catalog.display_name,
        selection_status: catalog.selection_status,
        currency: catalog.default_currency,
        canonical_query_hash: canonicalHash,
        credits_charged: 0 as const,
        data_mode: "offline_fixture",
        basis_policy: "strict_single_basis_no_mixing",
        premium_disclosure: catalog.premium_disclosure,
        data_as_of: now.toISOString(),
        ...evaluated,
      };
    });
  }

  async getLotImage(identity: Identity, house: string, lotId: string) {
    if (!isEnabledHouse(house)) fail("invalid_parameter", 400, "Unsupported auction house.");
    if (!uuidRe.test(lotId)) fail("invalid_parameter", 400, "Invalid lot_id.");
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
           FROM auction_lot_records r
           JOIN sources s ON s.id=r.source_id
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE r.id=$1 AND r.auction_house=$2 AND s.marketplace=$2
             AND ${sqlSourceKindClause(this.query.dataMode)}`,
          [lotId, house],
        )
      ).rows[0];
      if (!row) fail("not_found", 404, "Lot image not found.");
      if (
        row.source_status !== "active" ||
        !(this.query.dataMode === "approved_network"
          ? row.clearance_status === "active"
          : ["draft", "reviewed", "active"].includes(row.clearance_status)) ||
        BigInt(row.source_epoch) !== BigInt(row.record_epoch) ||
        row.media_rights_status !== "authorized" ||
        !hasPrimaryImagePermission(row.permitted_fields)
      ) {
        fail("forbidden", 403, "Auction lot image rights revoked or unavailable.");
      }
      if (row.retention_until <= now || !row.primary_image_bytes || !row.primary_image_mime) {
        fail("not_found", 404, "Lot image expired or missing.");
      }
      return {
        bytes: row.primary_image_bytes,
        mime: row.primary_image_mime,
        sha256: row.primary_image_sha256 ?? "",
      };
    });
  }
}
