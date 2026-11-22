import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "@soldbench/auth";
import {
  availability,
  canonicalJson,
  collectionQueryHash,
  compatibleCleaner,
  normalizeQuery,
  queryHash,
  type SoldQuery,
} from "@soldbench/core";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError, VERSIONS } from "@soldbench/shared";
import type { QueryService } from "./index.ts";
import { csv, permissions } from "./research.ts";

export const MAX_BATCH_ITEMS = 20;
export const MAX_ACTIVE_BATCHES_PER_OWNER = 1;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CSV_COLUMNS = new Set([
  "q",
  "marketplace",
  "category",
  "brand",
  "model",
  "condition",
  "window_days",
  "price_basis",
  "sale_format",
  "min_price_cents",
  "max_price_cents",
  "allow_stale",
  "limit",
]);
const ALLOWED_JSON_KEYS = new Set([...CSV_COLUMNS, "attributes"]);

type BatchRow = {
  id: string;
  user_id: string;
  name: string;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  total_items: number;
  unique_query_count: number;
  estimated_max_credits: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
  version: number;
};

type BatchItemJoinRow = {
  batch_id: string;
  item_index: number;
  input_query: Record<string, unknown>;
  canonical_query_hash: string | null;
  deduplicated_in_batch: boolean;
  primary_item_index: number | null;
  query_id: string | null;
  job_id: string | null;
  submit_status: "submitted" | "reused" | "failed";
  error_code: string | null;
  error_message: string | null;
  q_compute_status: string | null;
  q_settlement_status: string | null;
  q_result_state: string | null;
  q_allow_stale: boolean | null;
  q_expires_at: Date | null;
  q_delivered_at: Date | null;
  q_engine_version: string | null;
  q_cleaner_version: string | null;
  q_normalizer_version: string | null;
  q_billing_policy_version: string | null;
  q_filters: SoldQuery | null;
  job_status: string | null;
  job_error_code: string | null;
  job_version: number | null;
  stats: {
    n_total?: number;
    n_comparable?: number;
    n_price_verified: number;
    median_cents: number | null;
    p25_cents: number | null;
    p75_cents: number | null;
    trimmed_mean_cents: number | null;
  } | null;
  data_as_of: Date | null;
};

export type NormalizedBatchInput = {
  item_index: number;
  raw_input: Record<string, unknown>;
  valid: boolean;
  normalized: SoldQuery | null;
  canonical_query_hash: string | null;
  deduplicated_in_batch: boolean;
  primary_item_index: number | null;
  error_code: string | null;
  error_message: string | null;
};

export type BatchItemStatus =
  | "queued"
  | "running"
  | "ready_to_claim"
  | "delivered"
  | "failed"
  | "cancelled"
  | "expired";

export type BatchStatsSummary = {
  n_total: number;
  n_comparable: number;
  n_price_verified: number;
  median_cents: number | null;
  p25_cents: number | null;
  p75_cents: number | null;
  trimmed_mean_cents: number | null;
};

export type BatchItemView = {
  item_index: number;
  input_query: Record<string, unknown>;
  canonical_query_hash: string | null;
  deduplicated_in_batch: boolean;
  primary_item_index: number | null;
  query_id: string | null;
  job_id: string | null;
  status: BatchItemStatus;
  reused: boolean;
  claimable: boolean;
  potential_credits: 0 | 1;
  credits_charged: 0 | 1;
  rights_unavailable: boolean;
  freshness_state: "fresh" | "stale" | "expired" | null;
  data_as_of: string | null;
  error_code: string | null;
  error_message: string | null;
  stats: BatchStatsSummary | null;
};

export type BatchView = {
  id: string;
  name: string;
  status: BatchRow["status"];
  version: number;
  total_items: number;
  unique_query_count: number;
  estimated_max_credits: number;
  total_credits_charged: number;
  counts: {
    queued: number;
    running: number;
    ready_to_claim: number;
    delivered: number;
    failed: number;
    cancelled: number;
    expired: number;
  };
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  items: BatchItemView[];
};

const fail = (code: string, status: number, message: string): never => {
  throw new AppError(code, status, message);
};

function parseCsvRows(text: string): string[][] {
  const clean = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!clean.trim()) fail("invalid_parameter", 400, "CSV input must not be empty.");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) fail("invalid_parameter", 400, "Unexpected quote inside CSV cell.");
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (inQuotes) fail("invalid_parameter", 400, "Unclosed quoted value in CSV input.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1]?.every((c) => c === "")) {
    rows.pop();
  }
  return rows;
}

/**
 * Parse an RFC-4180 CSV payload into normalized candidate query items (`1..20` data rows).
 */
