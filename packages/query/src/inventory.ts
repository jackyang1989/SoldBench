import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "@soldbench/auth";
import { canonicalJson, normalizeQuery, queryHash, queryParameters } from "@soldbench/core";
import { transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import { BatchQueryService, MAX_BATCH_ITEMS } from "./batch.ts";
import type { QueryService } from "./index.ts";
import { csv } from "./research.ts";

export const MAX_INVENTORY_ITEMS = MAX_BATCH_ITEMS;
export const VALUATION_DISCLAIMER = "observed_comparable_estimate_not_guaranteed_sale_price" as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;

const INVENTORY_COLUMNS = new Set([
  "sku",
  "title",
  "quantity",
  "currency",
  "cost_basis_cents",
  "q",
  "category",
  "brand",
  "model",
  "condition",
  "window_days",
  "price_basis",
]);

export type InventoryMappingStatus =
  | "mapped"
  | "unmapped_missing_model"
  | "currency_unsupported"
  | "invalid_parameters";

export type InventoryValuationItemStatus =
  | "valued"
  | "insufficient_samples"
  | "unclaimed"
  | "pending"
  | "rights_revoked"
  | "cancelled"
  | "failed"
  | "expired"
  | "unmapped_missing_model"
  | "currency_unsupported"
  | "invalid_parameters";

export type InventoryValuationStatus =
  | "draft_mapping"
  | "queued"
  | "running"
  | "ready_to_claim"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

type ValuationRow = {
  id: string;
  user_id: string;
  name: string;
  status: InventoryValuationStatus;
  batch_id: string | null;
  billing_consent_accepted: boolean;
  estimated_max_credits: number;
  total_rows: number;
  total_units: number;
  revaluation_of_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
};

type ValuationItemRow = {
  valuation_id: string;
  user_id: string;
  row_index: number;
  sku: string;
  title: string;
  quantity: number;
  declared_currency: string;
  cost_basis_cents: string | number | null;
  mapped_q: string | null;
  mapped_category: string | null;
  mapped_brand: string | null;
  mapped_model: string | null;
  mapped_condition: string | null;
  window_days: 30 | 90 | 180 | 365;
  price_basis: "item" | "item_plus_observed_shipping";
  mapping_status: InventoryMappingStatus;
  mapping_note: string | null;
  canonical_query_hash: string | null;
  batch_item_index: number | null;
  query_id: string | null;
};

type PreviewItem = {
  row_index: number;
  sku: string;
  title: string;
  quantity: number;
  declared_currency: string;
  cost_basis_cents: number | null;
  mapped_q: string | null;
  mapped_category: string | null;
  mapped_brand: string | null;
  mapped_model: string | null;
  mapped_condition: string | null;
  window_days: 30 | 90 | 180 | 365;
  price_basis: "item" | "item_plus_observed_shipping";
  mapping_status: InventoryMappingStatus;
  mapping_note: string | null;
  canonical_query_hash: string | null;
  deduplicated_in_valuation: boolean;
  batch_payload: Record<string, unknown> | null;
};

function fail(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

function requireIdempotencyKey(key: string | undefined): string {
  if (!key || !IDEMPOTENCY_KEY.test(key))
    fail("invalid_parameter", 400, "A valid Idempotency-Key header is required.");
  return key;
}

function parseCsvRows(raw: string): string[][] {
  const input = raw.startsWith("\ufeff") ? raw.slice(1) : raw;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell.length > 0) fail("invalid_parameter", 400, "Malformed quoted CSV field.");
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim().length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (inQuotes) fail("invalid_parameter", 400, "Unterminated CSV quote.");
  row.push(cell);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);
  return rows;
}

/**
 * Parse RFC-4180 inventory valuation CSV (`<=20` rows, explicit allowlisted headers).
 */
export function parseInventoryCsv(raw: string): Record<string, unknown>[] {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw, "utf8") > 65536)
    fail("invalid_parameter", 400, "Inventory CSV payload is empty or exceeds 64 KiB.");
  const rows = parseCsvRows(raw);
  if (rows.length < 2) fail("invalid_parameter", 400, "Inventory CSV must include a header and >=1 row.");
  if (rows.length - 1 > MAX_INVENTORY_ITEMS)
    fail("invalid_parameter", 400, `Inventory valuation is limited to ${MAX_INVENTORY_ITEMS} rows.`);

  const headers = (rows[0] ?? []).map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of headers) {
    if (!h || !INVENTORY_COLUMNS.has(h) || seen.has(h))
      fail("invalid_parameter", 400, `Unsupported or duplicate CSV column: ${h || "(blank)"}`);
    seen.add(h);
  }
  if (!seen.has("sku")) fail("invalid_parameter", 400, "Inventory CSV requires a sku column.");

  const items: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (cells.length !== headers.length)
      fail("invalid_parameter", 400, `CSV row ${r + 1} column count mismatch.`);
    const record: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c] ?? "";
      const rawCell = (cells[c] ?? "").trim();
      if (!rawCell) continue;
      if (header === "quantity" || header === "cost_basis_cents" || header === "window_days") {
        const parsed = /^-?\d+$/.test(rawCell) ? Number(rawCell) : rawCell;
        record[header] = Number.isSafeInteger(parsed) ? parsed : rawCell;
      } else {
        record[header] = rawCell;
      }
    }
    items.push(record);
  }
  return items;
}

