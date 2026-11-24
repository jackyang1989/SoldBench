import type { Identity } from "@soldbench/auth";
import {
  CARD_EDITIONS,
  type CardEdition,
  type CardSaleInput,
  cardValuationCanonicalHash,
  evaluateCardComparables,
  GRADING_COMPANIES,
  type GradingCompany,
  RAW_CARD_CONDITIONS,
  type RawCardCondition,
  TCG_GAMES,
  type TcgGame,
} from "@soldbench/core";
import { transaction } from "@soldbench/db";
import { AppError, sqlSourceEligibilityClause } from "@soldbench/shared";
import type { QueryService } from "./index.ts";

type CardProductRow = {
  product_id: string;
  tcg_game: TcgGame;
  set_code: string;
  set_name: string;
  card_number: string;
  card_name: string;
  edition: CardEdition;
  language: string;
  finish: string;
  release_year: number | null;
  source_gate_passed: boolean;
  status: "preview_offline" | "gated" | "active";
};

type CardSaleRow = {
  id: string;
  product_id: string;
  source_id: string;
  permission_epoch: string | number;
  event_key: string;
  grading_state: "raw" | "graded";
  grading_company: GradingCompany | null;
  grade_value: string | null;
  raw_condition: RawCardCondition | null;
  edition: CardEdition;
  currency: string;
  item_minor: string | number | null;
  shipping_minor: string | number | null;
  shipping_status: "observed" | "verified_free_shipping" | "unknown";
  sale_price_status: "verified_actual" | "displayed_only" | "unknown";
  sold_at: Date | null;
  comparable: boolean;
};

type GradingPopRow = {
  id: string;
  product_id: string;
  source_id: string;
  permission_epoch: string | number;
  grading_company: GradingCompany;
  grade_value: string;
  pop_count: number;
  pop_higher_count: number;
  as_of: Date;
};

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const productIdRe = /^[a-z0-9][a-z0-9-]{2,79}$/;