export function parseBatchCsv(csvText: string): Record<string, unknown>[] {
  if (typeof csvText !== "string") fail("invalid_parameter", 400, "CSV input must be text.");
  if (Buffer.byteLength(csvText, "utf8") > 65536)
    fail("invalid_parameter", 400, "CSV input exceeds 64 KiB limit.");
  const rows = parseCsvRows(csvText);
  if (rows.length < 2)
    fail("invalid_parameter", 400, "CSV input requires a header row and 1 to 20 data rows.");
  if (rows.length - 1 > MAX_BATCH_ITEMS)
    fail("invalid_parameter", 400, `Batch supports at most ${MAX_BATCH_ITEMS} items.`);

  const rawHeaders = rows[0] ?? [];
  const headers = rawHeaders.map((h) => h.trim().toLowerCase());
  const seenHeaders = new Set<string>();
  for (const h of headers) {
    if (!h || seenHeaders.has(h)) fail("invalid_parameter", 400, "CSV headers must be non-empty and unique.");
    if (!CSV_COLUMNS.has(h) && !/^attr_[a-z0-9_]{1,40}$/.test(h))
      fail("invalid_parameter", 400, `Unsupported CSV column: ${h}.`);
    seenHeaders.add(h);
  }
  if (!seenHeaders.has("q")) fail("invalid_parameter", 400, "CSV header must include the q column.");

  const items: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (cells.length !== headers.length)
      fail("invalid_parameter", 400, `CSV row ${r + 1} column count mismatch.`);
    const record: Record<string, unknown> = {};
    const attributes: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c] ?? "";
      const raw = (cells[c] ?? "").trim();
      if (!raw) continue;
      if (header.startsWith("attr_")) {
        attributes[header.slice(5)] = raw;
      } else if (["window_days", "limit", "min_price_cents", "max_price_cents"].includes(header)) {
        const parsed = /^-?\d+$/.test(raw) ? Number(raw) : raw;
        record[header] = Number.isSafeInteger(parsed) ? parsed : raw;
      } else if (header === "allow_stale") {
        record[header] = raw === "true" ? true : raw === "false" ? false : raw;
      } else {
        record[header] = raw;
      }
    }
    if (record.q === undefined) record.q = "";
    if (Object.keys(attributes).length > 0) record.attributes = attributes;
    items.push(record);
  }
  return items;
}

function itemToSearchParams(value: unknown): {
  rawInput: Record<string, unknown>;
  params: URLSearchParams;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_parameter", 400, "Each batch item must be a query object.");
  const input = value as Record<string, unknown>;
  const unknownKey = Object.keys(input).find((k) => !ALLOWED_JSON_KEYS.has(k));
  if (unknownKey)
    return {
      rawInput: input,
      params: new URLSearchParams([[unknownKey, String(input[unknownKey] ?? "")]]),
    };
  const params = new URLSearchParams();
  for (const [key, field] of Object.entries(input)) {
    if (field === undefined || field === null) continue;
    if (key === "attributes") {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        params.set("attr_invalid", "");
        continue;
      }
      for (const [attr, attrVal] of Object.entries(field)) {
        params.set(`attr_${attr}`, typeof attrVal === "string" ? attrVal : "");
      }
    } else if (typeof field === "boolean" || typeof field === "number" || typeof field === "string") {
      params.set(key, String(field));
    } else {
      params.set(key, "");
    }
  }
  return { rawInput: input, params };
}

function deriveBatchStatus(
  items: Pick<BatchItemView, "status" | "claimable">[],
  cancelledAt: Date | null,
): BatchRow["status"] {
  if (items.some((item) => item.status === "running")) return "running";
  if (items.some((item) => item.status === "queued")) return "queued";
  if (cancelledAt || (items.length > 0 && items.every((item) => item.status === "cancelled")))
    return "cancelled";
  const succeeded = items.filter((i) => i.status === "delivered" || i.status === "ready_to_claim").length;
  const failed = items.filter(
    (i) => i.status === "failed" || i.status === "expired" || i.status === "cancelled",
  ).length;
  if (succeeded > 0 && failed === 0) return "completed";
  if (succeeded > 0 && failed > 0) return "partial";
  return "failed";
}

function requireIdempotencyKey(key: string | undefined): string {
  if (!key || !IDEMPOTENCY_KEY.test(key))
    throw new AppError("invalid_parameter", 400, "A valid Idempotency-Key header is required.");
  return key;
}

/**
 * Orchestrates merchant multi-query batches (`<=20` items, `1` active batch/owner)
 * on top of `QueryService` and `BillingService` without duplicating pricing or billing rules.
 */
export class BatchQueryService {
  constructor(private readonly query: QueryService) {}

