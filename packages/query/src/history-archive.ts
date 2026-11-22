import type { Identity } from "@soldbench/auth";
import {
  applyStrongFilters,
  type Candidate,
  collectionQueryHash,
  distribution,
  hasStrongFilters,
  isStandardCondition,
  normalizeQuery,
  priceQualification,
  type SoldQuery,
} from "@soldbench/core";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError, VERSIONS } from "@soldbench/shared";
import type { QueryService } from "./index.ts";
import { csv, type ResearchField, researchFields, saleDateEvidence } from "./research.ts";

export const MAX_HISTORY_WINDOW_DAYS = 1095;
export const HISTORY_STANDARD_WINDOWS = [30, 90, 180, 365, 730, 1095] as const;
const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SpanRow = {
  id: string;
  source_id: string;
  query_hash: string;
  collector_run_id: string;
  permission_epoch: string | number;
  window_start: Date;
  window_end: Date;
  retention_until: Date;
  completeness: "complete" | "partial";
  observed_event_count: number;
  multi_unit_listing_row_count: number;
  permitted_fields: { research?: unknown } | null;
};

type ArchiveEventRow = {
  sale_event_id: string;
  listing_id: string;
  observation_id: string;
  source_id: string;
  sold_at: Date | null;
  listing_aggregation_kind: "single_sale" | "multi_unit_listing_average" | "listing_summary_only";
  candidate: Candidate;
  external_listing_id: string;
  strong_attributes: Record<string, string> | null;
  standard_condition: string | null;
  has_record_evidence: boolean;
  image_id: string | null;
  image_state: string | null;
  image_retention_until: Date | null;
  image_epoch: string | number | null;
  source_epoch: string | number;
  media_store_identity: string | null;
  image_width: number | null;
  image_height: number | null;
  owner_delivered_query: boolean;
};

export type MergedSpan = {
  startMs: number;
  endMs: number;
  completeness: "complete" | "partial";
};

export type HistoryGap = {
  start: string;
  end: string;
};

export type HistoryGranularity = "day" | "week" | "month";

export type HistoryBucket = {
  start: string;
  end: string;
  observation_coverage: "complete" | "partial" | "missing";
  sample_count: number;
  median_cents: number | null;
  p25_cents: number | null;
  p75_cents: number | null;
  trimmed_mean_cents: number | null;
};