function normalizeInventoryInputRow(
  entry: unknown,
  idx: number,
): Omit<PreviewItem, "deduplicated_in_valuation"> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    fail("invalid_parameter", 400, "Each inventory item must be an object.");
  const raw = entry as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!INVENTORY_COLUMNS.has(key)) fail("invalid_parameter", 400, `Unsupported inventory field: ${key}`);
  }

  const sku = typeof raw.sku === "string" ? raw.sku.trim() : "";
  if (!sku || sku.length > 80) fail("invalid_parameter", 400, `Row ${idx + 1} sku must be 1–80 characters.`);

  const rawTitle = typeof raw.title === "string" ? raw.title.trim() : "";
  const rawQ = typeof raw.q === "string" ? raw.q.trim() : "";
  const title = (rawTitle || rawQ || sku).slice(0, 160);

  const rawQty = raw.quantity ?? 1;
  if (typeof rawQty !== "number" || !Number.isSafeInteger(rawQty) || rawQty < 1 || rawQty > 10000)
    fail("invalid_parameter", 400, `Row ${idx + 1} quantity must be an integer 1–10000.`);

  let costBasisCents: number | null = null;
  if (raw.cost_basis_cents !== undefined && raw.cost_basis_cents !== null && raw.cost_basis_cents !== "") {
    if (
      typeof raw.cost_basis_cents !== "number" ||
      !Number.isSafeInteger(raw.cost_basis_cents) ||
      raw.cost_basis_cents < 0
    ) {
      fail("invalid_parameter", 400, `Row ${idx + 1} cost_basis_cents must be a nonnegative integer.`);
    }
    costBasisCents = raw.cost_basis_cents;
  }

  const currency =
    raw.currency === undefined || raw.currency === null || raw.currency === ""
      ? "USD"
      : typeof raw.currency === "string"
        ? raw.currency.trim().toUpperCase()
        : "";
  if (!/^[A-Z]{3}$/.test(currency))
    fail("invalid_parameter", 400, `Row ${idx + 1} currency must be a 3-letter ISO code.`);

  const windowDays = raw.window_days === undefined ? 90 : Number(raw.window_days);
  const priceBasis = raw.price_basis === undefined ? "item_plus_observed_shipping" : String(raw.price_basis);
  const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : null;
  const brand = typeof raw.brand === "string" && raw.brand.trim() ? raw.brand.trim() : null;
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null;
  const condition = typeof raw.condition === "string" && raw.condition.trim() ? raw.condition.trim() : null;

  if (currency !== "USD") {
    return {
      row_index: idx,
      sku,
      title,
      quantity: rawQty,
      declared_currency: currency,
      cost_basis_cents: costBasisCents,
      mapped_q: rawQ ? rawQ.slice(0, 120) : null,
      mapped_category: category,
      mapped_brand: brand,
      mapped_model: model,
      mapped_condition: condition,
      window_days: [30, 90, 180, 365].includes(windowDays) ? (windowDays as 30 | 90 | 180 | 365) : 90,
      price_basis: priceBasis === "item" ? "item" : "item_plus_observed_shipping",
      mapping_status: "currency_unsupported",
      mapping_note: `Non-USD currency (${currency}) is isolated from USD portfolio totals.`,
      canonical_query_hash: null,
      batch_payload: null,
    };
  }

  if (!rawQ) {
    return {
      row_index: idx,
      sku,
      title,
      quantity: rawQty,
      declared_currency: currency,
      cost_basis_cents: costBasisCents,
      mapped_q: null,
      mapped_category: category,
      mapped_brand: brand,
      mapped_model: model,
      mapped_condition: condition,
      window_days: [30, 90, 180, 365].includes(windowDays) ? (windowDays as 30 | 90 | 180 | 365) : 90,
      price_basis: priceBasis === "item" ? "item" : "item_plus_observed_shipping",
      mapping_status: "unmapped_missing_model",
      mapping_note: "Missing mapped product query/model; excluded from valuation and never zero-filled.",
      canonical_query_hash: null,
      batch_payload: null,
    };
  }

  const batchPayload: Record<string, unknown> = {
    q: rawQ,
    marketplace: "ebay_us",
    window_days: windowDays,
    price_basis: priceBasis,
    limit: 50,
    ...(category ? { category } : {}),
    ...(brand ? { brand } : {}),
    ...(model ? { model } : {}),
    ...(condition ? { condition } : {}),
  };

  try {
    const normalized = normalizeQuery(queryParameters(batchPayload));
    return {
      row_index: idx,
      sku,
      title,
      quantity: rawQty,
      declared_currency: currency,
      cost_basis_cents: costBasisCents,
      mapped_q: normalized.q,
      mapped_category: normalized.category ?? null,
      mapped_brand: normalized.brand ?? null,
      mapped_model: normalized.model ?? null,
      mapped_condition: normalized.condition ?? null,
      window_days: normalized.window_days,
      price_basis: normalized.price_basis,
      mapping_status: "mapped",
      mapping_note: null,
      canonical_query_hash: queryHash(normalized),
      batch_payload: batchPayload,
    };
  } catch (error) {
    const reason = error instanceof AppError ? error.message : "Invalid search parameters.";
    return {
      row_index: idx,
      sku,
      title,
      quantity: rawQty,
      declared_currency: currency,
      cost_basis_cents: costBasisCents,
      mapped_q: rawQ.slice(0, 120),
      mapped_category: category,
      mapped_brand: brand,
      mapped_model: model,
      mapped_condition: condition,
      window_days: 90,
      price_basis: "item_plus_observed_shipping",
      mapping_status: "invalid_parameters",
      mapping_note: reason,
      canonical_query_hash: null,
      batch_payload: null,
    };
  }
}

