import { createHash } from "node:crypto";
import type { Identity } from "@soldbench/auth";
import {
  type Candidate,
  canonicalJson,
  comparisonScope,
  evaluateSnapshot,
  isStandardCondition,
  type SoldQuery,
} from "@soldbench/core";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError, VERSIONS } from "@soldbench/shared";
import type { QueryService } from "./index.ts";
import { qualityReport } from "./quality-report.ts";
import {
  allSourcesAllow,
  canPrice,
  observedShippingCents,
  permissions,
  saleDateEvidence,
} from "./research.ts";

export const MAX_BEST_OFFER_VERIFY_ITEMS = 10;
export const MAX_BEST_OFFER_ATTEMPTS = 3;
export const DEFAULT_BEST_OFFER_TTL_MINUTES = 30;
export const BEST_OFFER_CREDIT_POLICY = "included_post_lookup_zero_credit" as const;

export type BestOfferVerificationStatus =
  | "pending"
  | "verified"
  | "not_available"
  | "expired"
  | "source_blocked";

export type BestOfferTransportOutcome =
  | {
      kind: "verified";
      verifiedPriceCents: number;
      currency?: string;
      verifiedPriceUsdCents?: number;
      evidenceKind: string;
      evidenceRef: string;
    }
  | { kind: "not_available"; reason: string }
  | { kind: "retryable"; reason: string }
  | { kind: "source_blocked"; httpStatus: 401 | 403; reason: string };

export interface BestOfferVerifierTransport {
  readonly kind: "memory_fixture" | string;
  verify(input: {
    queryId: string;
    sourceId: string;
    saleEventId: string;
    listingId: string;
    observationId: string;
    externalListingId: string;
    displayedPriceCents: number | null;
    currency: string;
    attempt: number;
  }): Promise<BestOfferTransportOutcome>;
}

export type RequestVerificationInput = {
  sale_event_ids?: string[];
  ttl_minutes?: number;
  max_items?: number;
};

type VerificationRow = {
  id: string;
  query_id: string;
  user_id: string;
  source_id: string;
  sale_event_id: string;
  listing_id: string;
  observation_id: string;
  external_listing_id: string;
  currency: string;
  status: BestOfferVerificationStatus;
  attempts: number;
  max_attempts: number;
  verified_price_cents: string | number | null;
  verified_price_usd_cents: string | number | null;
  evidence_kind: string | null;
  evidence_ref: string | null;
  evidence_hash: string | null;
  failure_reason: string | null;
  credit_policy: typeof BEST_OFFER_CREDIT_POLICY;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
};

type RevisionRow = {
  id: string;
  query_id: string;
  user_id: string;
  revision_number: number;
  parent_revision_number: number | null;
  trigger_kind: "delivered_baseline" | "best_offer_verification";
  candidate_set_hash: string;
  engine_version: string;
  cleaner_version: string;
  verified_offer_count: number;
  pending_offer_count: number;
  not_available_offer_count: number;
  stats: Record<string, unknown>;
  quality: Record<string, unknown>;
  records: unknown[];
  source_verifications: unknown[];
  credits_charged: number;
  created_at: Date;
};

function mustRow<T>(row: T | undefined, code: string): T {
  if (!row) throw new Error(code);
  return row;
}

function serializeVerification(row: VerificationRow) {
  return {
    id: row.id,
    sale_event_id: row.sale_event_id,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    verified_price_cents: row.verified_price_cents === null ? null : Number(row.verified_price_cents),
    verified_price_usd_cents:
      row.verified_price_usd_cents === null ? null : Number(row.verified_price_usd_cents),
    currency: row.currency,
    evidence_kind: row.evidence_kind,
    evidence_ref: row.evidence_ref,
    evidence_hash: row.evidence_hash,
    failure_reason: row.failure_reason,
    credit_policy: row.credit_policy,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    verified_at: row.verified_at ? row.verified_at.toISOString() : null,
  };
}

function serializeRevision(row: RevisionRow) {
  return {
    revision_number: row.revision_number,
    parent_revision_number: row.parent_revision_number,
    trigger_kind: row.trigger_kind,
    candidate_set_hash: row.candidate_set_hash,
    engine_version: row.engine_version,
    cleaner_version: row.cleaner_version,
    verified_offer_count: row.verified_offer_count,
    pending_offer_count: row.pending_offer_count,
    not_available_offer_count: row.not_available_offer_count,
    credits_charged: row.credits_charged,
    stats: row.stats,
    quality: row.quality,
    records: row.records,
    source_verifications: row.source_verifications,
    created_at: row.created_at.toISOString(),
  };
}