function fail(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

/**
 * Coordinates structured TCG/graded-card valuation (`TASK-053`, `AT-070`):
 * product ID authority (never free-text title substitution), raw-vs-graded isolation,
 * separate grading census metadata (`is_sold_transaction=false`), and per-source revocation.
 */
export class CardsVerticalService {
  constructor(readonly query: QueryService) {}

  async listCardProducts(filter?: {
    tcg_game?: string;
    set_code?: string;
    card_number?: string;
    edition?: string;
    q?: string;
  }) {
    const tcgGame = filter?.tcg_game?.trim() || undefined;
    if (tcgGame && !(TCG_GAMES as readonly string[]).includes(tcgGame)) {
      fail("invalid_parameter", 400, "Unsupported tcg_game filter.");
    }
    const edition = filter?.edition?.trim() || undefined;
    if (edition && !(CARD_EDITIONS as readonly string[]).includes(edition)) {
      fail("invalid_parameter", 400, "Unsupported card edition filter.");
    }
    const setCode = filter?.set_code?.trim() || undefined;
    const cardNumber = filter?.card_number?.trim() || undefined;
    const q = filter?.q?.trim().toLowerCase() || undefined;

    const rows = (
      await this.query.db.query<CardProductRow>(
        `SELECT product_id,tcg_game,set_code,set_name,card_number,card_name,
                edition,language,finish,release_year,source_gate_passed,status
         FROM card_products
         ORDER BY product_id ASC`,
      )
    ).rows;

    return rows
      .filter((r) => {
        if (tcgGame && r.tcg_game !== tcgGame) return false;
        if (edition && r.edition !== edition) return false;
        if (setCode && r.set_code.toLowerCase() !== setCode.toLowerCase()) return false;
        if (cardNumber && r.card_number.toLowerCase() !== cardNumber.toLowerCase()) return false;
        if (
          q &&
          !`${r.product_id} ${r.set_code} ${r.set_name} ${r.card_number} ${r.card_name} ${r.edition}`
            .toLowerCase()
            .includes(q)
        ) {
          return false;
        }
        return true;
      })
      .map((r) => ({
        product_id: r.product_id,
        tcg_game: r.tcg_game,
        set_code: r.set_code,
        set_name: r.set_name,
        card_number: r.card_number,
        card_name: r.card_name,
        edition: r.edition,
        language: r.language,
        finish: r.finish,
        release_year: r.release_year,
        source_gate_passed: r.source_gate_passed,
        status: r.status,
      }));
  }

  async ingestCardSale(input: {
    productId: string;
    sourceId: string;
    eventKey: string;
    gradingState: "raw" | "graded";
    gradingCompany?: GradingCompany | null;
    gradeValue?: string | null;
    rawCondition?: RawCardCondition | null;
    edition: CardEdition;
    currency: string;
    itemMinor: number | null;
    shippingMinor: number | null;
    shippingStatus: "observed" | "verified_free_shipping" | "unknown";
    salePriceStatus: "verified_actual" | "displayed_only" | "unknown";
    soldAt?: string | null;
    comparable?: boolean;
    retentionUntil: string;
  }) {
    if (!productIdRe.test(input.productId)) fail("invalid_parameter", 400, "Invalid product_id.");
    if (!uuidRe.test(input.sourceId)) fail("invalid_parameter", 400, "Invalid sourceId.");
    if (input.currency !== "USD") fail("invalid_parameter", 422, "USD only in offline cards vertical.");

    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const sourceRow = (
        await c.query<{ permission_epoch: string }>(
          `SELECT s.permission_epoch
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.id=$1 AND s.marketplace='tcgplayer_us' AND s.status='active'
             AND ${sqlSourceEligibilityClause(this.query.dataMode)}
             AND (x.effective_at IS NULL OR x.effective_at<=$2)
             AND (x.expires_at IS NULL OR x.expires_at>$2)`,
          [input.sourceId, now],
        )
      ).rows[0];
      if (!sourceRow) fail("forbidden", 403, "tcgplayer_us source is unavailable or inactive.");

      const row = (
        await c.query<{ id: string }>(
          `INSERT INTO card_sale_records(
             product_id,source_id,permission_epoch,event_key,grading_state,
             grading_company,grade_value,raw_condition,edition,currency,
             item_minor,shipping_minor,shipping_status,sale_price_status,sold_at,comparable,retention_until
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (product_id,source_id,event_key) DO UPDATE SET
             item_minor = EXCLUDED.item_minor,
             shipping_minor = EXCLUDED.shipping_minor,
             shipping_status = EXCLUDED.shipping_status,
             sale_price_status = EXCLUDED.sale_price_status,
             comparable = EXCLUDED.comparable,
             retention_until = GREATEST(card_sale_records.retention_until, EXCLUDED.retention_until)
           RETURNING id`,
          [
            input.productId,
            input.sourceId,
            Number(sourceRow.permission_epoch),
            input.eventKey,
            input.gradingState,
            input.gradingState === "graded" ? (input.gradingCompany ?? null) : null,
            input.gradingState === "graded" ? (input.gradeValue ?? null) : null,
            input.gradingState === "raw" ? (input.rawCondition ?? null) : null,
            input.edition,
            input.currency,
            input.itemMinor,
            input.shippingMinor,
            input.shippingStatus,
            input.salePriceStatus,
            input.soldAt ?? null,
            input.comparable ?? true,
            input.retentionUntil,
          ],
        )
      ).rows[0];
      if (!row) fail("internal_error", 500, "Failed to persist card sale record.");
      return { id: row.id };
    });
  }

  async ingestGradingPopulation(input: {
    productId: string;
    sourceId: string;
    gradingCompany: GradingCompany;
    gradeValue: string;
    popCount: number;
    popHigherCount: number;
    asOf: string;
    retentionUntil: string;
  }) {
    if (!productIdRe.test(input.productId)) fail("invalid_parameter", 400, "Invalid product_id.");
    if (!uuidRe.test(input.sourceId)) fail("invalid_parameter", 400, "Invalid sourceId.");

    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const sourceRow = (
        await c.query<{ permission_epoch: string }>(
          `SELECT s.permission_epoch
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.id=$1 AND s.marketplace='psa_registry' AND s.status='active'
             AND ${sqlSourceEligibilityClause(this.query.dataMode)}
             AND (x.effective_at IS NULL OR x.effective_at<=$2)
             AND (x.expires_at IS NULL OR x.expires_at>$2)`,
          [input.sourceId, now],
        )
      ).rows[0];
      if (!sourceRow) fail("forbidden", 403, "psa_registry source is unavailable or inactive.");

      const row = (
        await c.query<{ id: string }>(
          `INSERT INTO card_grading_populations(
             product_id,source_id,permission_epoch,grading_company,grade_value,pop_count,pop_higher_count,as_of,retention_until
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (product_id,source_id,grading_company,grade_value) DO UPDATE SET
             permission_epoch = EXCLUDED.permission_epoch,
             pop_count = EXCLUDED.pop_count,
             pop_higher_count = EXCLUDED.pop_higher_count,
             as_of = EXCLUDED.as_of,
             retention_until = GREATEST(card_grading_populations.retention_until, EXCLUDED.retention_until)
           RETURNING id`,
          [
            input.productId,
            input.sourceId,
            Number(sourceRow.permission_epoch),
            input.gradingCompany,
            input.gradeValue,
            input.popCount,
            input.popHigherCount,
            input.asOf,
            input.retentionUntil,
          ],
        )
      ).rows[0];
      if (!row) fail("internal_error", 500, "Failed to persist grading population record.");
      return { id: row.id };
    });
  }

  async queryCardValuation(
    identity: Identity,
    input: {
      product_id: string;
      grading_state: string;
      grading_company?: string;
      grade_value?: string;
      raw_condition?: string;
      edition?: string;
      price_basis?: string;
      limit?: number;
    },
  ) {
    if (!productIdRe.test(input.product_id)) {
      fail(
        "invalid_parameter",
        400,
        "Structured product_id is required; listing titles cannot identify cards.",
      );
    }
    if (input.grading_state !== "raw" && input.grading_state !== "graded") {
      fail("invalid_parameter", 400, "grading_state must be 'raw' or 'graded'.");
    }
    const gradingState = input.grading_state;

    const gradingCompany = input.grading_company?.trim().toUpperCase() || undefined;
    const gradeValue = input.grade_value?.trim() || undefined;
    const rawCondition = input.raw_condition?.trim().toLowerCase() || undefined;
    const editionParam = input.edition?.trim().toLowerCase() || undefined;

    if (gradingState === "raw" && (gradingCompany || gradeValue)) {
      fail("invalid_parameter", 400, "Cannot mix grading_company or grade_value with grading_state='raw'.");
    }
    if (gradingState === "graded" && rawCondition) {
      fail("invalid_parameter", 400, "Cannot apply raw_condition filter with grading_state='graded'.");
    }
    if (gradingCompany && !(GRADING_COMPANIES as readonly string[]).includes(gradingCompany)) {
      fail("invalid_parameter", 400, "Unsupported grading_company.");
    }
    if (gradeValue && !/^[0-9]+(\.[0-9]+)?$/.test(gradeValue)) {
      fail("invalid_parameter", 400, "Invalid numeric grade_value.");
    }
    if (rawCondition && !(RAW_CARD_CONDITIONS as readonly string[]).includes(rawCondition)) {
      fail("invalid_parameter", 400, "Unsupported raw_condition.");
    }
    if (editionParam && !(CARD_EDITIONS as readonly string[]).includes(editionParam)) {
      fail("invalid_parameter", 400, "Unsupported card edition.");
    }
    const priceBasis = input.price_basis ?? "item";
    if (priceBasis !== "item" && priceBasis !== "item_plus_observed_shipping") {
      fail("invalid_parameter", 400, "price_basis must be item or item_plus_observed_shipping.");
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      fail("invalid_parameter", 400, "limit must be between 1 and 200.");
    }

    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const product = (
        await c.query<CardProductRow>(
          `SELECT product_id,tcg_game,set_code,set_name,card_number,card_name,
                  edition,language,finish,release_year,source_gate_passed,status
           FROM card_products WHERE product_id=$1`,
          [input.product_id],
        )
      ).rows[0];
      if (!product) {
        fail("not_found", 404, "Card product_id not found in structured catalog.");
      }

      const expectedEdition = (editionParam ?? product.edition) as CardEdition;
      if (editionParam && editionParam !== product.edition) {
        fail(
          "edition_mismatch",
          422,
          `Requested edition '${editionParam}' conflicts with canonical product edition '${product.edition}'.`,
        );
      }

      const activeCardSources = (
        await c.query<{ id: string; permission_epoch: string }>(
          `SELECT s.id,s.permission_epoch
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.marketplace='tcgplayer_us'
             AND ${sqlSourceEligibilityClause(this.query.dataMode)}
             AND s.status='active'
             AND (x.effective_at IS NULL OR x.effective_at<=$1)
             AND (x.expires_at IS NULL OR x.expires_at>$1)`,
          [now],
        )
      ).rows;
      if (!activeCardSources.length) {
        fail("forbidden", 403, "tcgplayer_us card sale source rights are unavailable or revoked.");
      }
      const cardSourceMap = new Map(activeCardSources.map((s) => [s.id, BigInt(s.permission_epoch)]));

      const saleRows = (
        await c.query<CardSaleRow>(
          `SELECT id,product_id,source_id,permission_epoch,event_key,grading_state,
                  grading_company,grade_value,raw_condition,edition,currency,
                  item_minor,shipping_minor,shipping_status,sale_price_status,sold_at,comparable
           FROM card_sale_records
           WHERE product_id=$1 AND retention_until>$2
           ORDER BY sold_at DESC NULLS LAST, id ASC
           LIMIT 400`,
          [product.product_id, now],
        )
      ).rows.filter((r) => cardSourceMap.get(r.source_id) === BigInt(r.permission_epoch));

      const mappedSales: CardSaleInput[] = saleRows.map((r) => ({
        id: r.id,
        productId: r.product_id,
        eventKey: r.event_key,
        gradingState: r.grading_state,
        gradingCompany: r.grading_company,
        gradeValue: r.grade_value,
        rawCondition: r.raw_condition,
        edition: r.edition,
        currency: r.currency,
        itemMinor: r.item_minor === null ? null : Number(r.item_minor),
        shippingMinor: r.shipping_minor === null ? null : Number(r.shipping_minor),
        shippingStatus: r.shipping_status,
        salePriceStatus: r.sale_price_status,
        soldAt: r.sold_at ? r.sold_at.toISOString() : null,
        comparable: r.comparable,
      }));

      const evaluated = evaluateCardComparables(mappedSales, {
        productId: product.product_id,
        expectedEdition,
        gradingState,
        gradingCompany: gradingCompany as GradingCompany | undefined,
        gradeValue,
        rawCondition: rawCondition as RawCardCondition | undefined,
        priceBasis,
        expectedCurrency: "USD",
        limit,
      });

      // Independently inspect grading registry census (never treated as sold transactions)
      const activePopSources = (
        await c.query<{ id: string; permission_epoch: string }>(
          `SELECT s.id,s.permission_epoch
           FROM sources s
           JOIN source_clearances x ON x.id=s.source_clearance_id
           WHERE s.marketplace='psa_registry'
             AND ${sqlSourceEligibilityClause(this.query.dataMode)}
             AND s.status='active'
             AND (x.effective_at IS NULL OR x.effective_at<=$1)
             AND (x.expires_at IS NULL OR x.expires_at>$1)`,
          [now],
        )
      ).rows;
      const popSourceMap = new Map(activePopSources.map((s) => [s.id, BigInt(s.permission_epoch)]));

      const popRows = activePopSources.length
        ? (
            await c.query<GradingPopRow>(
              `SELECT id,product_id,source_id,permission_epoch,grading_company,grade_value,pop_count,pop_higher_count,as_of
               FROM card_grading_populations
               WHERE product_id=$1 AND retention_until>$2
               ORDER BY grading_company ASC, grade_value DESC`,
              [product.product_id, now],
            )
          ).rows.filter((p) => {
            if (popSourceMap.get(p.source_id) !== BigInt(p.permission_epoch)) return false;
            if (gradingCompany && p.grading_company !== gradingCompany) return false;
            if (gradeValue && p.grade_value !== gradeValue) return false;
            return true;
          })
        : [];

      const canonicalHash = cardValuationCanonicalHash({
        productId: product.product_id,
        gradingState,
        edition: expectedEdition,
        gradingCompany: gradingCompany as GradingCompany | undefined,
        gradeValue,
        rawCondition: rawCondition as RawCardCondition | undefined,
        priceBasis,
      });

      return {
        product: {
          product_id: product.product_id,
          tcg_game: product.tcg_game,
          set_code: product.set_code,
          set_name: product.set_name,
          card_number: product.card_number,
          card_name: product.card_name,
          edition: product.edition,
          language: product.language,
          finish: product.finish,
          release_year: product.release_year,
          source_gate_passed: product.source_gate_passed,
          status: product.status,
        },
        identity_authority: "structured_card_catalog" as const,
        free_text_title_substitution_allowed: false as const,
        canonical_query_hash: canonicalHash,
        credits_charged: 0 as const,
        data_mode: "offline_fixture",
        grading_state: gradingState,
        filters: {
          grading_company: gradingCompany ?? null,
          grade_value: gradeValue ?? null,
          raw_condition: rawCondition ?? null,
          edition: expectedEdition,
          price_basis: priceBasis,
        },
        stats: evaluated.stats,
        comps: evaluated.comps,
        excluded_counts: evaluated.excluded_counts,
        grading_population: {
          is_sold_transaction: false as const,
          excluded_from_sold_stats: true as const,
          registry_status: activePopSources.length
            ? ("available" as const)
            : ("unavailable_or_revoked" as const),
          entries: popRows.map((p) => ({
            grading_company: p.grading_company,
            grade_value: p.grade_value,
            pop_count: p.pop_count,
            pop_higher_count: p.pop_higher_count,
            as_of: p.as_of.toISOString(),
          })),
        },
        data_as_of: now.toISOString(),
      };
    });
  }
}