function parseUtcBound(raw: string, bound: "from" | "to"): number {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
      throw new AppError("invalid_parameter", 400, `Invalid ${bound}_date calendar value.`);
    }
    return bound === "from"
      ? Date.UTC(year, month - 1, day, 0, 0, 0, 0)
      : Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(raw)) {
    throw new AppError(
      "invalid_parameter",
      400,
      `Invalid ${bound}_date format; use UTC ISO8601 or YYYY-MM-DD.`,
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new AppError("invalid_parameter", 400, `Invalid ${bound}_date.`);
  return ms;
}

function mergeSpans(spans: readonly SpanRow[]): MergedSpan[] {
  if (!spans.length) return [];
  const sorted = [...spans]
    .map((s) => ({
      startMs: s.window_start.getTime(),
      endMs: s.window_end.getTime(),
      completeness: s.completeness,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const first = sorted[0];
  if (!first) return [];
  const merged: MergedSpan[] = [{ ...first }];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const cur = merged[merged.length - 1];
    if (!next || !cur) continue;
    if (next.startMs <= cur.endMs) {
      cur.endMs = Math.max(cur.endMs, next.endMs);
      if (next.completeness === "partial") cur.completeness = "partial";
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

function computeGaps(reqStartMs: number, reqEndMs: number, merged: readonly MergedSpan[]): HistoryGap[] {
  const gaps: HistoryGap[] = [];
  let cursor = reqStartMs;
  for (const span of merged) {
    if (span.endMs <= cursor) continue;
    if (span.startMs >= reqEndMs) break;
    if (span.startMs > cursor) {
      gaps.push({
        start: new Date(cursor).toISOString(),
        end: new Date(Math.min(span.startMs, reqEndMs)).toISOString(),
      });
    }
    cursor = Math.max(cursor, Math.min(span.endMs, reqEndMs));
    if (cursor >= reqEndMs) break;
  }
  if (cursor < reqEndMs) {
    gaps.push({
      start: new Date(cursor).toISOString(),
      end: new Date(reqEndMs).toISOString(),
    });
  }
  return gaps;
}

function bucketCoverage(
  bStartMs: number,
  bEndMs: number,
  merged: readonly MergedSpan[],
): "complete" | "partial" | "missing" {
  let coveredMs = 0;
  let hasPartialSpan = false;
  for (const span of merged) {
    if (span.endMs <= bStartMs) continue;
    if (span.startMs >= bEndMs) break;
    const overlapStart = Math.max(bStartMs, span.startMs);
    const overlapEnd = Math.min(bEndMs, span.endMs);
    if (overlapEnd > overlapStart) {
      coveredMs += overlapEnd - overlapStart;
      if (span.completeness === "partial") hasPartialSpan = true;
    }
  }
  if (coveredMs === 0) return "missing";
  if (!hasPartialSpan && coveredMs >= bEndMs - bStartMs) return "complete";
  return "partial";
}

function advanceMonthUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

function parseResearchPermissions(raw: unknown): Set<ResearchField> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.filter(
      (v): v is ResearchField => typeof v === "string" && researchFields.includes(v as ResearchField),
    ),
  );
}

/**
 * Queries approved historical archive coverage and gap-aware price history (`/v1/history*`)
 * while strictly isolating single-sale evidence from multi-unit listing averages and revoked sources.
 */
export class ArchiveHistoryService {
  constructor(private readonly query: QueryService) {}

  private parseFilterParams(params: URLSearchParams): {
    soldQuery: SoldQuery;
    collectionHash: string;
    windowDaysInput: number | null;
    fromDateRaw: string | null;
    toDateRaw: string | null;
    allowPartial: boolean;
    granularity: HistoryGranularity | null;
    pageSize: number;
    cursor?: string;
  } {
    const historyKeys = new Set([
      "window_days",
      "from_date",
      "to_date",
      "allow_partial",
      "granularity",
      "page_size",
      "cursor",
    ]);
    for (const key of params.keys()) {
      if (params.getAll(key).length !== 1)
        throw new AppError("invalid_parameter", 400, `Repeated query parameter: ${key}.`);
    }

    const filterParams = new URLSearchParams();
    for (const [k, v] of params.entries()) {
      if (!historyKeys.has(k)) filterParams.set(k, v);
    }
    const rawWindow = params.get("window_days");
    const fromDateRaw = params.get("from_date");
    const toDateRaw = params.get("to_date");

    if (rawWindow !== null && (fromDateRaw !== null || toDateRaw !== null)) {
      throw new AppError("invalid_parameter", 400, "Specify either window_days or from_date/to_date.");
    }
    if ((fromDateRaw === null) !== (toDateRaw === null)) {
      throw new AppError("invalid_parameter", 400, "Both from_date and to_date are required together.");
    }

    let windowDaysInput: number | null = null;
    if (rawWindow !== null) {
      if (!/^\d+$/.test(rawWindow))
        throw new AppError("invalid_parameter", 400, "window_days must be a positive integer.");
      windowDaysInput = Number(rawWindow);
      if (
        !Number.isSafeInteger(windowDaysInput) ||
        windowDaysInput < 1 ||
        windowDaysInput > MAX_HISTORY_WINDOW_DAYS
      ) {
        throw new AppError(
          "unsupported_window",
          422,
          `History requests are bounded between 1 and ${MAX_HISTORY_WINDOW_DAYS} days.`,
        );
      }
    }

    const allowPartialRaw = params.get("allow_partial") ?? "false";
    if (!["true", "false"].includes(allowPartialRaw))
      throw new AppError("invalid_parameter", 400, "allow_partial must be true or false.");

    const rawGranularity = params.get("granularity");
    if (rawGranularity !== null && !["day", "week", "month"].includes(rawGranularity))
      throw new AppError("invalid_parameter", 400, "granularity must be day, week, or month.");

    const rawSize = params.get("page_size") ?? "20";
    if (!/^\d+$/.test(rawSize) || Number(rawSize) < 1 || Number(rawSize) > 100)
      throw new AppError("invalid_parameter", 400, "page_size must be between 1 and 100.");

    // Reuse canonical normalizer on supported base shape (default window_days=90 to derive collectionQueryHash).
    const soldQuery = normalizeQuery(filterParams, [30, 90, 180, 365]);
    const collectionHash = collectionQueryHash(soldQuery);

    return {
      soldQuery,
      collectionHash,
      windowDaysInput,
      fromDateRaw,
      toDateRaw,
      allowPartial: allowPartialRaw === "true",
      granularity: rawGranularity as HistoryGranularity | null,
      pageSize: Number(rawSize),
      cursor: params.get("cursor") ?? undefined,
    };
  }

  private async loadAuthorizedSpansLocked(c: Transaction, collectionHash: string, now: Date) {
    return (
      await c.query<SpanRow>(
        `SELECT acs.*, x.permitted_fields
         FROM archive_coverage_spans acs
         JOIN sources s ON s.id=acs.source_id
         JOIN source_clearances x ON x.id=s.source_clearance_id
         WHERE acs.query_hash=$1
           AND s.marketplace='ebay_us'
           AND s.access_method='offline_fixture'
           AND s.status='active'
           AND s.permission_epoch=acs.permission_epoch
           AND x.provider='synthetic_fixture'
           AND x.status IN ('draft','reviewed','active')
           AND (x.effective_at IS NULL OR x.effective_at<=$2)
           AND (x.expires_at IS NULL OR x.expires_at>$2)
           AND acs.retention_until>$2
         ORDER BY acs.window_start ASC, acs.id ASC`,
        [collectionHash, now],
      )
    ).rows;
  }

  private summarizeCoverage(spans: readonly SpanRow[], now: Date) {
    const merged = mergeSpans(spans);
    const earliest = merged[0]?.startMs ?? null;
    const latest = merged[merged.length - 1]?.endMs ?? null;
    const retainedMs = merged.reduce((sum, s) => sum + Math.max(0, s.endMs - s.startMs), 0);
    const actualRetainedDays = Number((retainedMs / DAY_MS).toFixed(2));
    const missingGaps = earliest !== null && latest !== null ? computeGaps(earliest, latest, merged) : [];

    // Supported standard windows are ONLY those continuously covered (completeness='complete') up to latest!
    const supportedWindows =
      latest !== null
        ? HISTORY_STANDARD_WINDOWS.filter((days) => {
            const winStart = latest - days * DAY_MS;
            if (!earliest || earliest > winStart) return false;
            return (
              computeGaps(winStart, latest, merged).length === 0 &&
              bucketCoverage(winStart, latest, merged) === "complete"
            );
          })
        : [];

    const totalObservedEvents = spans.reduce((s, r) => s + r.observed_event_count, 0);
    const excludedMultiUnitRows = spans.reduce((s, r) => s + r.multi_unit_listing_row_count, 0);
    const earliestIso = earliest !== null ? new Date(earliest).toISOString() : null;
    const latestIso = latest !== null ? new Date(latest).toISOString() : null;
    return {
      merged,
      evaluated_at: now.toISOString(),
      earliest_covered_at: earliestIso,
      latest_covered_at: latestIso,
      actual_retained_days: actualRetainedDays,
      supported_history_windows: supportedWindows,
      covered_spans: merged.map((s) => ({
        start: new Date(s.startMs).toISOString(),
        end: new Date(s.endMs).toISOString(),
        completeness: s.completeness,
      })),
      missing_gaps: missingGaps,
      total_observed_events: totalObservedEvents,
      excluded_multi_unit_rows: excludedMultiUnitRows,
    };
  }

  /**
   * 0-credit read of real retained historical coverage spans, internal gaps, and supported windows.
   */
  async coverage(identity: Identity, params: URLSearchParams) {
    const parsed = this.parseFilterParams(params);
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "sold:read");
      const spans = await this.loadAuthorizedSpansLocked(c, parsed.collectionHash, now);
      const summary = this.summarizeCoverage(spans, now);
      return {
        query_hash: parsed.collectionHash,
        marketplace: "ebay_us" as const,
        evaluated_at: summary.evaluated_at,
        earliest_covered_at: summary.earliest_covered_at,
        latest_covered_at: summary.latest_covered_at,
        actual_retained_days: summary.actual_retained_days,
        supported_history_windows: summary.supported_history_windows,
        covered_spans: summary.covered_spans,
        missing_gaps: summary.missing_gaps,
        total_observed_events: summary.total_observed_events,
        excluded_multi_unit_rows: summary.excluded_multi_unit_rows,
        data_mode: "synthetic_fixture" as const,
      };
    });
  }

  private async evaluateHistoryLocked(
    c: Transaction,
    identity: Identity,
    params: URLSearchParams,
    now: Date,
  ) {
    const parsed = this.parseFilterParams(params);
    const spans = await this.loadAuthorizedSpansLocked(c, parsed.collectionHash, now);
    const coverageSummary = this.summarizeCoverage(spans, now);

    let reqStartMs: number;
    let reqEndMs: number;
    if (parsed.fromDateRaw && parsed.toDateRaw) {
      reqStartMs = parseUtcBound(parsed.fromDateRaw, "from");
      reqEndMs = parseUtcBound(parsed.toDateRaw, "to");
      if (reqEndMs <= reqStartMs)
        throw new AppError("invalid_parameter", 400, "to_date must be later than from_date.");
      if (reqEndMs - reqStartMs > MAX_HISTORY_WINDOW_DAYS * DAY_MS) {
        throw new AppError(
          "unsupported_window",
          422,
          `History date range cannot exceed ${MAX_HISTORY_WINDOW_DAYS} days.`,
        );
      }
    } else {
      const days = parsed.windowDaysInput ?? 90;
      reqEndMs = now.getTime();
      reqStartMs = reqEndMs - days * DAY_MS;
    }

    const overlapping = coverageSummary.merged.filter((s) => s.endMs > reqStartMs && s.startMs < reqEndMs);
    const windowGaps = computeGaps(reqStartMs, reqEndMs, coverageSummary.merged);
    if (!overlapping.length) {
      throw new AppError("unsupported_window", 422, "No approved historical archive covers this window.", {
        coverage_status: "none",
        earliest_covered_at: coverageSummary.earliest_covered_at,
        latest_covered_at: coverageSummary.latest_covered_at,
        actual_retained_days: coverageSummary.actual_retained_days,
        missing_gaps: windowGaps,
      });
    }

    const isComplete = windowGaps.length === 0 && overlapping.every((s) => s.completeness === "complete");
    const windowStatus: "complete" | "partial" = isComplete ? "complete" : "partial";
    if (!isComplete && !parsed.allowPartial) {
      throw new AppError(
        "unsupported_window",
        422,
        "Requested window exceeds continuous approved historical coverage.",
        {
          coverage_status: "partial",
          earliest_covered_at: coverageSummary.earliest_covered_at,
          latest_covered_at: coverageSummary.latest_covered_at,
          actual_retained_days: coverageSummary.actual_retained_days,
          missing_gaps: windowGaps,
        },
      );
    }

    // Load all distinct sale_events recorded under currently authorized spans in [reqStartMs, reqEndMs]
    const reqStart = new Date(reqStartMs);
    const reqEnd = new Date(reqEndMs);
    const runIds = [...new Set(spans.map((s) => s.collector_run_id))];
    const rows = (
      await c.query<ArchiveEventRow>(
        `SELECT DISTINCT ON (se.id)
           se.id AS sale_event_id,
           se.listing_id,
           se.observation_id,
           se.source_id,
           se.sold_at,
           se.listing_aggregation_kind,
           see.candidate,
           see.external_listing_id,
           CASE WHEN lre.evidence #>> '{fields,attributes}'='present' THEN lre.evidence->'attributes' END AS strong_attributes,
           CASE WHEN lre.evidence->>'schema'='soldbench.record-evidence.v2'
             AND lre.evidence #>> '{fields,condition}'='present' THEN lre.evidence->>'conditionStandard' END AS standard_condition,
           (lre.sale_event_id IS NOT NULL) AS has_record_evidence,
           li.id AS image_id,
           li.state AS image_state,
           li.retention_until AS image_retention_until,
           li.permission_epoch AS image_epoch,
           src.permission_epoch AS source_epoch,
           src.media_store_identity,
           li.width AS image_width,
           li.height AS image_height,
           EXISTS(
             SELECT 1 FROM queries q
             JOIN query_snapshot_records qsr ON qsr.query_id=q.id
             WHERE q.user_id=$5 AND q.result_state='available'
               AND qsr.sale_event_id=se.id AND qsr.observation_id=se.observation_id
               AND qsr.listing_id=se.listing_id AND qsr.source_id=se.source_id
           ) AS owner_delivered_query
         FROM collector_pages p
         JOIN collector_jobs cj ON cj.id=p.job_id
         JOIN sale_event_evidence see ON see.observation_id=p.observation_id AND see.source_id=p.source_id
         JOIN sale_events se ON se.id=see.sale_event_id
         JOIN sources src ON src.id=se.source_id
         LEFT JOIN listing_record_evidence lre ON (lre.sale_event_id,lre.listing_id,lre.source_id,lre.observation_id)=(se.id,se.listing_id,se.source_id,se.observation_id)
         LEFT JOIN listing_images li ON li.sale_event_id=se.id AND li.observation_id=se.observation_id AND li.listing_id=se.listing_id AND li.source_id=se.source_id AND li.role='primary'
         WHERE cj.collector_run_id=ANY($1::uuid[])
           AND cj.query_hash=$2
           AND se.sold_at IS NOT NULL
           AND se.sold_at>=$3
           AND se.sold_at<=$4
         ORDER BY se.id, p.page_as_of DESC`,
        [runIds, parsed.collectionHash, reqStart, reqEnd, identity.userId],
      )
    ).rows;

    const policyBySource = new Map<string, Set<ResearchField>>();
    for (const s of spans) {
      if (!policyBySource.has(s.source_id)) {
        policyBySource.set(s.source_id, parseResearchPermissions(s.permitted_fields?.research));
      }
    }

    let excludedMultiUnitCount = 0;
    let rightsWithheldCount = 0;
    const singleSales: {
      row: ArchiveEventRow;
      candidate: Candidate;
      priceCents: number;
      allowed: Set<ResearchField>;
      soldAtMs: number;
    }[] = [];

    const checkStrong = hasStrongFilters(parsed.soldQuery);
    for (const row of rows) {
      const candidateKind = row.candidate.listingAggregationKind ?? row.listing_aggregation_kind;
      if (row.listing_aggregation_kind !== "single_sale" || candidateKind !== "single_sale") {
        excludedMultiUnitCount++;
        continue;
      }
      const allowed = policyBySource.get(row.source_id);
      if (
        !allowed ||
        !["identity", "price", "shipping", "sold_date"].every((f) => allowed.has(f as ResearchField))
      ) {
        rightsWithheldCount++;
        continue;
      }

      let candidate: Candidate = { ...row.candidate, sourceId: row.source_id };
      if (checkStrong) {
        candidate = applyStrongFilters(
          parsed.soldQuery,
          candidate,
          row.has_record_evidence
            ? {
                ...(row.strong_attributes ? { attributes: row.strong_attributes } : {}),
                conditionStandard: row.standard_condition,
              }
            : null,
        );
      }
      if (!candidate.identityVerified || !candidate.eventKey || !candidate.comparable) continue;
      if (parsed.soldQuery.sale_format && candidate.format !== parsed.soldQuery.sale_format) continue;

      const priceDecision = priceQualification(candidate, parsed.soldQuery.price_basis);
      if (priceDecision.priceCents === null) continue;
      if (
        parsed.soldQuery.min_price_cents !== undefined &&
        priceDecision.priceCents < parsed.soldQuery.min_price_cents
      )
        continue;
      if (
        parsed.soldQuery.max_price_cents !== undefined &&
        priceDecision.priceCents > parsed.soldQuery.max_price_cents
      )
        continue;

      const soldAtMs = row.sold_at?.getTime();
      if (!soldAtMs) continue;
      singleSales.push({ row, candidate, priceCents: priceDecision.priceCents, allowed, soldAtMs });
    }

    // Aggregate statistics (reusing @soldbench/core distribution with <8 null median)
    const overallPrices = singleSales.map((s) => s.priceCents);
    const dist = distribution(overallPrices);
    const spanDays = Math.ceil((reqEndMs - reqStartMs) / DAY_MS);
    const granularity: HistoryGranularity =
      parsed.granularity ?? (spanDays <= 45 ? "day" : spanDays <= 365 ? "week" : "month");

    const buckets: HistoryBucket[] = [];
    if (granularity === "month") {
      let curStart = reqStartMs;
      while (curStart < reqEndMs) {
        const nextBoundary = Math.min(advanceMonthUtc(curStart), reqEndMs);
        const cov = bucketCoverage(curStart, nextBoundary, coverageSummary.merged);
        const slice = singleSales
          .filter(
            (s) =>
              s.soldAtMs >= curStart &&
              s.soldAtMs < (nextBoundary === reqEndMs ? reqEndMs + 1 : nextBoundary),
          )
          .map((s) => s.priceCents);
        const bDist = distribution(slice);
        buckets.push({
          start: new Date(curStart).toISOString(),
          end: new Date(nextBoundary).toISOString(),
          observation_coverage: cov,
          sample_count: slice.length,
          median_cents: cov === "missing" && slice.length === 0 ? null : bDist.median_cents,
          p25_cents: cov === "missing" && slice.length === 0 ? null : bDist.p25_cents,
          p75_cents: cov === "missing" && slice.length === 0 ? null : bDist.p75_cents,
          trimmed_mean_cents: cov === "missing" && slice.length === 0 ? null : bDist.trimmed_mean_cents,
        });
        curStart = nextBoundary;
      }
    } else {
      const stepMs = granularity === "day" ? DAY_MS : 7 * DAY_MS;
      for (let curStart = reqStartMs; curStart < reqEndMs; curStart += stepMs) {
        const curEnd = Math.min(curStart + stepMs, reqEndMs);
        const cov = bucketCoverage(curStart, curEnd, coverageSummary.merged);
        const slice = singleSales
          .filter((s) => s.soldAtMs >= curStart && s.soldAtMs < (curEnd === reqEndMs ? reqEndMs + 1 : curEnd))
          .map((s) => s.priceCents);
        const bDist = distribution(slice);
        buckets.push({
          start: new Date(curStart).toISOString(),
          end: new Date(curEnd).toISOString(),
          observation_coverage: cov,
          sample_count: slice.length,
          median_cents: cov === "missing" && slice.length === 0 ? null : bDist.median_cents,
          p25_cents: cov === "missing" && slice.length === 0 ? null : bDist.p25_cents,
          p75_cents: cov === "missing" && slice.length === 0 ? null : bDist.p75_cents,
          trimmed_mean_cents: cov === "missing" && slice.length === 0 ? null : bDist.trimmed_mean_cents,
        });
      }
    }

    // Sort verified single sales DESC by (sold_at, sale_event_id) for cursor pagination
    const sortedSales = [...singleSales].sort(
      (a, b) => b.soldAtMs - a.soldAtMs || b.row.sale_event_id.localeCompare(a.row.sale_event_id),
    );

    const cursorKind = `history:${parsed.collectionHash}:${reqStart.toISOString()}:${reqEnd.toISOString()}:${parsed.soldQuery.price_basis}:${parsed.soldQuery.sale_format ?? "*"}:${parsed.soldQuery.min_price_cents ?? ""}:${parsed.soldQuery.max_price_cents ?? ""}`;
    const after = this.query.readCursor(identity.userId, cursorKind, parsed.cursor);
    const paginatedAll = after
      ? sortedSales.filter((entry) => {
          const afterMs = Date.parse(after.time);
          if (entry.soldAtMs < afterMs) return true;
          if (entry.soldAtMs > afterMs) return false;
          return entry.row.sale_event_id < after.id;
        })
      : sortedSales;

    const pageItems = paginatedAll.slice(0, parsed.pageSize);
    const hasMore = paginatedAll.length > parsed.pageSize;
    const last = pageItems[pageItems.length - 1];
    const storageIdentity = pageItems.some((i) => i.row.image_state === "available")
      ? await this.query.media.storageIdentity().catch(() => null)
      : null;

    const toCursorTime = (ms: number) => {
      const iso = new Date(ms).toISOString();
      return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000Z`;
    };

    const items = pageItems.map(({ row, candidate, priceCents, allowed }) => {
      let imageView: { state: string; url: string | null; width: number | null; height: number | null } = {
        state: "missing",
        url: null,
        width: null,
        height: null,
      };
      if (row.image_id) {
        if (!allowed.has("primary_image")) {
          imageView = { state: "not_permitted", url: null, width: null, height: null };
        } else {
          let state = row.image_state ?? "missing";
          if (state === "available") {
            if (String(row.image_epoch) !== String(row.source_epoch)) state = "revoked";
            else if (!row.image_retention_until || row.image_retention_until <= now) state = "expired";
            else if (
              !storageIdentity ||
              (row.media_store_identity && row.media_store_identity !== storageIdentity)
            )
              state = "missing";
          }
          const serveUrl = state === "available" && row.owner_delivered_query;
          imageView = {
            state,
            url: serveUrl ? `/v1/media/${row.image_id}` : null,
            width: serveUrl ? row.image_width : null,
            height: serveUrl ? row.image_height : null,
          };
        }
      }

      const rawCondition = row.standard_condition ?? candidate.condition;
      return {
        sale_event_id: row.sale_event_id,
        source_id: row.source_id,
        title: allowed.has("title") ? (candidate.title ?? null) : null,
        condition_std: allowed.has("condition") && isStandardCondition(rawCondition) ? rawCondition : null,
        sale_format: candidate.format,
        price_usd_cents: priceCents,
        item_price_cents:
          candidate.currency === "USD" ? candidate.itemCents : (candidate.usdConversion?.itemCents ?? null),
        observed_shipping_cents: candidate.shippingCents,
        sold_at: row.sold_at?.toISOString() ?? null,
        sold_date: saleDateEvidence(candidate.time),
        primary_image: imageView,
      };
    });

    const nextCursor =
      hasMore && last
        ? this.query.makeCursor(identity.userId, cursorKind, {
            id: last.row.sale_event_id,
            cursor_at: toCursorTime(last.soldAtMs),
          })
        : null;

    return {
      parsed,
      reqStart,
      reqEnd,
      granularity,
      coverageStatus: windowStatus,
      coverageSummary,
      windowGaps,
      excludedMultiUnitCount,
      rightsWithheldCount,
      sortedSales,
      dist,
      buckets,
      items,
      nextCursor,
    };
  }

  /**
   * 0-credit research search over approved retained archive events with explicit gap/partial declarations.
   */
  async search(identity: Identity, params: URLSearchParams) {
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "sold:read");
      const res = await this.evaluateHistoryLocked(c, identity, params, now);
      return {
        data: {
          query_hash: res.parsed.collectionHash,
          query: res.parsed.soldQuery,
          requested_window: {
            start: res.reqStart.toISOString(),
            end: res.reqEnd.toISOString(),
          },
          coverage_status: res.coverageStatus,
          earliest_covered_at: res.coverageSummary.earliest_covered_at,
          latest_covered_at: res.coverageSummary.latest_covered_at,
          actual_retained_days: res.coverageSummary.actual_retained_days,
          supported_history_windows: res.coverageSummary.supported_history_windows,
          missing_gaps: res.windowGaps,
          excluded_multi_unit_count: res.excludedMultiUnitCount,
          rights_withheld_count: res.rightsWithheldCount,
          stats: {
            n_price_verified: res.sortedSales.length,
            data_insufficient: res.sortedSales.length < 8,
            median_cents: res.dist.median_cents,
            p25_cents: res.dist.p25_cents,
            p75_cents: res.dist.p75_cents,
            trimmed_mean_cents: res.dist.trimmed_mean_cents,
          },
          time_series: {
            granularity: res.granularity,
            timezone: "UTC" as const,
            buckets: res.buckets,
          },
          items: res.items,
          next_cursor: res.nextCursor,
        },
        meta: {
          evaluated_at: now.toISOString(),
          data_mode: "synthetic_fixture" as const,
          engine_version: VERSIONS.engine,
          cleaner_version: VERSIONS.cleaner,
          normalizer_version: VERSIONS.normalizer,
        },
      };
    });
  }

  /**
   * Export authorized historical archive records & gap coverage as formula-safe CSV or JSON (0 credits).
   */
  async export(identity: Identity, params: URLSearchParams, format: "csv" | "json") {
    if (!["csv", "json"].includes(format))
      throw new AppError("invalid_parameter", 400, "Export format must be csv or json.");
    if (params.has("page_size")) params.delete("page_size");
    params.set("page_size", "100");

    const data = await this.search(identity, params);
    const filename = `soldbench-history-${data.data.query_hash.slice(0, 8)}.${format}`;
    if (format === "json") {
      return {
        body: JSON.stringify(data, null, 2),
        contentType: "application/json; charset=utf-8",
        filename,
      };
    }

    const header = [
      "query_hash",
      "coverage_status",
      "window_start",
      "window_end",
      "excluded_multi_unit_count",
      "sale_event_id",
      "title",
      "condition_std",
      "sale_format",
      "price_usd_cents",
      "sold_at",
      "primary_image_state",
    ];
    const rows = data.data.items.map((item) =>
      [
        data.data.query_hash,
        data.data.coverage_status,
        data.data.requested_window.start,
        data.data.requested_window.end,
        data.data.excluded_multi_unit_count,
        item.sale_event_id,
        item.title ?? "",
        item.condition_std ?? "",
        item.sale_format,
        item.price_usd_cents,
        item.sold_at ?? "",
        item.primary_image.state,
      ]
        .map((cell) => csv(cell))
        .join(","),
    );
    return {
      body: `${header.join(",")}\r\n${rows.join("\r\n")}\r\n`,
      contentType: "text/csv; charset=utf-8",
      filename,
    };
  }
}

export { UUID_RE };