function buildComparableRecord(
  eventId: string,
  record: Candidate,
  cents: number,
  soldAt: string | null,
  verification?: VerificationRow,
) {
  return {
    sale_event_id: eventId,
    item_price_cents:
      record.currency === "USD" ? record.itemCents : (record.usdConversion?.itemCents ?? null),
    observed_shipping_cents: observedShippingCents(record),
    price_usd_cents: cents,
    currency: "USD",
    sale_price_status: "verified_actual",
    sale_format: record.format,
    sold_at: soldAt,
    sold_date_precision: record.time.precision === "day" ? "day" : "second",
    sold_date: saleDateEvidence(record.time),
    source_id: record.sourceId,
    verification_evidence_type: verification?.evidence_kind ?? "synthetic_test_marker",
    ...(verification?.evidence_ref ? { verification_evidence_ref: verification.evidence_ref } : {}),
    ...(record.title ? { title: record.title } : {}),
    ...(isStandardCondition(record.condition) ? { condition_std: record.condition } : {}),
  };
}

type DeliveredQueryRow = Awaited<ReturnType<QueryService["readDeliveredSnapshot"]>>["q"];

export class BestOfferVerificationService {
  constructor(
    readonly query: QueryService,
    readonly transport?: BestOfferVerifierTransport,
  ) {}

  private async expirePendingLocked(c: Transaction, now: Date, queryId?: string) {
    if (queryId) {
      await c.query(
        "UPDATE best_offer_verifications SET status='expired',failure_reason=COALESCE(failure_reason,'verification_deadline_expired'),updated_at=$2 WHERE query_id=$1 AND status='pending' AND expires_at<=$2",
        [queryId, now],
      );
      return;
    }
    await c.query(
      "UPDATE best_offer_verifications SET status='expired',failure_reason=COALESCE(failure_reason,'verification_deadline_expired'),updated_at=$1 WHERE status='pending' AND expires_at<=$1",
      [now],
    );
  }

  private async readBaselineViewLocked(
    c: Transaction,
    q: DeliveredQueryRow,
    stale: boolean,
  ): Promise<RevisionRow> {
    const policy = await permissions(c, q.id);
    const inputRows = (
      await c.query(
        `SELECT s.source_id,s.candidate,i.sale_event_id,i.price_usd_cents,i.sold_at
         FROM query_calculation_inputs i JOIN query_snapshot_records s USING (query_id,sale_event_id)
         WHERE i.query_id=$1 ORDER BY i.sale_event_id`,
        [q.id],
      )
    ).rows;
    const records = inputRows.flatMap((row) => {
      const allowed = policy.get(row.source_id);
      if (!allowed || !canPrice(allowed)) return [];
      const candidate = { ...row.candidate, sourceId: row.source_id } as Candidate;
      if (!allowed.has("title")) delete candidate.title;
      if (!allowed.has("condition")) delete candidate.condition;
      delete candidate.sellerDisplayName;
      return [
        buildComparableRecord(
          row.sale_event_id,
          candidate,
          Number(row.price_usd_cents),
          row.sold_at instanceof Date ? row.sold_at.toISOString() : null,
        ),
      ];
    });
    const baselineQuality = qualityReport(
      {
        stats: q.stats,
        quality: q.quality,
        diagnostics: q.diagnostics,
        data_as_of: q.data_as_of instanceof Date ? q.data_as_of : null,
      },
      stale,
      allSourcesAllow(policy, "attributes") ? "details" : "hidden",
    );
    return {
      id: q.id,
      query_id: q.id,
      user_id: q.user_id,
      revision_number: 1,
      parent_revision_number: null,
      trigger_kind: "delivered_baseline",
      candidate_set_hash: q.candidate_set_hash,
      engine_version: q.engine_version,
      cleaner_version: q.cleaner_version,
      verified_offer_count: 0,
      pending_offer_count: 0,
      not_available_offer_count: 0,
      stats: q.stats,
      quality: baselineQuality,
      records,
      source_verifications: [],
      credits_charged: 0,
      created_at:
        q.delivered_at instanceof Date
          ? q.delivered_at
          : q.created_at instanceof Date
            ? q.created_at
            : new Date(q.as_of),
    };
  }

  private async ensureBaselineRevisionLocked(
    c: Transaction,
    q: DeliveredQueryRow,
    stale: boolean,
  ): Promise<void> {
    const existing = await c.query(
      "SELECT 1 FROM query_evidence_revisions WHERE query_id=$1 AND revision_number=1",
      [q.id],
    );
    if (existing.rowCount) return;
    const baseline = await this.readBaselineViewLocked(c, q, stale);
    await c.query(
      `INSERT INTO query_evidence_revisions(
         query_id,user_id,revision_number,parent_revision_number,trigger_kind,
         candidate_set_hash,engine_version,cleaner_version,
         verified_offer_count,pending_offer_count,not_available_offer_count,
         stats,quality,records,source_verifications,credits_charged,created_at
       ) VALUES($1,$2,1,NULL,'delivered_baseline',$3,$4,$5,0,0,0,$6,$7,$8,'[]'::jsonb,0,$9)
       ON CONFLICT(query_id,revision_number) DO NOTHING`,
      [
        q.id,
        q.user_id,
        baseline.candidate_set_hash,
        baseline.engine_version,
        baseline.cleaner_version,
        JSON.stringify(baseline.stats),
        JSON.stringify(baseline.quality),
        JSON.stringify(baseline.records),
        baseline.created_at,
      ],
    );
  }