/**
 * Coordinates inventory CSV/JSON import, SKU mapping preview, explicit billing consent,
 * batch comparable execution, and explicit-denominator portfolio valuation (`TASK-051`, `AT-068`).
 */
export class InventoryValuationService {
  readonly batches: BatchQueryService;

  constructor(
    readonly query: QueryService,
    batches?: BatchQueryService,
  ) {
    this.batches = batches ?? new BatchQueryService(query);
  }

  private normalizeAll(input: { items?: unknown[]; csv?: string }) {
    const hasItems = input.items !== undefined;
    const hasCsv = input.csv !== undefined;
    if (hasItems === hasCsv)
      fail("invalid_parameter", 400, "Provide exactly one of items array or csv payload.");
    const rawList = hasCsv ? parseInventoryCsv(input.csv ?? "") : input.items;
    if (!Array.isArray(rawList) || rawList.length < 1 || rawList.length > MAX_INVENTORY_ITEMS)
      fail("invalid_parameter", 400, `Inventory must contain 1 to ${MAX_INVENTORY_ITEMS} rows.`);

    const seenHashes = new Set<string>();
    const normalized: PreviewItem[] = [];
    for (let i = 0; i < rawList.length; i++) {
      const row = normalizeInventoryInputRow(rawList[i], i);
      const dup = Boolean(row.canonical_query_hash && seenHashes.has(row.canonical_query_hash));
      if (row.canonical_query_hash) seenHashes.add(row.canonical_query_hash);
      normalized.push({ ...row, deduplicated_in_valuation: dup });
    }
    return normalized;
  }

  async preview(identity: Identity, input: { items?: unknown[]; csv?: string }) {
    const items = this.normalizeAll(input);
    const mappedPayloads = items
      .filter((i): i is PreviewItem & { batch_payload: Record<string, unknown> } =>
        Boolean(i.mapping_status === "mapped" && i.batch_payload),
      )
      .map((i) => i.batch_payload);

    let estimatedMaxCredits = 0;
    let uniqueQueryCount = 0;
    if (mappedPayloads.length > 0) {
      const batchPreview = await this.batches.preview(identity, { items: mappedPayloads });
      estimatedMaxCredits = batchPreview.max_estimated_credits;
      uniqueQueryCount = batchPreview.unique_executable_queries;
    } else {
      await transaction(this.query.db, (c) => this.query.owner(c, identity));
    }

    const mappedRows = items.filter((i) => i.mapping_status === "mapped");
    return {
      items: items.map(({ batch_payload: _bp, ...rest }) => rest),
      summary: {
        total_rows: items.length,
        total_units: items.reduce((s, r) => s + r.quantity, 0),
        mapped_rows: mappedRows.length,
        unmapped_rows: items.filter((i) => i.mapping_status === "unmapped_missing_model").length,
        currency_unsupported_rows: items.filter((i) => i.mapping_status === "currency_unsupported").length,
        invalid_rows: items.filter((i) => i.mapping_status === "invalid_parameters").length,
        unique_query_count: uniqueQueryCount,
        duplicate_query_rows: mappedRows.filter((i) => i.deduplicated_in_valuation).length,
        estimated_max_credits: estimatedMaxCredits,
        currency: "USD" as const,
        valuation_disclaimer: VALUATION_DISCLAIMER,
      },
    };
  }