  normalizeItems(input: { items?: unknown[]; csv?: string }): NormalizedBatchInput[] {
    const hasItems = input.items !== undefined;
    const hasCsv = input.csv !== undefined;
    if (hasItems === hasCsv)
      fail("invalid_parameter", 400, "Provide exactly one of items array or csv payload.");
    const rawList = hasCsv ? parseBatchCsv(input.csv ?? "") : input.items;
    if (!Array.isArray(rawList) || rawList.length < 1 || rawList.length > MAX_BATCH_ITEMS)
      throw new AppError(
        "invalid_parameter",
        400,
        `Batch must include between 1 and ${MAX_BATCH_ITEMS} items.`,
      );

    const seenHashes = new Map<string, number>();
    return rawList.map((entry, idx) => {
      const { rawInput, params } = itemToSearchParams(entry);
      try {
        const normalized = normalizeQuery(params);
        const hash = queryHash(normalized);
        const primary = seenHashes.get(hash);
        const deduplicated = primary !== undefined;
        if (!deduplicated) seenHashes.set(hash, idx);
        return {
          item_index: idx,
          raw_input: rawInput,
          valid: true,
          normalized,
          canonical_query_hash: hash,
          deduplicated_in_batch: deduplicated,
          primary_item_index: primary ?? null,
          error_code: null,
          error_message: null,
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return {
          item_index: idx,
          raw_input: rawInput,
          valid: false,
          normalized: null,
          canonical_query_hash: null,
          deduplicated_in_batch: false,
          primary_item_index: null,
          error_code: error.code,
          error_message: error.message,
        };
      }
    });
  }

  private async estimateQueryCostLocked(
    c: Transaction,
    userId: string,
    query: SoldQuery,
    hash: string,
    now: Date,
  ): Promise<{ reusable: boolean; covered: boolean; estimated_credits: 0 | 1 }> {
    const old = (
      await c.query<{
        id: string;
        compute_status: string;
        settlement_status: string;
        stats: { n_price_verified: number } | null;
        reuse_data_as_of: Date | null;
        engine_version: string | null;
        cleaner_version: string | null;
      }>(
        `SELECT q.id,q.compute_status,q.settlement_status,rq.stats,rq.engine_version,rq.cleaner_version,
           coalesce(rq.data_as_of,cj.min_page_as_of,cj.as_of) AS reuse_data_as_of
         FROM queries q
         LEFT JOIN query_results rq ON rq.query_id=q.id
         LEFT JOIN collector_jobs cj ON cj.id=q.collector_job_id
         WHERE q.user_id=$1 AND q.canonical_query_hash=$2
           AND (q.created_at>$3 OR q.compute_status IN ('queued','running'))
           AND q.compute_status IN ('queued','running','completed')
           AND q.normalizer_version=$5 AND q.billing_policy_version=$6
           AND (q.expires_at>$4 OR q.settlement_status IN ('charged','refunded'))
         ORDER BY (q.settlement_status IN ('charged','refunded')) DESC, q.created_at DESC, q.id DESC
         LIMIT 1`,
        [userId, hash, new Date(now.getTime() - 600000), now, VERSIONS.normalizer, VERSIONS.billing],
      )
    ).rows[0];

    if (old) {
      let rightsOk = true;
      try {
        await this.query.assertSnapshotRights(c, old.id, now);
      } catch (error) {
        if (!(error instanceof AppError) || !["forbidden", "source_unavailable"].includes(error.code))
          throw error;
        rightsOk = false;
      }
      const compatible =
        old.compute_status !== "completed" ||
        (old.engine_version === VERSIONS.engine && compatibleCleaner(query, old.cleaner_version));
      if (rightsOk && compatible) {
        const reuse = availability({
          now: now.toISOString(),
          dataAsOf: old.reuse_data_as_of?.toISOString() ?? null,
          currentRights: "allowed",
          snapshotExists: true,
          allowStale: query.allow_stale,
          verifiedSamples: old.stats?.n_price_verified ?? 0,
        });
        if (reuse.readable) {
          if (["charged", "refunded", "not_required"].includes(old.settlement_status)) {
            return { reusable: true, covered: true, estimated_credits: 0 };
          }
          if (old.compute_status === "completed" && old.stats) {
            return {
              reusable: true,
              covered: true,
              estimated_credits: reuse.potentialCredits,
            };
          }
          return { reusable: true, covered: true, estimated_credits: 1 };
        }
      }
    }

    const covered = (
      await c.query<{ min_page_as_of: Date | null; as_of: Date }>(
        `SELECT j.min_page_as_of, j.as_of
         FROM collector_watermarks w
         JOIN collector_jobs j ON j.collector_run_id=w.run_id
         JOIN sources s ON s.id=w.source_id
         JOIN source_clearances x ON x.id=s.source_clearance_id
         WHERE w.query_hash=$1 AND j.status='completed' AND j.permission_epoch=s.permission_epoch
           AND s.status='active' AND s.access_method='offline_fixture' AND x.provider='synthetic_fixture'
           AND x.status IN ('draft','reviewed','active')
           AND (x.effective_at IS NULL OR x.effective_at<=$2)
           AND (x.expires_at IS NULL OR x.expires_at>$2) AND w.data_as_of<=$2
         ORDER BY w.data_as_of DESC, j.id LIMIT 1`,
        [collectionQueryHash(query), now],
      )
    ).rows[0];
    if (!covered) return { reusable: false, covered: false, estimated_credits: 0 };
    const avail = availability({
      now: now.toISOString(),
      dataAsOf: (covered.min_page_as_of ?? covered.as_of).toISOString(),
      currentRights: "allowed",
      snapshotExists: true,
      allowStale: query.allow_stale,
      verifiedSamples: 8,
    });
    return {
      reusable: false,
      covered: avail.readable,
      estimated_credits: avail.readable ? avail.potentialCredits : 0,
    };
  }

  /**
   * 0-credit preview: normalizes items, flags in-batch duplicates and invalid rows,
   * detects 10-minute reusable results, and caps expected credit usage against wallet balance.
   */
  async preview(identity: Identity, input: { items?: unknown[]; csv?: string }) {
    const normalized = this.normalizeItems(input);
    const estimateByHash = new Map<
      string,
      { reusable: boolean; covered: boolean; estimated_credits: 0 | 1 }
    >();
    const availableCredits = (await this.query.billing.balance(identity.userId)).available_credits;

    await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "sold:read");
      for (const item of normalized) {
        if (!item.valid || !item.normalized || !item.canonical_query_hash || item.deduplicated_in_batch)
          continue;
        estimateByHash.set(
          item.canonical_query_hash,
          await this.estimateQueryCostLocked(
            c,
            identity.userId,
            item.normalized,
            item.canonical_query_hash,
            now,
          ),
        );
      }
    });

    const items = normalized.map((item) => {
      const est = item.canonical_query_hash ? estimateByHash.get(item.canonical_query_hash) : undefined;
      const estimatedMaxCredits: 0 | 1 =
        !item.valid || item.deduplicated_in_batch ? 0 : (est?.estimated_credits ?? 0);
      return {
        item_index: item.item_index,
        input_query: item.raw_input,
        normalized_query: item.normalized,
        canonical_query_hash: item.canonical_query_hash,
        valid: item.valid,
        deduplicated_in_batch: item.deduplicated_in_batch,
        primary_item_index: item.primary_item_index,
        reusable: Boolean(est?.reusable && !item.deduplicated_in_batch),
        covered_offline: Boolean(item.valid && est?.covered),
        estimated_max_credits: estimatedMaxCredits,
        error_code: item.error_code,
        error_message: item.error_message,
      };
    });

    const maxEstimatedCredits = items.reduce<number>((sum, item) => sum + item.estimated_max_credits, 0);
    return {
      max_items_allowed: MAX_BATCH_ITEMS,
      max_active_batches_per_owner: MAX_ACTIVE_BATCHES_PER_OWNER,
      total_rows: items.length,
      valid_rows: items.filter((i) => i.valid).length,
      unique_executable_queries: items.filter((i) => i.valid && !i.deduplicated_in_batch).length,
      duplicate_rows: items.filter((i) => i.deduplicated_in_batch).length,
      invalid_rows: items.filter((i) => !i.valid).length,
      reusable_queries: items.filter((i) => i.valid && !i.deduplicated_in_batch && i.reusable).length,
      max_estimated_credits: maxEstimatedCredits,
      current_available_credits: availableCredits,
      sufficient_credits_for_max: availableCredits >= maxEstimatedCredits,
      items,
    };
  }

  private async syncAndReadBatch(
    c: Transaction,
    userId: string,
    batchId: string,
    now: Date,
  ): Promise<BatchView> {
    const batch = (
      await c.query<BatchRow>("SELECT * FROM batch_queries WHERE id=$1 AND user_id=$2 FOR UPDATE", [
        batchId,
        userId,
      ])
    ).rows[0];
    if (!batch) throw new AppError("not_found", 404, "Batch not found.");

    const rows = (
      await c.query<BatchItemJoinRow>(
        `SELECT bqi.*,
           q.compute_status AS q_compute_status,
           q.settlement_status AS q_settlement_status,
           q.result_state AS q_result_state,
           q.allow_stale AS q_allow_stale,
           q.expires_at AS q_expires_at,
           q.delivered_at AS q_delivered_at,
           q.filters AS q_filters,
           rq.engine_version AS q_engine_version,
           rq.cleaner_version AS q_cleaner_version,
           q.normalizer_version AS q_normalizer_version,
           q.billing_policy_version AS q_billing_policy_version,
           rq.stats AS stats,
           rq.data_as_of AS data_as_of,
           j.status AS job_status,
           j.error_code AS job_error_code,
           j.version AS job_version
         FROM batch_query_items bqi
         LEFT JOIN queries q ON q.id=bqi.query_id AND q.user_id=bqi.user_id
         LEFT JOIN query_jobs j ON j.id=bqi.job_id
         LEFT JOIN query_results rq ON rq.query_id=q.id
         WHERE bqi.batch_id=$1
         ORDER BY bqi.item_index ASC`,
        [batchId],
      )
    ).rows;

    const rightsByQuery = new Map<string, boolean>();
    for (const row of rows) {
      if (!row.query_id || row.q_compute_status !== "completed" || rightsByQuery.has(row.query_id)) continue;
      let allowed = true;
      try {
        await this.query.assertSnapshotRights(c, row.query_id, now);
      } catch (error) {
        if (!(error instanceof AppError) || !["forbidden", "source_unavailable"].includes(error.code))
          throw error;
        allowed = false;
      }
      rightsByQuery.set(row.query_id, allowed);
    }

    const items: BatchItemView[] = rows.map((row) => {
      if (!row.query_id) {
        return {
          item_index: row.item_index,
          input_query: row.input_query,
          canonical_query_hash: row.canonical_query_hash,
          deduplicated_in_batch: row.deduplicated_in_batch,
          primary_item_index: row.primary_item_index,
          query_id: null,
          job_id: null,
          status: "failed",
          reused: false,
          claimable: false,
          potential_credits: 0,
          credits_charged: 0,
          rights_unavailable: false,
          freshness_state: null,
          data_as_of: null,
          error_code: row.error_code ?? "invalid_parameter",
          error_message: row.error_message,
          stats: null,
        };
      }

      const delivered = ["charged", "refunded", "not_required"].includes(row.q_settlement_status ?? "");
      const rightsAvailable =
        row.q_compute_status === "completed" ? (rightsByQuery.get(row.query_id) ?? false) : true;
      let status: BatchItemStatus = "queued";
      let claimable = false;
      let potentialCredits: 0 | 1 = 0;
      let freshnessState: BatchItemView["freshness_state"] = null;
      let errorCode = row.error_code;

      if (row.q_compute_status === "completed" && row.stats) {
        const avail = availability({
          now: now.toISOString(),
          dataAsOf: row.data_as_of?.toISOString() ?? null,
          currentRights: rightsAvailable ? "allowed" : "revoked",
          snapshotExists: true,
          allowStale: Boolean(row.q_allow_stale),
          verifiedSamples: row.stats.n_price_verified,
        });
        freshnessState =
          avail.freshness === "fresh" || avail.freshness === "stale" ? avail.freshness : "expired";
        const versionOk =
          row.q_engine_version === VERSIONS.engine &&
          compatibleCleaner(row.q_filters ?? ({} as SoldQuery), row.q_cleaner_version) &&
          row.q_normalizer_version === VERSIONS.normalizer &&
          row.q_billing_policy_version === VERSIONS.billing;
        const expiredUnclaimed =
          !delivered && ((row.q_expires_at && row.q_expires_at <= now) || row.q_result_state === "expired");
        if (delivered) {
          status = "delivered";
        } else if (expiredUnclaimed || avail.freshness === "expired") {
          status = "expired";
          errorCode = "result_expired";
        } else if (!rightsAvailable) {
          status = "failed";
          errorCode = "source_unavailable";
        } else if (!avail.readable) {
          status = "failed";
          errorCode = "source_unavailable";
        } else if (!versionOk) {
          status = "failed";
          errorCode = "state_conflict";
        } else {
          status = "ready_to_claim";
          claimable = true;
          potentialCredits = avail.potentialCredits;
        }
      } else if (row.job_status === "running" || row.q_compute_status === "running") {
        status = "running";
      } else if (row.job_status === "cancelled" || row.q_compute_status === "cancelled") {
        status = "cancelled";
      } else if (
        row.job_status === "expired" ||
        row.q_compute_status === "expired" ||
        (row.q_expires_at && row.q_expires_at <= now)
      ) {
        status = "expired";
        errorCode = row.job_error_code ?? "result_expired";
      } else if (row.job_status === "failed" || row.q_compute_status === "failed") {
        status = "failed";
        errorCode = row.job_error_code ?? "source_unavailable";
      } else {
        status = "queued";
      }

      const visibleStats = status === "delivered" && rightsAvailable ? row.stats : null;
      return {
        item_index: row.item_index,
        input_query: row.input_query,
        canonical_query_hash: row.canonical_query_hash,
        deduplicated_in_batch: row.deduplicated_in_batch,
        primary_item_index: row.primary_item_index,
        query_id: row.query_id,
        job_id: row.job_id,
        status,
        reused: row.submit_status === "reused" || row.deduplicated_in_batch,
        claimable,
        potential_credits: potentialCredits,
        credits_charged: row.q_settlement_status === "charged" ? 1 : 0,
        rights_unavailable: status === "delivered" && !rightsAvailable,
        freshness_state: freshnessState,
        data_as_of: row.data_as_of?.toISOString() ?? null,
        error_code: errorCode,
        error_message: row.error_message,
        stats: visibleStats
          ? {
              n_total: visibleStats.n_total ?? visibleStats.n_price_verified,
              n_comparable: visibleStats.n_comparable ?? visibleStats.n_price_verified,
              n_price_verified: visibleStats.n_price_verified,
              median_cents: visibleStats.median_cents,
              p25_cents: visibleStats.p25_cents,
              p75_cents: visibleStats.p75_cents,
              trimmed_mean_cents: visibleStats.trimmed_mean_cents,
            }
          : null,
      };
    });

    const nextStatus = rows.length ? deriveBatchStatus(items, batch.cancelled_at) : batch.status;
    let nextVersion = batch.version;
    let nextCompletedAt = batch.completed_at;
    let nextUpdatedAt = batch.updated_at;
    const isTerminal = !["queued", "running"].includes(nextStatus);
    if (rows.length && (nextStatus !== batch.status || (isTerminal && !batch.completed_at))) {
      nextVersion = batch.version + 1;
      nextUpdatedAt = now;
      nextCompletedAt = isTerminal ? (batch.completed_at ?? now) : null;
      await c.query(
        "UPDATE batch_queries SET status=$2, updated_at=$3, completed_at=$4, version=$5 WHERE id=$1",
        [batch.id, nextStatus, nextUpdatedAt, nextCompletedAt, nextVersion],
      );
    }

    const chargedQueries = new Set<string>();
    for (const item of items) {
      if (item.query_id && item.credits_charged === 1) chargedQueries.add(item.query_id);
    }

    const counts = {
      queued: items.filter((i) => i.status === "queued").length,
      running: items.filter((i) => i.status === "running").length,
      ready_to_claim: items.filter((i) => i.status === "ready_to_claim").length,
      delivered: items.filter((i) => i.status === "delivered").length,
      failed: items.filter((i) => i.status === "failed").length,
      cancelled: items.filter((i) => i.status === "cancelled").length,
      expired: items.filter((i) => i.status === "expired").length,
    };

    return {
      id: batch.id,
      name: batch.name,
      status: nextStatus,
      version: nextVersion,
      total_items: batch.total_items,
      unique_query_count: batch.unique_query_count,
      estimated_max_credits: batch.estimated_max_credits,
      total_credits_charged: chargedQueries.size,
      counts,
      created_at: batch.created_at.toISOString(),
      updated_at: nextUpdatedAt.toISOString(),
      completed_at: nextCompletedAt?.toISOString() ?? null,
      cancelled_at: batch.cancelled_at?.toISOString() ?? null,
      items,
    };
  }

  async create(
    identity: Identity,
    input: { name?: string; items?: unknown[]; csv?: string },
    idempotencyKey: string | undefined,
  ): Promise<{ batch: BatchView; replayed: boolean }> {
    const key = requireIdempotencyKey(idempotencyKey);
    const keyHash = createHash("sha256").update(key).digest("hex");
    const normalized = this.normalizeItems(input);
    const uniqueValid = normalized.filter((item) => item.valid && !item.deduplicated_in_batch);
    if (!uniqueValid.length)
      fail("invalid_parameter", 400, "At least one valid query item is required to create a batch.");

    const rawName = input.name === undefined ? "" : String(input.name).trim();
    if (input.name !== undefined && (!rawName || rawName.length > 120))
      fail("invalid_parameter", 400, "Batch name must contain 1–120 characters.");

    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          name: rawName || null,
          items: normalized.map((i) => ({
            raw: i.raw_input,
            hash: i.canonical_query_hash,
            error_code: i.error_code,
          })),
        }),
      )
      .digest("hex");

    const reservation = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "sold:read");
      const previous = (
        await c.query<{ request_hash: string; resource_id: string | null }>(
          "SELECT request_hash, resource_id FROM idempotency_records WHERE owner_scope=$1 AND operation='batch.create' AND key_hash=$2 AND expires_at>$3",
          [identity.userId, keyHash, now],
        )
      ).rows[0];
      if (previous?.resource_id) {
        if (previous.request_hash !== requestHash)
          fail("idempotency_conflict", 409, "Idempotency key was used for a different batch payload.");
        return { replayed: true as const, batchId: previous.resource_id };
      }

      const activeBatches = (
        await c.query<{ id: string }>(
          "SELECT id FROM batch_queries WHERE user_id=$1 AND status IN ('queued','running') FOR UPDATE",
          [identity.userId],
        )
      ).rows;
      for (const active of activeBatches) {
        const synced = await this.syncAndReadBatch(c, identity.userId, active.id, now);
        if (["queued", "running"].includes(synced.status)) {
          fail("state_conflict", 409, "Only one active batch per account is allowed at a time.");
        }
      }

      let estimatedMaxCredits = 0;
      for (const item of uniqueValid) {
        if (!item.normalized || !item.canonical_query_hash) continue;
        const est = await this.estimateQueryCostLocked(
          c,
          identity.userId,
          item.normalized,
          item.canonical_query_hash,
          now,
        );
        estimatedMaxCredits += est.estimated_credits;
      }

      const batchId = randomUUID();
      const batchName = rawName || `Batch ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
      await c.query(
        `INSERT INTO batch_queries(id,user_id,name,status,total_items,unique_query_count,estimated_max_credits,created_at,updated_at)
         VALUES($1,$2,$3,'queued',$4,$5,$6,$7,$7)`,
        [
          batchId,
          identity.userId,
          batchName,
          normalized.length,
          uniqueValid.length,
          estimatedMaxCredits,
          now,
        ],
      );
      await c.query(
        `INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at)
         VALUES($1,'batch.create',$2,$3,$4,'committed',$5)
         ON CONFLICT(owner_scope,operation,key_hash) DO UPDATE SET
         request_hash=excluded.request_hash,resource_id=excluded.resource_id,status='committed',expires_at=excluded.expires_at`,
        [identity.userId, keyHash, requestHash, batchId, new Date(now.getTime() + 86400000)],
      );
      return { replayed: false as const, batchId, createdAt: now };
    });

    if (reservation.replayed) {
      return { batch: await this.get(identity, reservation.batchId), replayed: true };
    }

    const submittedByPrimary = new Map<
      number,
      {
        queryId: string | null;
        jobId: string | null;
        submitStatus: "submitted" | "reused" | "failed";
        errorCode: string | null;
        errorMessage: string | null;
      }
    >();

    try {
      for (const item of uniqueValid) {
        if (!item.normalized) continue;
        try {
          const submitted = await this.query.submit(identity, item.normalized);
          submittedByPrimary.set(item.item_index, {
            queryId: submitted.queryId,
            jobId: submitted.jobId,
            submitStatus: submitted.reused ? "reused" : "submitted",
            errorCode: null,
            errorMessage: null,
          });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          submittedByPrimary.set(item.item_index, {
            queryId: null,
            jobId: null,
            submitStatus: "failed",
            errorCode: error.code,
            errorMessage: error.message,
          });
        }
      }

      const batch = await transaction(this.query.db, async (c) => {
        const now = await this.query.owner(c, identity, "sold:read");
        for (const item of normalized) {
          let outcome: {
            queryId: string | null;
            jobId: string | null;
            submitStatus: "submitted" | "reused" | "failed";
            errorCode: string | null;
            errorMessage: string | null;
          };
          if (!item.valid) {
            outcome = {
              queryId: null,
              jobId: null,
              submitStatus: "failed",
              errorCode: item.error_code ?? "invalid_parameter",
              errorMessage: item.error_message,
            };
          } else if (item.deduplicated_in_batch && item.primary_item_index !== null) {
            const primary = submittedByPrimary.get(item.primary_item_index);
            outcome = primary
              ? {
                  queryId: primary.queryId,
                  jobId: primary.jobId,
                  submitStatus: primary.submitStatus === "failed" ? "failed" : "reused",
                  errorCode: primary.errorCode,
                  errorMessage: primary.errorMessage,
                }
              : {
                  queryId: null,
                  jobId: null,
                  submitStatus: "failed",
                  errorCode: "service_unavailable",
                  errorMessage: "Primary item submission missing.",
                };
          } else {
            outcome = submittedByPrimary.get(item.item_index) ?? {
              queryId: null,
              jobId: null,
              submitStatus: "failed",
              errorCode: "service_unavailable",
              errorMessage: "Item submission missing.",
            };
          }
          await c.query(
            `INSERT INTO batch_query_items(batch_id,user_id,item_index,input_query,canonical_query_hash,deduplicated_in_batch,primary_item_index,query_id,job_id,submit_status,error_code,error_message,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              reservation.batchId,
              identity.userId,
              item.item_index,
              JSON.stringify(item.raw_input),
              item.canonical_query_hash,
              item.deduplicated_in_batch,
              item.primary_item_index,
              outcome.queryId,
              outcome.jobId,
              outcome.submitStatus,
              outcome.errorCode,
              outcome.errorMessage,
              reservation.createdAt,
            ],
          );
        }
        return this.syncAndReadBatch(c, identity.userId, reservation.batchId, now);
      });
      return { batch, replayed: false };
    } catch (error) {
      await transaction(this.query.db, async (c) => {
        const now = await this.query.now(c);
        await c.query(
          "UPDATE batch_queries SET status='failed', updated_at=$2, completed_at=$2, version=version+1 WHERE id=$1 AND status IN ('queued','running')",
          [reservation.batchId, now],
        );
      }).catch(() => {});
      throw error;
    }
  }

  async list(identity: Identity, cursor?: string, pageSize = 20) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
      fail("invalid_parameter", 400, "Page size must be 1–100.");
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "jobs:read");
      let createdAt: Date | null = null;
      let cursorId: string | null = null;
      if (cursor) {
        const parsed = /^(\d{4}-\d{2}-\d{2}T[^|]+)\|([0-9a-f-]{36})$/.exec(cursor);
        if (!parsed) throw new AppError("invalid_parameter", 400, "Invalid batch pagination cursor.");
        const date = new Date(parsed[1] ?? "");
        if (Number.isNaN(date.getTime()) || !UUID_RE.test(parsed[2] ?? ""))
          throw new AppError("invalid_parameter", 400, "Invalid batch pagination cursor.");
        createdAt = date;
        cursorId = parsed[2] ?? null;
      }

      const active = (
        await c.query<{ id: string }>(
          "SELECT id FROM batch_queries WHERE user_id=$1 AND status IN ('queued','running')",
          [identity.userId],
        )
      ).rows;
      for (const row of active) {
        await this.syncAndReadBatch(c, identity.userId, row.id, now);
      }

      const rows = (
        await c.query<BatchRow>(
          `SELECT * FROM batch_queries
           WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [identity.userId, createdAt, cursorId, pageSize + 1],
        )
      ).rows;
      const items = rows.slice(0, pageSize).map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        version: row.version,
        total_items: row.total_items,
        unique_query_count: row.unique_query_count,
        estimated_max_credits: row.estimated_max_credits,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
        completed_at: row.completed_at?.toISOString() ?? null,
        cancelled_at: row.cancelled_at?.toISOString() ?? null,
      }));
      const last = rows[pageSize - 1];
      return {
        items,
        next_cursor: rows.length > pageSize && last ? `${last.created_at.toISOString()}|${last.id}` : null,
      };
    });
  }

  async get(identity: Identity, batchId: string): Promise<BatchView> {
    if (!UUID_RE.test(batchId)) fail("invalid_parameter", 400, "Invalid batch identifier.");
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "jobs:read");
      return this.syncAndReadBatch(c, identity.userId, batchId, now);
    });
  }

  async cancel(
    identity: Identity,
    batchId: string,
    version: number,
    idempotencyKey: string | undefined,
  ): Promise<BatchView> {
    if (!UUID_RE.test(batchId)) fail("invalid_parameter", 400, "Invalid batch identifier.");
    if (!Number.isSafeInteger(version) || version < 1)
      fail("invalid_parameter", 400, "Valid batch version is required.");
    const key = requireIdempotencyKey(idempotencyKey);
    const keyHash = createHash("sha256").update(key).digest("hex");
    const requestHash = createHash("sha256").update(`${batchId}:${version}`).digest("hex");

    const targets = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "jobs:read");
      const peek = (
        await c.query<BatchRow>("SELECT * FROM batch_queries WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          batchId,
          identity.userId,
        ])
      ).rows[0];
      if (!peek) throw new AppError("not_found", 404, "Batch not found.");
      const prior = (
        await c.query<{ request_hash: string }>(
          "SELECT request_hash FROM idempotency_records WHERE owner_scope=$1 AND operation='batch.cancel' AND key_hash=$2 AND expires_at>$3",
          [identity.userId, keyHash, now],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new AppError(
            "idempotency_conflict",
            409,
            "Idempotency key was used for a different cancellation.",
          );
        return { replayed: true as const };
      }
      if (peek.version !== version) throw new AppError("state_conflict", 409, "Batch version changed.");
      if (!["queued", "running"].includes(peek.status))
        throw new AppError("state_conflict", 409, "Only active batches can be cancelled.");

      const jobs = (
        await c.query<{ job_id: string; job_version: number }>(
          `SELECT DISTINCT j.id AS job_id, j.version AS job_version
           FROM batch_query_items bqi
           JOIN query_jobs j ON j.id=bqi.job_id
           WHERE bqi.batch_id=$1 AND j.status IN ('queued','running')`,
          [batchId],
        )
      ).rows;
      return { replayed: false as const, jobs };
    });

    if (targets.replayed) return this.get(identity, batchId);

    for (const child of targets.jobs) {
      const childKey = createHash("sha256")
        .update(`batch-cancel:${batchId}:${child.job_id}:${key}`)
        .digest("hex");
      try {
        await this.query.cancel(identity, child.job_id, child.job_version, childKey);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "state_conflict") throw error;
      }
    }

    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "jobs:read");
      const batch = (
        await c.query<BatchRow>("SELECT * FROM batch_queries WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          batchId,
          identity.userId,
        ])
      ).rows[0];
      if (!batch) throw new AppError("not_found", 404, "Batch not found.");
      if (batch.version !== version) throw new AppError("state_conflict", 409, "Batch version changed.");
      await c.query(
        "UPDATE batch_queries SET cancelled_at=$2, updated_at=$2, completed_at=coalesce(completed_at,$2), status='cancelled', version=version+1 WHERE id=$1",
        [batchId, now],
      );
      await c.query(
        `INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at)
         VALUES($1,'batch.cancel',$2,$3,$4,'committed',$5)
         ON CONFLICT(owner_scope,operation,key_hash) DO UPDATE SET
         request_hash=excluded.request_hash,resource_id=excluded.resource_id,expires_at=excluded.expires_at`,
        [identity.userId, keyHash, requestHash, batchId, new Date(now.getTime() + 86400000)],
      );
      return this.syncAndReadBatch(c, identity.userId, batchId, now);
    });
  }

  /**
   * Explicitly claims completed child queries one-by-one through `QueryService.result(..., true)`
   * so settlement remains atomic, deduplicated, and free of partial double charges.
   */
  async claim(
    identity: Identity,
    batchId: string,
    input: { item_indices?: number[] },
    idempotencyKey: string | undefined,
    requestId: string,
  ) {
    if (!UUID_RE.test(batchId)) fail("invalid_parameter", 400, "Invalid batch identifier.");
    const key = requireIdempotencyKey(idempotencyKey);
    const keyHash = createHash("sha256").update(key).digest("hex");

    let normalizedSelection: number[] | null = null;
    if (input.item_indices !== undefined) {
      if (
        !Array.isArray(input.item_indices) ||
        input.item_indices.length < 1 ||
        input.item_indices.length > MAX_BATCH_ITEMS ||
        input.item_indices.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= MAX_BATCH_ITEMS)
      ) {
        fail("invalid_parameter", 400, "item_indices must contain valid batch item indices.");
      }
      normalizedSelection = [...new Set(input.item_indices)].sort((a, b) => a - b);
    }
    const requestHash = createHash("sha256")
      .update(canonicalJson({ batchId, items: normalizedSelection ?? "all" }))
      .digest("hex");

    const plan = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "sold:read");
      const current = await this.syncAndReadBatch(c, identity.userId, batchId, now);
      if (normalizedSelection?.some((idx) => idx >= current.total_items))
        fail("invalid_parameter", 400, "item_indices contains an out-of-range index.");

      const prior = (
        await c.query<{ request_hash: string }>(
          "SELECT request_hash FROM idempotency_records WHERE owner_scope=$1 AND operation='batch.claim' AND key_hash=$2 AND expires_at>$3",
          [identity.userId, keyHash, now],
        )
      ).rows[0];
      if (prior && prior.request_hash !== requestHash)
        fail("idempotency_conflict", 409, "Idempotency key was used for a different batch claim.");

      const selectedSet = normalizedSelection ? new Set(normalizedSelection) : null;
      const toClaim: { item_index: number; query_id: string }[] = [];
      const alreadyDelivered = new Set<string>();
      const seenQueries = new Set<string>();

      for (const item of current.items) {
        if (selectedSet && !selectedSet.has(item.item_index)) continue;
        if (!item.query_id || seenQueries.has(item.query_id)) continue;
        seenQueries.add(item.query_id);
        if (item.status === "delivered") {
          alreadyDelivered.add(item.query_id);
        } else if (item.status === "ready_to_claim") {
          toClaim.push({ item_index: item.item_index, query_id: item.query_id });
        }
      }

      await c.query(
        `INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at)
         VALUES($1,'batch.claim',$2,$3,$4,'committed',$5)
         ON CONFLICT(owner_scope,operation,key_hash) DO UPDATE SET
         request_hash=excluded.request_hash,resource_id=excluded.resource_id,expires_at=excluded.expires_at`,
        [identity.userId, keyHash, requestHash, batchId, new Date(now.getTime() + 86400000)],
      );

      return { toClaim, alreadyDelivered: [...alreadyDelivered] };
    });

    const claimedQueryIds: string[] = [];
    const failedItems: { item_index: number; query_id: string; code: string; message: string }[] = [];
    let creditsChargedNow = 0;

    for (const target of plan.toClaim) {
      const derivedKey = createHash("sha256")
        .update(`batch-claim:${batchId}:${target.query_id}:${key}`)
        .digest("hex");
      try {
        const res = await this.query.result(identity, target.query_id, requestId, true, derivedKey);
        claimedQueryIds.push(target.query_id);
        creditsChargedNow += res.meta.credits_charged;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        failedItems.push({
          item_index: target.item_index,
          query_id: target.query_id,
          code: error.code,
          message: error.message,
        });
      }
    }

    const batch = await this.get(identity, batchId);
    return {
      batch,
      claimed_query_ids: claimedQueryIds,
      already_delivered_query_ids: plan.alreadyDelivered,
      failed_items: failedItems,
      credits_charged_now: creditsChargedNow,
      batch_total_credits_charged: batch.total_credits_charged,
    };
  }

  async export(identity: Identity, batchId: string, format: "csv" | "json") {
    if (!["csv", "json"].includes(format))
      fail("invalid_parameter", 400, "Export format must be csv or json.");
    if (!UUID_RE.test(batchId)) fail("invalid_parameter", 400, "Invalid batch identifier.");

    const { batch, exportedAt } = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "sold:read");
      const view = await this.syncAndReadBatch(c, identity.userId, batchId, now);
      // Verify current query-level permissions cleanly inside transaction before export serialization
      for (const item of view.items) {
        if (item.query_id && item.status === "delivered" && !item.rights_unavailable) {
          const policy = await permissions(c, item.query_id);
          if (!policy.size) {
            item.stats = null;
            item.rights_unavailable = true;
          }
        }
      }
      return { batch: view, exportedAt: now.toISOString() };
    });

    const filename = `soldbench-batch-${batchId}.${format}`;
    if (format === "json") {
      return {
        body: JSON.stringify(
          {
            data_mode: "synthetic_fixture",
            exported_at: exportedAt,
            batch,
          },
          null,
          2,
        ),
        contentType: "application/json; charset=utf-8",
        filename,
      };
    }

    const header = [
      "item_index",
      "q",
      "category",
      "brand",
      "model",
      "condition",
      "window_days",
      "price_basis",
      "deduplicated_in_batch",
      "primary_item_index",
      "status",
      "query_id",
      "rights_unavailable",
      "credits_charged",
      "freshness_state",
      "data_as_of",
      "n_price_verified",
      "median_cents",
      "p25_cents",
      "p75_cents",
      "error_code",
    ];
    const rows = batch.items.map((item) => {
      const q = item.input_query;
      return [
        item.item_index,
        q.q ?? "",
        q.category ?? "",
        q.brand ?? "",
        q.model ?? "",
        q.condition ?? "",
        q.window_days ?? "",
        q.price_basis ?? "",
        item.deduplicated_in_batch,
        item.primary_item_index ?? "",
        item.status,
        item.query_id ?? "",
        item.rights_unavailable,
        item.credits_charged,
        item.freshness_state ?? "",
        item.data_as_of ?? "",
        item.stats?.n_price_verified ?? "",
        item.stats?.median_cents ?? "",
        item.stats?.p25_cents ?? "",
        item.stats?.p75_cents ?? "",
        item.error_code ?? "",
      ]
        .map((cell) => csv(cell))
        .join(",");
    });
    return {
      body: `${header.join(",")}\r\n${rows.join("\r\n")}\r\n`,
      contentType: "text/csv; charset=utf-8",
      filename,
    };
  }
}