  private async buildStatusLocked(c: Transaction, q: DeliveredQueryRow, stale: boolean) {
    const policy = await permissions(c, q.id);
    const items = (
      await c.query(
        `SELECT s.sale_event_id,s.listing_id,s.source_id,s.observation_id,s.candidate,
                l.external_listing_id,se.currency,se.sale_price_status,
                v.id AS v_id,v.query_id AS v_query_id,v.user_id AS v_user_id,v.source_id AS v_source_id,
                v.sale_event_id AS v_sale_event_id,v.listing_id AS v_listing_id,v.observation_id AS v_observation_id,
                v.external_listing_id AS v_external_listing_id,v.currency AS v_currency,v.status AS v_status,
                v.attempts AS v_attempts,v.max_attempts AS v_max_attempts,
                v.verified_price_cents AS v_verified_price_cents,v.verified_price_usd_cents AS v_verified_price_usd_cents,
                v.evidence_kind AS v_evidence_kind,v.evidence_ref AS v_evidence_ref,v.evidence_hash AS v_evidence_hash,
                v.failure_reason AS v_failure_reason,v.credit_policy AS v_credit_policy,
                v.expires_at AS v_expires_at,v.created_at AS v_created_at,v.updated_at AS v_updated_at,
                v.verified_at AS v_verified_at
         FROM query_snapshot_records s
         JOIN sold_listings l ON (l.id,l.source_id)=(s.listing_id,s.source_id)
         JOIN sale_events se ON (se.id,se.listing_id,se.source_id,se.observation_id)=(s.sale_event_id,s.listing_id,s.source_id,s.observation_id)
         LEFT JOIN best_offer_verifications v ON (v.query_id,v.sale_event_id)=(s.query_id,s.sale_event_id)
         WHERE s.query_id=$1 AND s.candidate->>'format'='best_offer'
         ORDER BY s.sale_event_id ASC`,
        [q.id],
      )
    ).rows;
    const circuitOpen = Boolean(
      (
        await c.query(
          "SELECT 1 FROM query_result_sources r JOIN collector_circuits x ON x.source_id=r.source_id AND x.category_key='*' WHERE r.query_id=$1 AND x.status<>'closed' LIMIT 1",
          [q.id],
        )
      ).rowCount,
    );
    const revisionRows = (
      await c.query<RevisionRow>(
        "SELECT * FROM query_evidence_revisions WHERE query_id=$1 ORDER BY revision_number ASC",
        [q.id],
      )
    ).rows;
    const revisions = revisionRows.length
      ? revisionRows.map(serializeRevision)
      : [serializeRevision(await this.readBaselineViewLocked(c, q, stale))];

    let displayedOnlyCount = 0;
    let pendingCount = 0;
    let verifiedCount = 0;
    let notAvailableCount = 0;
    let expiredCount = 0;
    let sourceBlockedCount = 0;
    let unrequestedCount = 0;

    const serializedItems = items.map((row) => {
      const allowed = policy.get(row.source_id);
      const candidate = row.candidate as Candidate;
      const canSeePrice = canPrice(allowed);
      if (candidate.priceStatus === "displayed_only") displayedOnlyCount += 1;
      const verification: VerificationRow | null = row.v_id
        ? {
            id: row.v_id,
            query_id: row.v_query_id,
            user_id: row.v_user_id,
            source_id: row.v_source_id,
            sale_event_id: row.v_sale_event_id,
            listing_id: row.v_listing_id,
            observation_id: row.v_observation_id,
            external_listing_id: row.v_external_listing_id,
            currency: row.v_currency,
            status: row.v_status,
            attempts: row.v_attempts,
            max_attempts: row.v_max_attempts,
            verified_price_cents: row.v_verified_price_cents,
            verified_price_usd_cents: row.v_verified_price_usd_cents,
            evidence_kind: row.v_evidence_kind,
            evidence_ref: row.v_evidence_ref,
            evidence_hash: row.v_evidence_hash,
            failure_reason: row.v_failure_reason,
            credit_policy: row.v_credit_policy,
            expires_at: row.v_expires_at,
            created_at: row.v_created_at,
            updated_at: row.v_updated_at,
            verified_at: row.v_verified_at,
          }
        : null;
      if (!verification) {
        if (candidate.priceStatus === "displayed_only") unrequestedCount += 1;
      } else if (verification.status === "pending") pendingCount += 1;
      else if (verification.status === "verified") verifiedCount += 1;
      else if (verification.status === "not_available") notAvailableCount += 1;
      else if (verification.status === "expired") expiredCount += 1;
      else if (verification.status === "source_blocked") sourceBlockedCount += 1;

      return {
        sale_event_id: row.sale_event_id,
        listing_id: row.listing_id,
        source_id: row.source_id,
        observation_id: row.observation_id,
        external_listing_id: row.external_listing_id,
        title: allowed?.has("title") ? (candidate.title ?? null) : null,
        displayed_price_cents:
          canSeePrice && typeof candidate.itemCents === "number" ? candidate.itemCents : null,
        currency: row.currency,
        original_price_status: candidate.priceStatus,
        verification: verification ? serializeVerification(verification) : null,
      };
    });

    const latestRevision = revisions[revisions.length - 1];
    return {
      status: {
        query_id: q.id,
        eligibility: {
          mode: this.transport?.kind ?? "queue_only",
          source_circuit_open: circuitOpen,
          credit_policy: BEST_OFFER_CREDIT_POLICY,
          credits_required: 0,
          max_items_per_query: MAX_BEST_OFFER_VERIFY_ITEMS,
          max_attempts_per_item: MAX_BEST_OFFER_ATTEMPTS,
          verification_ttl_minutes: DEFAULT_BEST_OFFER_TTL_MINUTES,
        },
        summary: {
          total_best_offer_events: serializedItems.length,
          displayed_only_count: displayedOnlyCount,
          pending_count: pendingCount,
          verified_count: verifiedCount,
          not_available_count: notAvailableCount,
          expired_count: expiredCount,
          source_blocked_count: sourceBlockedCount,
          unrequested_count: unrequestedCount,
        },
        items: serializedItems,
        revisions,
      },
      revisionCount: revisions.length,
      latestRevisionNumber: latestRevision?.revision_number ?? 1,
    };
  }