  private async insertValuationRecord(
    identity: Identity,
    params: {
      name?: string;
      items: PreviewItem[];
      estimatedMaxCredits: number;
      billingConsent: boolean;
      revaluationOfId: string | null;
      idempotencyKey: string;
      requestHash: string;
      batchId: string | null;
      batchItemsByIndex: Map<number, { query_id: string | null }>;
      mappedIndices: number[];
    },
  ) {
    const valuationId = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const id = randomUUID();
      const totalUnits = params.items.reduce((s, i) => s + i.quantity, 0);
      const valName =
        params.name?.trim() || `Inventory ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
      const initialStatus: InventoryValuationStatus = params.batchId ? "queued" : "partial";

      await c.query(
        `INSERT INTO inventory_valuations(
           id,user_id,name,status,batch_id,billing_consent_accepted,estimated_max_credits,
           total_rows,total_units,revaluation_of_id,idempotency_key,request_hash,version,created_at,updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13)`,
        [
          id,
          identity.userId,
          valName,
          initialStatus,
          params.batchId,
          params.billingConsent,
          params.estimatedMaxCredits,
          params.items.length,
          totalUnits,
          params.revaluationOfId,
          params.idempotencyKey,
          params.requestHash,
          now,
        ],
      );

      let batchCursor = 0;
      for (const item of params.items) {
        let batchIdx: number | null = null;
        let queryId: string | null = null;
        if (item.mapping_status === "mapped" && params.batchId) {
          batchIdx = batchCursor++;
          queryId = params.batchItemsByIndex.get(batchIdx)?.query_id ?? null;
        }
        await c.query(
          `INSERT INTO inventory_valuation_items(
             valuation_id,user_id,row_index,sku,title,quantity,declared_currency,cost_basis_cents,
             mapped_q,mapped_category,mapped_brand,mapped_model,mapped_condition,window_days,price_basis,
             mapping_status,mapping_note,canonical_query_hash,batch_item_index,query_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            id,
            identity.userId,
            item.row_index,
            item.sku,
            item.title,
            item.quantity,
            item.declared_currency,
            item.cost_basis_cents,
            item.mapped_q,
            item.mapped_category,
            item.mapped_brand,
            item.mapped_model,
            item.mapped_condition,
            item.window_days,
            item.price_basis,
            item.mapping_status,
            item.mapping_note,
            item.canonical_query_hash,
            batchIdx,
            queryId,
          ],
        );
      }
      return id;
    });
    return this.getValuation(identity, valuationId);
  }

  async createValuation(
    identity: Identity,
    input: {
      name?: string;
      items?: unknown[];
      csv?: string;
      billing_consent_accepted?: boolean;
      revaluation_of_id?: string | null;
    },
    idempotencyKey: string | undefined,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const trimmedName = input.name === undefined ? undefined : String(input.name).trim();
    if (input.name !== undefined && (!trimmedName || trimmedName.length > 120))
      fail("invalid_parameter", 400, "Valuation name must contain 1–120 characters.");

    const preview = await this.preview(identity, input);
    const items = this.normalizeAll(input);
    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          name: trimmedName ?? null,
          revaluation_of_id: input.revaluation_of_id ?? null,
          billing_consent_accepted: Boolean(input.billing_consent_accepted),
          items: items.map(({ batch_payload: _bp, ...rest }) => rest),
        }),
      )
      .digest("hex");

    const existing = await transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      const found = (
        await c.query<{ id: string; request_hash: string | null }>(
          "SELECT id,request_hash FROM inventory_valuations WHERE user_id=$1 AND idempotency_key=$2",
          [identity.userId, key],
        )
      ).rows[0];
      if (!found) return null;
      if (found.request_hash !== requestHash)
        fail("idempotency_conflict", 409, "Idempotency-Key was reused with a different valuation payload.");
      return found.id;
    });
    if (existing) {
      return { valuation: await this.getValuation(identity, existing), replayed: true };
    }

    const mappedPayloads = items
      .filter((i): i is PreviewItem & { batch_payload: Record<string, unknown> } =>
        Boolean(i.mapping_status === "mapped" && i.batch_payload),
      )
      .map((i) => i.batch_payload);

    if (mappedPayloads.length > 0 && input.billing_consent_accepted !== true) {
      fail(
        "billing_consent_required",
        400,
        "Explicit billing_consent_accepted=true is required before submitting inventory valuation queries.",
      );
    }

    let batchId: string | null = null;
    const batchItemsByIndex = new Map<number, { query_id: string | null }>();
    if (mappedPayloads.length > 0) {
      const derivedBatchKey = createHash("sha256").update(`inv-create:${key}`).digest("hex").slice(0, 48);
      const batchResult = await this.batches.create(
        identity,
        {
          name: trimmedName ? `${trimmedName.slice(0, 100)} (batch)` : "Inventory valuation batch",
          items: mappedPayloads,
        },
        derivedBatchKey,
      );
      batchId = batchResult.batch.id;
      for (const bi of batchResult.batch.items) {
        batchItemsByIndex.set(bi.item_index, { query_id: bi.query_id });
      }
    }

    const valuation = await this.insertValuationRecord(identity, {
      name: trimmedName,
      items,
      estimatedMaxCredits: preview.summary.estimated_max_credits,
      billingConsent: Boolean(input.billing_consent_accepted),
      revaluationOfId: input.revaluation_of_id ?? null,
      idempotencyKey: key,
      requestHash,
      batchId,
      batchItemsByIndex,
      mappedIndices: items.filter((i) => i.mapping_status === "mapped").map((i) => i.row_index),
    });
    return { valuation, replayed: false };
  }

  async listValuations(identity: Identity) {
    const ids = await transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      return (
        await c.query<{ id: string }>(
          "SELECT id FROM inventory_valuations WHERE user_id=$1 ORDER BY created_at DESC, id ASC LIMIT 50",
          [identity.userId],
        )
      ).rows.map((r) => r.id);
    });
    const out = [];
    for (const id of ids) {
      out.push(await this.getValuation(identity, id));
    }
    return out;
  }

  async getValuation(identity: Identity, id: string) {
    if (!UUID_RE.test(id)) fail("invalid_parameter", 400, "Invalid valuation identifier.");
    const loaded = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const header = (
        await c.query<ValuationRow>("SELECT * FROM inventory_valuations WHERE id=$1 AND user_id=$2", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!header) fail("not_found", 404, "Inventory valuation not found.");
      const itemRows = (
        await c.query<ValuationItemRow>(
          "SELECT * FROM inventory_valuation_items WHERE valuation_id=$1 AND user_id=$2 ORDER BY row_index ASC",
          [id, identity.userId],
        )
      ).rows;
      return { now, header, itemRows };
    });

    const batchView = loaded.header.batch_id
      ? await this.batches.get(identity, loaded.header.batch_id)
      : null;
    const batchByIndex = new Map((batchView?.items ?? []).map((b) => [b.item_index, b]));

    const projectedItems = loaded.itemRows.map((row) => {
      const unitCost = row.cost_basis_cents === null ? null : Number(row.cost_basis_cents);
      const lineCost = unitCost === null ? null : unitCost * row.quantity;
      const base = {
        row_index: row.row_index,
        sku: row.sku,
        title: row.title,
        quantity: row.quantity,
        declared_currency: row.declared_currency,
        unit_cost_basis_cents: unitCost,
        line_cost_basis_cents: lineCost,
        mapped_q: row.mapped_q,
        mapped_category: row.mapped_category,
        mapped_brand: row.mapped_brand,
        mapped_model: row.mapped_model,
        mapped_condition: row.mapped_condition,
        window_days: row.window_days,
        price_basis: row.price_basis,
        mapping_status: row.mapping_status,
        mapping_note: row.mapping_note,
        canonical_query_hash: row.canonical_query_hash,
      };

      if (row.mapping_status !== "mapped" || row.batch_item_index === null) {
        return {
          ...base,
          query_id: null,
          valuation_status: row.mapping_status as InventoryValuationItemStatus,
          sample_confidence: "none" as const,
          n_price_verified: 0,
          credits_charged: 0,
          unit_p25_cents: null,
          unit_median_cents: null,
          unit_p75_cents: null,
          line_p25_cents: null,
          line_median_cents: null,
          line_p75_cents: null,
          data_as_of: null,
          exclusion_reason: row.mapping_status,
        };
      }

      const b = batchByIndex.get(row.batch_item_index);
      const qId = b?.query_id ?? row.query_id;
      if (!b) {
        return {
          ...base,
          query_id: qId,
          valuation_status: "failed" as const,
          sample_confidence: "none" as const,
          n_price_verified: 0,
          credits_charged: 0,
          unit_p25_cents: null,
          unit_median_cents: null,
          unit_p75_cents: null,
          line_p25_cents: null,
          line_median_cents: null,
          line_p75_cents: null,
          data_as_of: null,
          exclusion_reason: "batch_item_missing",
        };
      }

      if (
        b.rights_unavailable ||
        (b.query_id && b.status === "failed" && b.error_code === "source_unavailable")
      ) {
        return {
          ...base,
          query_id: qId,
          valuation_status: "rights_revoked" as const,
          sample_confidence: "none" as const,
          n_price_verified: 0,
          credits_charged: b.credits_charged,
          unit_p25_cents: null,
          unit_median_cents: null,
          unit_p75_cents: null,
          line_p25_cents: null,
          line_median_cents: null,
          line_p75_cents: null,
          data_as_of: b.data_as_of,
          exclusion_reason: "rights_revoked",
        };
      }

      if (b.status === "ready_to_claim") {
        return {
          ...base,
          query_id: qId,
          valuation_status: "unclaimed" as const,
          sample_confidence: "none" as const,
          n_price_verified: 0,
          credits_charged: 0,
          unit_p25_cents: null,
          unit_median_cents: null,
          unit_p75_cents: null,
          line_p25_cents: null,
          line_median_cents: null,
          line_p75_cents: null,
          data_as_of: b.data_as_of,
          exclusion_reason: "unclaimed_result",
        };
      }

      if (b.status === "queued" || b.status === "running") {
        return {
          ...base,
          query_id: qId,
          valuation_status: "pending" as const,
          sample_confidence: "none" as const,
          n_price_verified: 0,
          credits_charged: 0,
          unit_p25_cents: null,
          unit_median_cents: null,
          unit_p75_cents: null,
          line_p25_cents: null,
          line_median_cents: null,
          line_p75_cents: null,
          data_as_of: null,
          exclusion_reason: b.status,
        };
      }

      if (b.status === "cancelled" || b.status === "expired" || b.status === "failed") {
        return {
          ...base,
          query_id: qId,
          valuation_status: b.status,
          sample_confidence: "none" as const,
          n_price_verified: 0,
          credits_charged: b.credits_charged,
          unit_p25_cents: null,
          unit_median_cents: null,
          unit_p75_cents: null,
          line_p25_cents: null,
          line_median_cents: null,
          line_p75_cents: null,
          data_as_of: b.data_as_of,
          exclusion_reason: b.error_code ?? b.status,
        };
      }

      const nVerified = b.stats?.n_price_verified ?? 0;
      const medianCents = b.stats?.median_cents ?? null;
      if (!b.stats || nVerified < 8 || medianCents === null) {
        return {
          ...base,
          query_id: qId,
          valuation_status: "insufficient_samples" as const,
          sample_confidence: "insufficient" as const,
          n_price_verified: nVerified,
          credits_charged: b.credits_charged,
          unit_p25_cents: null,
          unit_median_cents: null,
          unit_p75_cents: null,
          line_p25_cents: null,
          line_median_cents: null,
          line_p75_cents: null,
          data_as_of: b.data_as_of,
          exclusion_reason: "insufficient_samples",
        };
      }

      const p25Cents = b.stats.p25_cents;
      const p75Cents = b.stats.p75_cents;
      return {
        ...base,
        query_id: qId,
        valuation_status: "valued" as const,
        sample_confidence: nVerified >= 30 ? ("sufficient" as const) : ("limited" as const),
        n_price_verified: nVerified,
        credits_charged: b.credits_charged,
        unit_p25_cents: p25Cents,
        unit_median_cents: medianCents,
        unit_p75_cents: p75Cents,
        line_p25_cents: p25Cents === null ? null : p25Cents * row.quantity,
        line_median_cents: medianCents * row.quantity,
        line_p75_cents: p75Cents === null ? null : p75Cents * row.quantity,
        data_as_of: b.data_as_of,
        exclusion_reason: null,
      };
    });

    const valuedItems = projectedItems.filter((i) => i.valuation_status === "valued");
    const excludedItems = projectedItems.filter((i) => i.valuation_status !== "valued");
    const breakdown: Record<string, number> = {};
    for (const item of excludedItems) {
      breakdown[item.valuation_status] = (breakdown[item.valuation_status] ?? 0) + 1;
    }

    const asOfTimes = projectedItems
      .map((i) => i.data_as_of)
      .filter((t): t is string => Boolean(t))
      .sort();

    let nextStatus: InventoryValuationStatus = loaded.header.status;
    if (loaded.header.cancelled_at || batchView?.status === "cancelled") {
      nextStatus = "cancelled";
    } else if (batchView?.status === "queued" || batchView?.status === "running") {
      nextStatus = batchView.status;
    } else if (projectedItems.some((i) => i.valuation_status === "unclaimed")) {
      nextStatus = "ready_to_claim";
    } else if (valuedItems.length === projectedItems.length && projectedItems.length > 0) {
      nextStatus = "completed";
    } else if (
      valuedItems.length > 0 ||
      projectedItems.some((i) => i.valuation_status === "insufficient_samples")
    ) {
      nextStatus = "partial";
    } else if (batchView) {
      nextStatus = "failed";
    }

    let version = loaded.header.version;
    if (nextStatus !== loaded.header.status) {
      const updated = await transaction(this.query.db, async (c) => {
        const res = (
          await c.query<{ version: number }>(
            "UPDATE inventory_valuations SET status=$3, updated_at=$4, completed_at=CASE WHEN $3 IN ('completed','partial','failed','cancelled') THEN coalesce(completed_at,$4) ELSE completed_at END, version=version+1 WHERE id=$1 AND user_id=$2 RETURNING version",
            [id, identity.userId, nextStatus, loaded.now],
          )
        ).rows[0];
        return res?.version ?? version;
      });
      version = updated;
    }

    const costBasisRows = projectedItems.filter((i) => i.line_cost_basis_cents !== null);
    const totalCostBasis = costBasisRows.length
      ? costBasisRows.reduce((s, r) => s + (r.line_cost_basis_cents ?? 0), 0)
      : null;

    const p25Values = valuedItems.map((i) => i.line_p25_cents).filter((v): v is number => v !== null);
    const p75Values = valuedItems.map((i) => i.line_p75_cents).filter((v): v is number => v !== null);

    return {
      id: loaded.header.id,
      name: loaded.header.name,
      status: nextStatus,
      version,
      batch_id: loaded.header.batch_id,
      revaluation_of_id: loaded.header.revaluation_of_id,
      billing_consent_accepted: loaded.header.billing_consent_accepted,
      estimated_max_credits: loaded.header.estimated_max_credits,
      total_credits_charged: batchView?.total_credits_charged ?? 0,
      currency: "USD" as const,
      valuation_disclaimer: VALUATION_DISCLAIMER,
      portfolio_p25_cents:
        valuedItems.length > 0 && p25Values.length === valuedItems.length
          ? p25Values.reduce((s, v) => s + v, 0)
          : null,
      portfolio_median_cents:
        valuedItems.length > 0 ? valuedItems.reduce((s, i) => s + (i.line_median_cents ?? 0), 0) : null,
      portfolio_p75_cents:
        valuedItems.length > 0 && p75Values.length === valuedItems.length
          ? p75Values.reduce((s, v) => s + v, 0)
          : null,
      total_cost_basis_cents: totalCostBasis,
      cost_basis_rows: costBasisRows.length,
      denominator: {
        valued_rows: valuedItems.length,
        total_rows: projectedItems.length,
        valued_units: valuedItems.reduce((s, i) => s + i.quantity, 0),
        total_units: projectedItems.reduce((s, i) => s + i.quantity, 0),
        excluded_rows: excludedItems.length,
        excluded_units: excludedItems.reduce((s, i) => s + i.quantity, 0),
        breakdown,
      },
      as_of_range: {
        oldest_as_of: asOfTimes[0] ?? null,
        newest_as_of: asOfTimes.at(-1) ?? null,
      },
      created_at: loaded.header.created_at.toISOString(),
      updated_at: loaded.header.updated_at.toISOString(),
      completed_at: loaded.header.completed_at?.toISOString() ?? null,
      cancelled_at: loaded.header.cancelled_at?.toISOString() ?? null,
      items: projectedItems,
    };
  }

  async claimValuation(
    identity: Identity,
    id: string,
    idempotencyKey: string | undefined,
    requestId: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const valuation = await this.getValuation(identity, id);
    if (!valuation.batch_id) {
      return {
        valuation,
        claim: {
          claimed_query_ids: [],
          already_delivered_query_ids: [],
          failed_items: [],
          credits_charged_now: 0,
          batch_total_credits_charged: 0,
        },
      };
    }
    const res = await this.batches.claim(identity, valuation.batch_id, {}, key, requestId);
    const updated = await this.getValuation(identity, id);
    return {
      valuation: updated,
      claim: {
        claimed_query_ids: res.claimed_query_ids,
        already_delivered_query_ids: res.already_delivered_query_ids,
        failed_items: res.failed_items,
        credits_charged_now: res.credits_charged_now,
        batch_total_credits_charged: res.batch_total_credits_charged,
      },
    };
  }

  async cancelValuation(identity: Identity, id: string, version: number, idempotencyKey: string | undefined) {
    if (!UUID_RE.test(id)) fail("invalid_parameter", 400, "Invalid valuation identifier.");
    if (!Number.isSafeInteger(version) || version < 1)
      fail("invalid_parameter", 400, "Valid valuation version is required.");
    const key = requireIdempotencyKey(idempotencyKey);
    const keyHash = createHash("sha256").update(key).digest("hex");
    const requestHash = createHash("sha256").update(`inv-cancel:${id}:${version}`).digest("hex");

    const check = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "jobs:read");
      const current = (
        await c.query<ValuationRow>(
          "SELECT * FROM inventory_valuations WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [id, identity.userId],
        )
      ).rows[0];
      if (!current) fail("not_found", 404, "Inventory valuation not found.");

      const prior = (
        await c.query<{ request_hash: string }>(
          "SELECT request_hash FROM idempotency_records WHERE owner_scope=$1 AND operation='inventory.cancel' AND key_hash=$2 AND expires_at>$3",
          [identity.userId, keyHash, now],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail("idempotency_conflict", 409, "Idempotency key was used for a different cancellation.");
        return { replayed: true as const, batchId: current.batch_id };
      }
      if (current.version !== version) fail("state_conflict", 409, "Valuation version changed.");
      if (["cancelled", "completed", "failed"].includes(current.status))
        fail("state_conflict", 409, "Only active inventory valuations can be cancelled.");
      return { replayed: false as const, batchId: current.batch_id };
    });

    if (check.replayed) return this.getValuation(identity, id);

    if (check.batchId) {
      const batch = await this.batches.get(identity, check.batchId);
      if (["queued", "running"].includes(batch.status)) {
        const derivedCancelKey = createHash("sha256").update(`inv-cancel:${key}`).digest("hex").slice(0, 48);
        await this.batches.cancel(identity, batch.id, batch.version, derivedCancelKey);
      }
    }

    await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "jobs:read");
      await c.query(
        "UPDATE inventory_valuations SET status='cancelled',cancelled_at=coalesce(cancelled_at,$3),completed_at=coalesce(completed_at,$3),updated_at=$3,version=version+1 WHERE id=$1 AND user_id=$2",
        [id, identity.userId, now],
      );
      await c.query(
        `INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at)
         VALUES($1,'inventory.cancel',$2,$3,$4,'committed',$5)
         ON CONFLICT(owner_scope,operation,key_hash) DO UPDATE SET
         request_hash=excluded.request_hash,resource_id=excluded.resource_id,expires_at=excluded.expires_at`,
        [identity.userId, keyHash, requestHash, id, new Date(now.getTime() + 86400000)],
      );
    });
    return this.getValuation(identity, id);
  }

  async revalueValuation(
    identity: Identity,
    id: string,
    input: {
      billing_consent_accepted: boolean;
      name?: string;
      window_days?: 30 | 90 | 180 | 365;
    },
    idempotencyKey: string | undefined,
  ) {
    if (!UUID_RE.test(id)) fail("invalid_parameter", 400, "Invalid valuation identifier.");
    const key = requireIdempotencyKey(idempotencyKey);
    if (input.billing_consent_accepted !== true)
      fail(
        "billing_consent_required",
        400,
        "Explicit billing_consent_accepted=true is required before re-valuing inventory.",
      );

    const original = await transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      const header = (
        await c.query<ValuationRow>("SELECT * FROM inventory_valuations WHERE id=$1 AND user_id=$2", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!header) fail("not_found", 404, "Original inventory valuation not found.");
      const rows = (
        await c.query<ValuationItemRow>(
          "SELECT * FROM inventory_valuation_items WHERE valuation_id=$1 AND user_id=$2 ORDER BY row_index ASC",
          [id, identity.userId],
        )
      ).rows;
      return { header, rows };
    });

    const items = original.rows.map((r) => ({
      sku: r.sku,
      title: r.title,
      quantity: r.quantity,
      currency: r.declared_currency,
      ...(r.cost_basis_cents !== null ? { cost_basis_cents: Number(r.cost_basis_cents) } : {}),
      ...(r.mapped_q ? { q: r.mapped_q } : {}),
      ...(r.mapped_category ? { category: r.mapped_category } : {}),
      ...(r.mapped_brand ? { brand: r.mapped_brand } : {}),
      ...(r.mapped_model ? { model: r.mapped_model } : {}),
      ...(r.mapped_condition ? { condition: r.mapped_condition } : {}),
      window_days: input.window_days ?? r.window_days,
      price_basis: r.price_basis,
    }));

    return this.createValuation(
      identity,
      {
        name: input.name ?? `${original.header.name.slice(0, 95)} (re-valuation)`,
        items,
        billing_consent_accepted: true,
        revaluation_of_id: id,
      },
      key,
    );
  }

  async exportValuation(identity: Identity, id: string, format: "json" | "csv") {
    if (!["csv", "json"].includes(format))
      fail("invalid_parameter", 400, "Export format must be csv or json.");
    const valuation = await this.getValuation(identity, id);
    const filename = `soldbench-inventory-${id}.${format}`;
    if (format === "json") {
      return {
        body: JSON.stringify(
          {
            data_mode: "synthetic_fixture",
            exported_at: valuation.updated_at,
            valuation,
          },
          null,
          2,
        ),
        contentType: "application/json; charset=utf-8",
        filename,
      };
    }

    const header = [
      "row_index",
      "sku",
      "title",
      "quantity",
      "declared_currency",
      "mapping_status",
      "valuation_status",
      "sample_confidence",
      "n_price_verified",
      "unit_p25_cents",
      "unit_median_cents",
      "unit_p75_cents",
      "line_p25_cents",
      "line_median_cents",
      "line_p75_cents",
      "data_as_of",
      "query_id",
      "disclaimer",
    ].join(",");

    const lines = valuation.items.map((item) =>
      [
        item.row_index,
        item.sku,
        item.title,
        item.quantity,
        item.declared_currency,
        item.mapping_status,
        item.valuation_status,
        item.sample_confidence,
        item.n_price_verified,
        item.unit_p25_cents ?? "",
        item.unit_median_cents ?? "",
        item.unit_p75_cents ?? "",
        item.line_p25_cents ?? "",
        item.line_median_cents ?? "",
        item.line_p75_cents ?? "",
        item.data_as_of ?? "",
        item.query_id ?? "",
        valuation.valuation_disclaimer,
      ]
        .map(csv)
        .join(","),
    );
    return {
      body: `${[header, ...lines].join("\r\n")}\r\n`,
      contentType: "text/csv; charset=utf-8",
      filename,
    };
  }
}