  async status(identity: Identity, queryId: string) {
    return transaction(this.query.db, async (c) => {
      const { q, now, state } = await this.query.readDeliveredSnapshot(c, identity, queryId);
      await this.expirePendingLocked(c, now, queryId);
      return this.buildStatusLocked(c, q, state.freshness !== "fresh");
    });
  }

  async requestVerification(identity: Identity, queryId: string, input: RequestVerificationInput = {}) {
    return transaction(this.query.db, async (c) => {
      const { q, now, state } = await this.query.readDeliveredSnapshot(c, identity, queryId);
      await this.expirePendingLocked(c, now, queryId);
      const openCircuit = (
        await c.query(
          "SELECT 1 FROM query_result_sources r JOIN collector_circuits x ON x.source_id=r.source_id AND x.category_key='*' WHERE r.query_id=$1 AND x.status<>'closed' LIMIT 1",
          [queryId],
        )
      ).rowCount;
      if (openCircuit)
        throw new AppError(
          "source_circuit_open",
          409,
          "Source collection circuit is open; Best Offer verification is paused.",
        );

      await this.ensureBaselineRevisionLocked(c, q, state.freshness !== "fresh");
      const existingRows = (
        await c.query<VerificationRow>(
          "SELECT * FROM best_offer_verifications WHERE query_id=$1 FOR UPDATE",
          [queryId],
        )
      ).rows;
      const existingByEvent = new Map(existingRows.map((row) => [row.sale_event_id, row]));

      const eligibleRows = (
        await c.query(
          `SELECT s.sale_event_id,s.listing_id,s.source_id,s.observation_id,l.external_listing_id,se.currency
           FROM query_snapshot_records s
           JOIN sold_listings l ON (l.id,l.source_id)=(s.listing_id,s.source_id)
           JOIN sale_events se ON (se.id,se.listing_id,se.source_id,se.observation_id)=(s.sale_event_id,s.listing_id,s.source_id,s.observation_id)
           WHERE s.query_id=$1 AND s.candidate->>'format'='best_offer' AND s.candidate->>'priceStatus'='displayed_only'
           ORDER BY s.sale_event_id ASC`,
          [queryId],
        )
      ).rows;
      const eligibleByEvent = new Map(eligibleRows.map((row) => [row.sale_event_id as string, row]));

      const requestedIds = input.sale_event_ids
        ? [...new Set(input.sale_event_ids)]
        : eligibleRows.map((row) => row.sale_event_id as string);
      if (input.sale_event_ids) {
        for (const eventId of requestedIds) {
          if (!eligibleByEvent.has(eventId))
            throw new AppError(
              "invalid_parameter",
              400,
              "Requested sale_event_id is not an eligible displayed-only Best Offer item in this snapshot.",
            );
        }
      }

      const maxItems = input.max_items ?? MAX_BEST_OFFER_VERIFY_ITEMS;
      const ttlMinutes = input.ttl_minutes ?? DEFAULT_BEST_OFFER_TTL_MINUTES;
      const remainingBudget = Math.max(0, MAX_BEST_OFFER_VERIFY_ITEMS - existingRows.length);
      const newIds = requestedIds.filter((eventId) => !existingByEvent.has(eventId));
      if (input.sale_event_ids && newIds.length > Math.min(remainingBudget, maxItems))
        throw new AppError(
          "verification_budget_exceeded",
          422,
          `Post-lookup Best Offer verification budget allows at most ${MAX_BEST_OFFER_VERIFY_ITEMS} items per query.`,
        );
      if (!input.sale_event_ids && newIds.length > 0 && remainingBudget === 0)
        throw new AppError(
          "verification_budget_exceeded",
          422,
          `Post-lookup Best Offer verification budget allows at most ${MAX_BEST_OFFER_VERIFY_ITEMS} items per query.`,
        );

      const selectedNew = newIds.slice(0, Math.min(remainingBudget, maxItems));
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60000);
      let queuedNow = 0;
      for (const eventId of selectedNew) {
        const row = eligibleByEvent.get(eventId);
        if (!row) continue;
        const inserted = await c.query(
          `INSERT INTO best_offer_verifications(
             query_id,user_id,source_id,sale_event_id,listing_id,observation_id,
             external_listing_id,currency,status,attempts,max_attempts,
             credit_policy,expires_at,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,$9,$10,$11,$12,$12)
           ON CONFLICT(query_id,sale_event_id) DO NOTHING
           RETURNING id`,
          [
            queryId,
            q.user_id,
            row.source_id,
            row.sale_event_id,
            row.listing_id,
            row.observation_id,
            row.external_listing_id,
            row.currency,
            MAX_BEST_OFFER_ATTEMPTS,
            BEST_OFFER_CREDIT_POLICY,
            expiresAt,
            now,
          ],
        );
        if (inserted.rowCount) queuedNow += 1;
      }

      const view = await this.buildStatusLocked(c, q, state.freshness !== "fresh");
      return {
        ...view,
        queuedNow,
        reusedExisting: requestedIds.length - selectedNew.length,
        creditsCharged: 0,
      };
    });
  }

  async processNext(filter: { queryId?: string; sourceId?: string } = {}) {
    const claimed = await transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      await this.expirePendingLocked(c, now, filter.queryId);

      const conditions = ["v.status='pending'"];
      const params: unknown[] = [];
      if (filter.queryId) {
        params.push(filter.queryId);
        conditions.push(`v.query_id=$${params.length}`);
      }
      if (filter.sourceId) {
        params.push(filter.sourceId);
        conditions.push(`v.source_id=$${params.length}`);
      }
      const next = (
        await c.query<
          VerificationRow & {
            source_status: string;
            circuit_status: string | null;
            displayed_price_cents: string | number | null;
          }
        >(
          `SELECT v.*,src.status AS source_status,cir.status AS circuit_status,
                  (s.candidate->>'itemCents')::bigint AS displayed_price_cents
           FROM best_offer_verifications v
           JOIN sources src ON src.id=v.source_id
           JOIN query_snapshot_records s ON (s.query_id,s.sale_event_id)=(v.query_id,v.sale_event_id)
           LEFT JOIN collector_circuits cir ON cir.source_id=v.source_id AND cir.category_key='*'
           WHERE ${conditions.join(" AND ")}
           ORDER BY v.updated_at ASC, v.created_at ASC, v.id ASC
           FOR UPDATE OF v SKIP LOCKED
           LIMIT 1`,
          params,
        )
      ).rows[0];
      if (!next) return { outcome: "idle" as const };

      if (next.source_status !== "active" || (next.circuit_status && next.circuit_status !== "closed")) {
        const updated = mustRow(
          (
            await c.query<VerificationRow>(
              "UPDATE best_offer_verifications SET status='source_blocked',failure_reason='source_circuit_open_or_inactive',updated_at=$2 WHERE id=$1 RETURNING *",
              [next.id, now],
            )
          ).rows[0],
          "verification_row_missing",
        );
        return { outcome: "terminal" as const, verification: serializeVerification(updated) };
      }

      if (next.attempts >= next.max_attempts) {
        const updated = mustRow(
          (
            await c.query<VerificationRow>(
              "UPDATE best_offer_verifications SET status='not_available',failure_reason=COALESCE(failure_reason,'retry_budget_exhausted'),updated_at=$2 WHERE id=$1 RETURNING *",
              [next.id, now],
            )
          ).rows[0],
          "verification_row_missing",
        );
        return { outcome: "terminal" as const, verification: serializeVerification(updated) };
      }

      if (this.transport?.kind !== "memory_fixture")
        throw new AppError(
          "best_offer_verifier_unavailable",
          503,
          "Only memory_fixture transport is allowed for Best Offer verification in offline mode.",
        );

      const started = mustRow(
        (
          await c.query<VerificationRow>(
            "UPDATE best_offer_verifications SET attempts=attempts+1,updated_at=$2 WHERE id=$1 RETURNING *",
            [next.id, now],
          )
        ).rows[0],
        "verification_row_missing",
      );
      return {
        outcome: "execute" as const,
        row: started,
        displayedPriceCents: next.displayed_price_cents === null ? null : Number(next.displayed_price_cents),
      };
    });

    if (claimed.outcome !== "execute") return claimed;

    const transport = this.transport;
    if (transport?.kind !== "memory_fixture")
      throw new AppError(
        "best_offer_verifier_unavailable",
        503,
        "Only memory_fixture transport is allowed for Best Offer verification in offline mode.",
      );

    const transportResult = await transport.verify({
      queryId: claimed.row.query_id,
      sourceId: claimed.row.source_id,
      saleEventId: claimed.row.sale_event_id,
      listingId: claimed.row.listing_id,
      observationId: claimed.row.observation_id,
      externalListingId: claimed.row.external_listing_id,
      displayedPriceCents: claimed.displayedPriceCents,
      currency: claimed.row.currency,
      attempt: claimed.row.attempts,
    });

    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const current = (
        await c.query<VerificationRow>("SELECT * FROM best_offer_verifications WHERE id=$1 FOR UPDATE", [
          claimed.row.id,
        ])
      ).rows[0];
      if (!current) throw new Error("verification_row_missing");

      if (transportResult.kind === "source_blocked") {
        const reason = `http_${transportResult.httpStatus}:${transportResult.reason}`;
        await c.query(
          "INSERT INTO collector_circuits(source_id,category_key,status,opened_reason,opened_at) VALUES($1,'*','open',$2,$3) ON CONFLICT(source_id,category_key) DO UPDATE SET status='open',opened_reason=$2,opened_at=$3",
          [current.source_id, reason, now],
        );
        await c.query("UPDATE sources SET ops_version=ops_version+1 WHERE id=$1", [current.source_id]);
        await c.query(
          "UPDATE best_offer_verifications SET status='source_blocked',failure_reason=$2,updated_at=$3 WHERE source_id=$1 AND status='pending' AND id<>$4",
          [current.source_id, reason, now, current.id],
        );
        const blocked = mustRow(
          (
            await c.query<VerificationRow>(
              "UPDATE best_offer_verifications SET status='source_blocked',failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *",
              [current.id, reason, now],
            )
          ).rows[0],
          "verification_row_missing",
        );
        return { outcome: "source_blocked" as const, verification: serializeVerification(blocked) };
      }

      if (current.expires_at <= now) {
        const expired = mustRow(
          (
            await c.query<VerificationRow>(
              "UPDATE best_offer_verifications SET status='expired',failure_reason='verification_deadline_expired',updated_at=$2 WHERE id=$1 RETURNING *",
              [current.id, now],
            )
          ).rows[0],
          "verification_row_missing",
        );
        return { outcome: "expired" as const, verification: serializeVerification(expired) };
      }

      if (transportResult.kind === "verified") {
        if (
          !Number.isSafeInteger(transportResult.verifiedPriceCents) ||
          transportResult.verifiedPriceCents < 0 ||
          !transportResult.evidenceKind.trim() ||
          !transportResult.evidenceRef.trim()
        )
          throw new AppError("invalid_parameter", 400, "Invalid Best Offer verification evidence payload.");
        const currency = transportResult.currency ?? current.currency;
        const usdCents =
          currency === "USD"
            ? transportResult.verifiedPriceCents
            : (transportResult.verifiedPriceUsdCents ?? transportResult.verifiedPriceCents);
        const evidenceHash = createHash("sha256")
          .update(
            JSON.stringify({
              sale_event_id: current.sale_event_id,
              observation_id: current.observation_id,
              external_listing_id: current.external_listing_id,
              currency,
              verified_price_cents: transportResult.verifiedPriceCents,
              verified_price_usd_cents: usdCents,
              evidence_kind: transportResult.evidenceKind,
              evidence_ref: transportResult.evidenceRef,
            }),
          )
          .digest("hex");
        const verified = mustRow(
          (
            await c.query<VerificationRow>(
              `UPDATE best_offer_verifications
             SET status='verified',currency=$2,verified_price_cents=$3,verified_price_usd_cents=$4,
                 evidence_kind=$5,evidence_ref=$6,evidence_hash=$7,failure_reason=NULL,
                 verified_at=$8,updated_at=$8
             WHERE id=$1 RETURNING *`,
              [
                current.id,
                currency,
                transportResult.verifiedPriceCents,
                usdCents,
                transportResult.evidenceKind,
                transportResult.evidenceRef,
                evidenceHash,
                now,
              ],
            )
          ).rows[0],
          "verification_row_missing",
        );
        return { outcome: "verified" as const, verification: serializeVerification(verified) };
      }

      if (transportResult.kind === "not_available") {
        const unavailable = mustRow(
          (
            await c.query<VerificationRow>(
              "UPDATE best_offer_verifications SET status='not_available',failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *",
              [current.id, transportResult.reason, now],
            )
          ).rows[0],
          "verification_row_missing",
        );
        return { outcome: "not_available" as const, verification: serializeVerification(unavailable) };
      }

      // Retryable failure: bounded by max_attempts (3).
      if (current.attempts >= current.max_attempts) {
        const exhausted = mustRow(
          (
            await c.query<VerificationRow>(
              "UPDATE best_offer_verifications SET status='not_available',failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *",
              [current.id, `retry_budget_exhausted:${transportResult.reason}`, now],
            )
          ).rows[0],
          "verification_row_missing",
        );
        return { outcome: "not_available" as const, verification: serializeVerification(exhausted) };
      }
      const retry = mustRow(
        (
          await c.query<VerificationRow>(
            "UPDATE best_offer_verifications SET status='pending',failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *",
            [current.id, transportResult.reason, now],
          )
        ).rows[0],
        "verification_row_missing",
      );
      return { outcome: "retry" as const, verification: serializeVerification(retry) };
    });
  }

  async createRevision(identity: Identity, queryId: string) {
    return transaction(this.query.db, async (c) => {
      const { q, now, state } = await this.query.readDeliveredSnapshot(c, identity, queryId);
      await this.expirePendingLocked(c, now, queryId);
      await this.ensureBaselineRevisionLocked(c, q, state.freshness !== "fresh");

      const verifications = (
        await c.query<VerificationRow>(
          "SELECT * FROM best_offer_verifications WHERE query_id=$1 ORDER BY sale_event_id ASC",
          [queryId],
        )
      ).rows;
      const verifiedRows = verifications.filter((v) => v.status === "verified");
      if (!verifiedRows.length)
        throw new AppError(
          "no_verified_offers",
          409,
          "No verified Best Offer prices are available to create a revised snapshot.",
        );
      const verificationByEvent = new Map(verifications.map((row) => [row.sale_event_id, row]));

      const policy = await permissions(c, queryId);
      const snapshotRecords = (
        await c.query(
          `SELECT s.source_id,s.sale_event_id,s.candidate,
                  CASE WHEN e.evidence #>> '{fields,attributes}'='present' THEN e.evidence->'attributes' END AS strong_attributes
           FROM query_snapshot_records s
           LEFT JOIN listing_record_evidence e
             ON (e.sale_event_id,e.listing_id,e.source_id,e.observation_id)=(s.sale_event_id,s.listing_id,s.source_id,s.observation_id)
           WHERE s.query_id=$1 ORDER BY s.sale_event_id ASC`,
          [queryId],
        )
      ).rows;

      const revisedCandidates: Candidate[] = [];
      const rowByEvent = new Map<string, (typeof snapshotRecords)[number]>();
      for (const row of snapshotRecords) {
        rowByEvent.set(row.sale_event_id, row);
        const candidate = structuredClone(row.candidate as Candidate);
        const v = verificationByEvent.get(row.sale_event_id);
        if (
          candidate.format === "best_offer" &&
          candidate.priceStatus === "displayed_only" &&
          v?.status === "verified"
        ) {
          candidate.priceStatus = "verified_actual";
          candidate.itemCents = Number(v.verified_price_cents);
          if (candidate.currency !== "USD" || v.currency !== "USD") {
            candidate.usdConversion = {
              itemCents: Number(v.verified_price_usd_cents),
              shippingCents:
                candidate.usdConversion?.shippingCents ??
                (candidate.shippingStatus === "unknown" ? null : candidate.shippingCents),
              evidenceRef: v.evidence_ref ?? "best_offer_verification",
            };
          }
        }
        revisedCandidates.push(candidate);
      }

      const sourceScope = Array.isArray(q.source_scope) ? (q.source_scope as string[]) : [];
      const primarySource = sourceScope[0] ?? snapshotRecords[0]?.source_id;
      const p = q.filters as SoldQuery;
      const evaluated = evaluateSnapshot(revisedCandidates, {
        sourceId: primarySource,
        asOf: q.as_of.toISOString(),
        days: p.window_days,
        basis: p.price_basis,
        limit: p.limit,
        ...(p.min_price_cents === undefined ? {} : { minPriceCents: p.min_price_cents }),
        ...(p.max_price_cents === undefined ? {} : { maxPriceCents: p.max_price_cents }),
        ...(p.sale_format === undefined ? {} : { saleFormat: p.sale_format }),
      });

      const byEventKey = new Map(
        snapshotRecords.flatMap((row) =>
          row.candidate.identityVerified && row.candidate.eventKey
            ? [[row.candidate.eventKey as string, row]]
            : [],
        ),
      );
      const scope = comparisonScope(
        evaluated.calculation_inputs.map(({ record }) =>
          record.eventKey ? byEventKey.get(record.eventKey)?.strong_attributes?.model : null,
        ),
      );
      const revisionQuality = qualityReport(
        {
          stats: evaluated.stats,
          quality: evaluated.quality,
          diagnostics: { ...evaluated.diagnostics, comparison_scope: scope },
          data_as_of: q.data_as_of instanceof Date ? q.data_as_of : null,
        },
        state.freshness !== "fresh",
        allSourcesAllow(policy, "attributes") ? "details" : "hidden",
      );

      const comparableRecords = evaluated.calculation_inputs.flatMap(({ record, priceCents }) => {
        const snapshotRow = record.eventKey ? byEventKey.get(record.eventKey) : undefined;
        if (!snapshotRow) return [];
        const allowed = policy.get(snapshotRow.source_id);
        if (!allowed || !canPrice(allowed)) return [];
        const visible = { ...record, sourceId: snapshotRow.source_id } as Candidate;
        if (!allowed.has("title")) delete visible.title;
        if (!allowed.has("condition")) delete visible.condition;
        delete visible.sellerDisplayName;
        const soldAt =
          visible.time.precision === "instant"
            ? visible.time.value
            : visible.time.precision === "day"
              ? `${visible.time.value}T00:00:00Z`
              : null;
        return [
          buildComparableRecord(
            snapshotRow.sale_event_id,
            visible,
            priceCents,
            soldAt,
            verificationByEvent.get(snapshotRow.sale_event_id),
          ),
        ];
      });

      const sourceVerifications = verifiedRows.map((v) => ({
        sale_event_id: v.sale_event_id,
        verification_id: v.id,
        status: v.status,
        verified_price_usd_cents: Number(v.verified_price_usd_cents),
        evidence_kind: v.evidence_kind,
        evidence_ref: v.evidence_ref,
        evidence_hash: v.evidence_hash,
      }));
      const pendingOfferCount = verifications.filter((v) => v.status === "pending").length;
      const notAvailableOfferCount = verifications.filter((v) =>
        ["not_available", "expired", "source_blocked"].includes(v.status),
      ).length;

      const latest = (
        await c.query<RevisionRow>(
          "SELECT * FROM query_evidence_revisions WHERE query_id=$1 ORDER BY revision_number DESC LIMIT 1",
          [queryId],
        )
      ).rows[0];
      if (!latest) throw new Error("baseline_revision_missing");

      if (
        latest.revision_number > 1 &&
        latest.candidate_set_hash === evaluated.candidate_set_hash &&
        latest.pending_offer_count === pendingOfferCount &&
        latest.not_available_offer_count === notAvailableOfferCount &&
        canonicalJson(latest.source_verifications) === canonicalJson(sourceVerifications)
      ) {
        return {
          revision: serializeRevision(latest),
          reused: true,
          creditsCharged: 0,
        };
      }

      const nextNumber = latest.revision_number + 1;
      const inserted = mustRow(
        (
          await c.query<RevisionRow>(
            `INSERT INTO query_evidence_revisions(
             query_id,user_id,revision_number,parent_revision_number,trigger_kind,
             candidate_set_hash,engine_version,cleaner_version,
             verified_offer_count,pending_offer_count,not_available_offer_count,
             stats,quality,records,source_verifications,credits_charged,created_at
           ) VALUES($1,$2,$3,$4,'best_offer_verification',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,$15)
           RETURNING *`,
            [
              queryId,
              q.user_id,
              nextNumber,
              latest.revision_number,
              evaluated.candidate_set_hash,
              VERSIONS.engine,
              VERSIONS.cleaner,
              verifiedRows.length,
              pendingOfferCount,
              notAvailableOfferCount,
              JSON.stringify(evaluated.stats),
              JSON.stringify(revisionQuality),
              JSON.stringify(comparableRecords),
              JSON.stringify(sourceVerifications),
              now,
            ],
          )
        ).rows[0],
        "revision_row_missing",
      );
      return {
        revision: serializeRevision(inserted),
        reused: false,
        creditsCharged: 0,
      };
    });
  }
}
