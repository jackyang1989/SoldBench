import { createHash, randomUUID } from "node:crypto";
import type { AuthService, Identity } from "@soldbench/auth";
import type { BillingService } from "@soldbench/billing";
import {
  applyStrongFilters,
  availability,
  type Candidate,
  collectionQueryHash,
  comparisonScope,
  compatibleCleaner,
  evaluateSnapshot,
  hasStrongFilters,
  isStandardCondition,
  type PresentationSort,
  queryHash,
  type SoldQuery,
  sortComparables,
} from "@soldbench/core";
import { type Database, isDatabaseConnectionError, type Transaction, transaction } from "@soldbench/db";
import type { PrivateMediaStore } from "@soldbench/media";
import { AppError, VERSIONS } from "@soldbench/shared";
import { qualityReport } from "./quality-report.ts";
import {
  allSourcesAllow,
  canPrice,
  csv,
  observedShippingCents,
  permissions,
  saleDateEvidence,
  writeComparables,
} from "./research.ts";

const fail = (code: string, status: number, message: string): never => {
  throw new AppError(code, status, message);
};
const iso = (d: Date | null) => d?.toISOString() ?? null;
const missingImage = { state: "missing", url: null, width: null, height: null } as const;
const withheldImage = { state: "not_permitted", url: null, width: null, height: null } as const;
function supportsVerifiedShippingContexts(versions: Record<string, string> | null) {
  const parsers = Object.values(versions ?? {});
  return parsers.length > 0 && parsers.every((parser) => parser === "offline-page-1.4.0");
}
function comparablePayload(eventId: string, record: Candidate, cents: number, soldAt: string | null) {
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
    verification_evidence_type: "synthetic_test_marker",
    ...(record.title ? { title: record.title } : {}),
    ...(isStandardCondition(record.condition) ? { condition_std: record.condition } : {}),
  };
}
export class QueryService {
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
    readonly billing: BillingService,
    readonly media: PrivateMediaStore,
    readonly clock?: () => string,
  ) {}
  async now(c: Transaction) {
    return this.clock
      ? new Date(this.clock())
      : ((await c.query("SELECT clock_timestamp() t")).rows[0].t as Date);
  }
  async owner(c: Transaction, identity: Identity, scope = "sold:read") {
    const now = await this.now(c);
    await this.auth.assertIdentityLocked(c, identity, scope, now);
    return now;
  }
  private async source(c: Transaction, sourceId: string, epoch: string, clearanceId: string, now: Date) {
    const s = (
      await c.query(
        "SELECT s.*,x.provider,x.status AS clearance_status,x.expires_at AS clearance_expires,x.effective_at AS clearance_effective FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 FOR SHARE OF s,x",
        [sourceId],
      )
    ).rows[0];
    if (
      s?.access_method !== "offline_fixture" ||
      s.provider !== "synthetic_fixture" ||
      s.status !== "active" ||
      s.permission_epoch !== epoch ||
      s.source_clearance_id !== clearanceId ||
      !["draft", "reviewed", "active"].includes(s.clearance_status) ||
      (s.clearance_effective && s.clearance_effective > now) ||
      (s.clearance_expires && s.clearance_expires <= now)
    )
      fail("forbidden", 403, "Source rights are unavailable.");
    return s;
  }
  async assertSnapshotRights(c: Transaction, queryId: string, now: Date) {
    const rows = (
      await c.query("SELECT * FROM query_result_sources WHERE query_id=$1 ORDER BY source_id", [queryId])
    ).rows;
    if (!rows.length) fail("source_unavailable", 503, "No covered source snapshot.");
    for (const r of rows) await this.source(c, r.source_id, r.permission_epoch, r.clearance_id, now);
    const invalid = (
      await c.query(
        "SELECT 1 FROM query_snapshot_records r JOIN source_observations o ON o.id=r.observation_id WHERE r.query_id=$1 AND (o.retention_until IS NULL OR o.retention_until<=$2 OR EXISTS(SELECT 1 FROM collector_quarantines x WHERE x.affected_event_id=r.sale_event_id)) LIMIT 1",
        [queryId, now],
      )
    ).rowCount;
    if (invalid) fail("forbidden", 403, "Evidence was withdrawn or its retention expired.");
    // Empty snapshots still have page retention obligations.
    const expired = (
      await c.query(
        "SELECT 1 FROM queries q JOIN collector_jobs j ON j.id=q.collector_job_id JOIN source_observations o ON o.collector_run_id=j.collector_run_id WHERE q.id=$1 AND (o.retention_until IS NULL OR o.retention_until<=$2) LIMIT 1",
        [queryId, now],
      )
    ).rowCount;
    if (expired) fail("forbidden", 403, "Snapshot retention expired.");
  }
  async rate(identity: Identity) {
    const retry = await transaction(this.db, async (c) => {
      const now = await this.owner(
        c,
        identity,
        identity.keyId ? (identity.scopes[0] ?? "sold:read") : "sold:read",
      );
      const plan = (
        await c.query(
          "SELECT p.rate_limit_per_min n FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('active','trialing') AND s.current_period_start<=$2 AND s.current_period_end>$2 AND EXISTS(SELECT 1 FROM credit_grants g JOIN credit_wallets w ON w.id=g.wallet_id JOIN payments p2 ON p2.id=g.payment_id WHERE g.user_id=s.user_id AND g.grant_kind='subscription' AND g.provider=s.provider AND w.period_start=s.current_period_start AND w.period_end=s.current_period_end AND w.status='active' AND p2.state='confirmed') ORDER BY s.current_period_end DESC LIMIT 1",
          [identity.userId, now],
        )
      ).rows[0];
      const limit = plan?.n ?? 30,
        start = new Date(Math.floor(now.getTime() / 60000) * 60000),
        hash = this.auth.crypto.hash("query.rate", identity.userId);
      const result = await c.query(
        "INSERT INTO auth_rate_windows(bucket_hash,window_start,used) VALUES($1,$2,1) ON CONFLICT(bucket_hash,window_start) DO UPDATE SET used=auth_rate_windows.used+1 WHERE auth_rate_windows.used<$3 RETURNING used",
        [hash, start, limit],
      );
      return result.rowCount ? 0 : Math.max(1, Math.ceil((start.getTime() + 60000 - now.getTime()) / 1000));
    });
    if (retry)
      throw new AppError("rate_limited", 429, "Account request rate exceeded.", { retry_after: retry });
  }
  async submit(identity: Identity, query: SoldQuery) {
    return transaction(this.db, async (c) => {
      const now = await this.owner(c, identity),
        hash = queryHash(query);
      const expired = (
        await c.query(
          "SELECT id FROM queries WHERE user_id=$1 AND compute_status IN ('queued','running') AND expires_at<=$2 ORDER BY id FOR UPDATE",
          [identity.userId, now],
        )
      ).rows;
      for (const q of expired) {
        await c.query(
          "UPDATE query_jobs SET status='expired',lease_owner=NULL,lease_until=NULL,error_code='result_expired',updated_at=$2,version=version+1 WHERE query_id=$1 AND status IN ('queued','running')",
          [q.id, now],
        );
        await c.query(
          "UPDATE queries SET compute_status='expired',result_state='expired',version=version+1 WHERE id=$1",
          [q.id],
        );
      }
      const old = (
        await c.query(
          `SELECT q.*,j.id AS job_id,rq.engine_version,rq.cleaner_version,
             coalesce(rq.data_as_of,cj.min_page_as_of,cj.as_of) reuse_data_as_of
           FROM queries q JOIN query_jobs j ON j.query_id=q.id
           LEFT JOIN query_results rq ON rq.query_id=q.id
           LEFT JOIN collector_jobs cj ON cj.id=q.collector_job_id
           WHERE q.user_id=$1 AND q.canonical_query_hash=$2
             AND (q.created_at>$3 OR q.compute_status IN ('queued','running'))
             AND q.compute_status IN ('queued','running','completed')
             AND q.normalizer_version=$5 AND q.billing_policy_version=$6
             AND (q.expires_at>$4 OR q.settlement_status IN ('charged','refunded'))
           ORDER BY (q.settlement_status IN ('charged','refunded')) DESC,
             (q.compute_status IN ('queued','running') OR (rq.engine_version=$7 AND rq.cleaner_version=$8)) DESC NULLS LAST,
             q.created_at DESC,q.id DESC
           LIMIT 1 FOR UPDATE OF q`,
          [
            identity.userId,
            hash,
            new Date(now.getTime() - 600000),
            now,
            VERSIONS.normalizer,
            VERSIONS.billing,
            VERSIONS.engine,
            VERSIONS.cleaner,
          ],
        )
      ).rows[0];
      if (old) {
        let rightsAvailable = true;
        try {
          await this.assertSnapshotRights(c, old.id, now);
        } catch (error) {
          if (!(error instanceof AppError) || !["forbidden", "source_unavailable"].includes(error.code))
            throw error;
          rightsAvailable = false;
        }
        const reuse = availability({
          now: now.toISOString(),
          dataAsOf: iso(old.reuse_data_as_of),
          currentRights: "allowed",
          snapshotExists: true,
          allowStale: query.allow_stale,
          verifiedSamples: 0,
        });
        const compatible =
          old.compute_status !== "completed" ||
          (old.engine_version === VERSIONS.engine && compatibleCleaner(query, old.cleaner_version));
        if (compatible && rightsAvailable && reuse.readable)
          return {
            queryId: old.id as string,
            jobId: old.job_id as string,
            reused: true,
            status: old.compute_status as "queued" | "running" | "completed",
            expiresAt: iso(old.expires_at),
          };
        if (["charged", "refunded"].includes(old.settlement_status)) {
          const retryAfter = Math.max(
            1,
            Math.ceil((old.created_at.getTime() + 600000 - now.getTime()) / 1000),
          );
          throw new AppError(
            "source_unavailable",
            503,
            "The previously delivered result cannot serve as a current price.",
            { retry_after: retryAfter },
          );
        }
        if (["queued", "running"].includes(old.compute_status)) {
          // The previous current request is pinned to an unusable watermark. Release its
          // dedupe slot without allowing another worker to deliver through the old lease.
          await c.query(
            "UPDATE query_jobs SET status='expired',lease_owner=NULL,lease_until=NULL,error_code='result_expired',retryable=false,updated_at=$2,version=version+1 WHERE query_id=$1 AND status IN ('queued','running')",
            [old.id, now],
          );
          await c.query(
            "UPDATE queries SET compute_status='expired',result_state='expired',version=version+1 WHERE id=$1",
            [old.id],
          );
        }
      }
      const covered = (
        await c.query(
          "SELECT j.*,s.source_clearance_id FROM collector_watermarks w JOIN collector_jobs j ON j.collector_run_id=w.run_id JOIN sources s ON s.id=w.source_id JOIN source_clearances x ON x.id=s.source_clearance_id WHERE w.query_hash=$1 AND j.status='completed' AND j.permission_epoch=s.permission_epoch AND s.status='active' AND s.access_method='offline_fixture' AND x.provider='synthetic_fixture' AND x.status IN ('draft','reviewed','active') AND (x.effective_at IS NULL OR x.effective_at<=$2) AND (x.expires_at IS NULL OR x.expires_at>$2) AND w.data_as_of<=$2 ORDER BY w.data_as_of DESC,j.id LIMIT 1",
          [collectionQueryHash(query), now],
        )
      ).rows[0];
      if (!covered)
        fail(
          "source_unavailable",
          503,
          "No matching offline collection exists; live collection is disabled.",
        );
      await this.source(c, covered.source_id, covered.permission_epoch, covered.source_clearance_id, now);
      const a = availability({
        now: now.toISOString(),
        dataAsOf: iso(covered.min_page_as_of ?? covered.as_of),
        currentRights: "allowed",
        snapshotExists: true,
        allowStale: query.allow_stale,
        verifiedSamples: 0,
      });
      if (!a.readable)
        fail(
          a.freshness === "expired" ? "data_expired" : "source_unavailable",
          503,
          "No acceptable fresh snapshot is available.",
        );
      const id = randomUUID(),
        job = randomUUID(),
        expires = new Date(now.getTime() + 86400000);
      await c.query(
        "INSERT INTO queries(id,user_id,api_key_id,canonical_query_hash,normalizer_version,normalized_query,filters,marketplace,window_days,price_basis,requested_limit,allow_stale,as_of,billing_policy_version,compute_status,settlement_status,result_state,created_at,expires_at,collector_job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued','pending','absent',$15,$16,$17)",
        [
          id,
          identity.userId,
          identity.keyId,
          hash,
          VERSIONS.normalizer,
          query.q,
          JSON.stringify(query),
          query.marketplace,
          query.window_days,
          query.price_basis,
          query.limit,
          query.allow_stale,
          covered.as_of,
          VERSIONS.billing,
          now,
          expires,
          covered.id,
        ],
      );
      await c.query(
        "INSERT INTO query_result_sources(query_id,source_id,clearance_id,permission_epoch) VALUES($1,$2,$3,$4)",
        [id, covered.source_id, covered.source_clearance_id, covered.permission_epoch],
      );
      await c.query(
        "INSERT INTO query_snapshot_records(query_id,source_id,sale_event_id,listing_id,observation_id,candidate) SELECT $1,x.source_id,x.sale_event_id,x.listing_id,x.observation_id,x.candidate FROM (SELECT DISTINCT ON(e.sale_event_id) e.* FROM sale_event_evidence e JOIN collector_pages p ON p.observation_id=e.observation_id AND p.source_id=e.source_id JOIN collector_jobs j ON j.id=p.job_id CROSS JOIN LATERAL jsonb_array_elements_text(j.visited_cursors) WITH ORDINALITY seq(cursor,position) WHERE p.job_id=$2 AND seq.cursor=p.cursor ORDER BY e.sale_event_id,seq.position DESC) x",
        [id, covered.id],
      );
      await this.assertSnapshotRights(c, id, now);
      await c.query(
        "INSERT INTO query_jobs(id,query_id,dedupe_key,status,available_at,expires_at,created_at,updated_at) VALUES($1,$2,$3,'queued',$4,$5,$4,$4)",
        [job, id, `${identity.userId}:${hash}`, now, expires],
      );
      await c.query(
        "INSERT INTO outbox(kind,event_key,payload,created_at,available_at) VALUES('query.queued',$1,$2,$3,$3)",
        [`query:${id}`, JSON.stringify({ query_id: id, job_id: job }), now],
      );
      return { queryId: id, jobId: job, reused: false, status: "queued" as const, expiresAt: iso(expires) };
    });
  }
  /** Durable computation queue. Contains no collector transport and performs no charging. */
  async workOnce(workerId: string) {
    if (!workerId || workerId.length > 120) throw new Error("invalid_worker_id");
    const lease = await transaction(this.db, async (c) => {
      const now = await this.now(c);
      const j = (
        await c.query(
          "SELECT * FROM query_jobs WHERE (status='queued' AND available_at<=$1 OR status='running' AND lease_until<=$1) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
          [now],
        )
      ).rows[0];
      if (!j) return null;
      const token = randomUUID();
      await c.query(
        "UPDATE query_jobs SET status='running',lease_owner=$2,lease_until=$3,attempt_count=attempt_count+1,updated_at=$4,version=version+1 WHERE id=$1",
        [j.id, token, new Date(now.getTime() + 60000), now],
      );
      return {
        terminal: j.expires_at <= now || j.attempt_count >= 3,
        expired: j.expires_at <= now,
        jobId: j.id as string,
        queryId: j.query_id as string,
        token,
      };
    });
    if (!lease) return null;
    if (lease.terminal) {
      await transaction(this.db, async (c) => {
        const owner = (await c.query("SELECT user_id FROM queries WHERE id=$1", [lease.queryId])).rows[0];
        await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner.user_id]);
        await c.query("SELECT id FROM queries WHERE id=$1 FOR UPDATE", [lease.queryId]);
        const now = await this.now(c),
          status = lease.expired ? "expired" : "failed";
        const changed = await c.query(
          "UPDATE query_jobs SET status=$3,lease_owner=NULL,lease_until=NULL,updated_at=$4,error_code=$5,version=version+1 WHERE id=$1 AND lease_owner=$2 AND status='running' RETURNING id",
          [lease.jobId, lease.token, status, now, lease.expired ? "result_expired" : "service_unavailable"],
        );
        if (changed.rowCount)
          await c.query(
            "UPDATE queries SET compute_status=$2,result_state=$3,version=version+1 WHERE id=$1",
            [lease.queryId, status, lease.expired ? "expired" : "absent"],
          );
      });
      return { jobId: lease.jobId, status: lease.expired ? "expired" : "failed" };
    }
    try {
      await transaction(this.db, async (c) => {
        const peek = (await c.query("SELECT user_id FROM queries WHERE id=$1", [lease.queryId])).rows[0];
        await this.billing.lockOwner(c, peek.user_id);
        const q = (await c.query("SELECT * FROM queries WHERE id=$1 FOR UPDATE", [lease.queryId])).rows[0],
          now = await this.now(c);
        const j = (await c.query("SELECT * FROM query_jobs WHERE id=$1 FOR UPDATE", [lease.jobId])).rows[0];
        if (
          j.status !== "running" ||
          j.lease_owner !== lease.token ||
          j.lease_until <= now ||
          q.expires_at <= now
        )
          throw new Error("query_lease_lost");
        await this.assertSnapshotRights(c, q.id, now);
        const p = q.filters as SoldQuery;
        const records = (
          await c.query(
            `SELECT s.*,
               CASE WHEN e.evidence #>> '{fields,attributes}'='present' THEN e.evidence->'attributes' END AS strong_attributes,
               CASE WHEN e.evidence->>'schema'='soldbench.record-evidence.v2'
                 AND e.evidence #>> '{fields,condition}'='present' THEN e.evidence->>'conditionStandard' END AS standard_condition,
               e.sale_event_id IS NOT NULL AS has_record_evidence
             FROM query_snapshot_records s LEFT JOIN listing_record_evidence e
               ON (e.sale_event_id,e.listing_id,e.source_id,e.observation_id)=(s.sale_event_id,s.listing_id,s.source_id,s.observation_id)
             WHERE s.query_id=$1 ORDER BY s.sale_event_id`,
            [q.id],
          )
        ).rows;
        if (hasStrongFilters(p)) {
          const changed: Array<{ sale_event_id: string; candidate: Candidate }> = [];
          for (const r of records) {
            const candidate = applyStrongFilters(
              p,
              r.candidate,
              r.has_record_evidence
                ? {
                    ...(r.strong_attributes ? { attributes: r.strong_attributes } : {}),
                    conditionStandard: r.standard_condition,
                  }
                : null,
            );
            if (candidate !== r.candidate) {
              r.candidate = candidate;
              changed.push({ sale_event_id: r.sale_event_id, candidate });
            }
          }
          if (changed.length)
            await c.query(
              "UPDATE query_snapshot_records s SET candidate=v.candidate FROM jsonb_to_recordset($2::jsonb) AS v(sale_event_id uuid,candidate jsonb) WHERE s.query_id=$1 AND s.sale_event_id=v.sale_event_id",
              [q.id, JSON.stringify(changed)],
            );
        }
        const source = (await c.query("SELECT source_id FROM query_result_sources WHERE query_id=$1", [q.id]))
          .rows[0].source_id;
        const result = evaluateSnapshot(
          records.map((r) => r.candidate as Candidate),
          {
            sourceId: source,
            asOf: q.as_of.toISOString(),
            days: p.window_days,
            basis: p.price_basis,
            limit: p.limit,
            ...(p.min_price_cents === undefined ? {} : { minPriceCents: p.min_price_cents }),
            ...(p.max_price_cents === undefined ? {} : { maxPriceCents: p.max_price_cents }),
            ...(p.sale_format === undefined ? {} : { saleFormat: p.sale_format }),
          },
        );
        const byEvent = new Map<string, (typeof records)[number]>(
          records.flatMap((r) =>
            r.candidate.identityVerified && r.candidate.eventKey ? [[r.candidate.eventKey, r]] : [],
          ),
        );
        const scope = comparisonScope(
          result.calculation_inputs.map(({ record }) =>
            record.eventKey ? byEvent.get(record.eventKey)?.strong_attributes?.model : null,
          ),
        );
        const run = (
          await c.query(
            `SELECT j.min_page_as_of,j.as_of,r.parser_version,
               p.payload->'sourceReported' AS source_report,p.page_as_of AS report_as_of
             FROM collector_jobs j JOIN collector_runs r ON r.id=j.collector_run_id
             LEFT JOIN collector_pages p ON p.job_id=j.id AND p.source_id=j.source_id
               AND p.cursor=j.visited_cursors->>0
             WHERE j.id=$1`,
            [q.collector_job_id],
          )
        ).rows[0];
        const report = run.source_report;
        const sourceReported =
          run.report_as_of &&
          report &&
          Number.isSafeInteger(report.count) &&
          report.count >= 0 &&
          ["listings", "items", "events", "unknown"].includes(report.unit) &&
          typeof report.estimated === "boolean"
            ? {
                count: report.count,
                unit: report.unit,
                estimated: report.estimated,
                as_of: iso(run.report_as_of),
                marketplace: p.marketplace,
              }
            : null;
        await c.query(
          "INSERT INTO query_results(query_id,stats,quality,snapshot_version,engine_version,cleaner_version,parser_versions,candidate_set_hash,source_scope,data_as_of,coverage_status,source_window_start,source_window_end,supplemental_stats,diagnostics,query_parameters,collector_job_id) VALUES($1,$2,$3,'1',$4,$5,$6,$7,$8,$9,'unknown',$10,$11,$12,$13,$14,$15)",
          [
            q.id,
            JSON.stringify(result.stats),
            JSON.stringify(result.quality),
            VERSIONS.engine,
            VERSIONS.cleaner,
            JSON.stringify({ [source]: run.parser_version }),
            result.candidate_set_hash,
            JSON.stringify([source]),
            run.min_page_as_of ?? run.as_of,
            new Date(q.as_of.getTime() - p.window_days * 86400000),
            q.as_of,
            JSON.stringify({
              ...result.supplemental_stats,
              source_reported_match_count: sourceReported,
            }),
            JSON.stringify({ ...result.diagnostics, comparison_scope: scope }),
            JSON.stringify(p),
            q.collector_job_id,
          ],
        );
        await writeComparables(c, q.id, result.candidate_set_hash, records, result.record_decisions);
        for (const [position, input] of result.calculation_inputs.entries()) {
          const r = input.record.eventKey ? byEvent.get(input.record.eventKey) : undefined;
          if (!r) throw new Error("snapshot_event_missing");
          // Day precision is preserved verbatim in the canonical candidate and returned DTO.
          const soldAt =
            input.record.time.precision === "instant"
              ? input.record.time.value
              : input.record.time.precision === "day"
                ? `${input.record.time.value}T00:00:00Z`
                : null;
          if (!soldAt) throw new Error("qualified_time_unknown");
          await c.query(
            "INSERT INTO query_calculation_inputs(query_id,sale_event_id,price_usd_cents,sold_at,sale_format) VALUES($1,$2,$3,$4,$5)",
            [q.id, r.sale_event_id, input.priceCents, soldAt, input.record.format],
          );
          if (position < p.limit)
            await c.query(
              "INSERT INTO query_result_items(query_id,sale_event_id,presentation_order,visible_payload) VALUES($1,$2,$3,$4)",
              [
                q.id,
                r.sale_event_id,
                position,
                JSON.stringify(comparablePayload(r.sale_event_id, input.record, input.priceCents, soldAt)),
              ],
            );
        }
        await c.query(
          "UPDATE queries SET compute_status='completed',result_state='ready',version=version+1 WHERE id=$1",
          [q.id],
        );
        await c.query(
          "UPDATE query_jobs SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=$2,version=version+1,error_code=NULL WHERE id=$1",
          [j.id, now],
        );
      });
      return { jobId: lease.jobId, status: "completed" };
    } catch (error) {
      // Keep the DB lease for normal recovery after the transaction outcome becomes readable again.
      if (isDatabaseConnectionError(error)) throw error;
      const code = error instanceof AppError ? error.code : "service_unavailable";
      await transaction(this.db, async (c) => {
        const q = (await c.query("SELECT user_id FROM queries WHERE id=$1", [lease.queryId])).rows[0];
        if (q) await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [q.user_id]);
        await c.query("SELECT id FROM queries WHERE id=$1 FOR UPDATE", [lease.queryId]);
        const updated = await c.query(
          "UPDATE query_jobs SET status='failed',error_code=$3,retryable=false,lease_owner=NULL,lease_until=NULL,updated_at=$4,version=version+1 WHERE id=$1 AND lease_owner=$2 AND status='running' RETURNING query_id",
          [lease.jobId, lease.token, code, await this.now(c)],
        );
        if (updated.rowCount)
          await c.query("UPDATE queries SET compute_status='failed',version=version+1 WHERE id=$1", [
            lease.queryId,
          ]);
      });
      return { jobId: lease.jobId, status: "failed", error: code };
    }
  }
  private async readable(
    c: Transaction,
    identity: Identity,
    id: string,
    claim: boolean,
    key?: string,
    deliveredOnly = false,
  ) {
    const now = await this.owner(c, identity);
    let keyHash: string | undefined;
    if (claim) {
      if (!key || !/^[\x21-\x7e]{16,128}$/.test(key))
        fail("invalid_parameter", 400, "A valid Idempotency-Key is required.");
      keyHash = createHash("sha256")
        .update(key ?? "")
        .digest("hex");
      const prior = (
        await c.query(
          "SELECT * FROM idempotency_records WHERE owner_scope=$1 AND operation='query.claim' AND key_hash=$2",
          [identity.userId, keyHash],
        )
      ).rows[0];
      if (prior && prior.expires_at > now && prior.request_hash !== id)
        fail("idempotency_conflict", 409, "Idempotency key was used for another query.");
    }
    const q = (
      await c.query(
        "SELECT q.*,r.stats,r.quality,r.candidate_set_hash,r.supplemental_stats,r.diagnostics,r.data_as_of,r.parser_versions,r.engine_version,r.cleaner_version,r.source_scope,r.source_window_start,r.source_window_end FROM queries q LEFT JOIN query_results r ON r.query_id=q.id WHERE q.id=$1 AND q.user_id=$2 FOR UPDATE OF q",
        [id, identity.userId],
      )
    ).rows[0];
    if (!q) fail("not_found", 404, "Query not found.");
    const delivered = ["charged", "refunded", "not_required"].includes(q.settlement_status);
    if (deliveredOnly && (!delivered || !q.delivered_at))
      fail("result_not_claimed", 409, "Save a result only after delivery.");
    await this.assertSnapshotRights(c, id, now);
    if (q.compute_status !== "completed") fail("state_conflict", 409, "Query computation is not complete.");
    if (
      q.engine_version !== VERSIONS.engine ||
      !compatibleCleaner(q.filters, q.cleaner_version) ||
      q.normalizer_version !== VERSIONS.normalizer ||
      q.billing_policy_version !== VERSIONS.billing
    )
      fail("state_conflict", 409, "Snapshot versions require recomputation.");
    if (!delivered && q.expires_at <= now) fail("result_expired", 410, "Unclaimed query expired.");
    const state = availability({
      now: now.toISOString(),
      dataAsOf: iso(q.data_as_of),
      currentRights: "allowed",
      snapshotExists: true,
      allowStale: q.allow_stale,
      verifiedSamples: q.stats.n_price_verified,
    });
    if (!delivered && !state.readable)
      fail(
        state.freshness === "expired" ? "data_expired" : "source_unavailable",
        503,
        "Snapshot is no longer available as a current price.",
      );
    let charged: 0 | 1 = 0;
    if (!delivered) {
      if (state.potentialCredits && !claim)
        throw new AppError("result_not_claimed", 409, "Explicit claim is required.", {
          claim_url: `/v1/sold/${id}/claim`,
          result_state: "ready",
        });

      if (state.potentialCredits)
        charged = (await this.billing.consumeLocked(c, identity.userId, id, q.candidate_set_hash, now))
          .charged;
      await c.query(
        "UPDATE queries SET settlement_status=$2,result_state='available',delivered_at=$3,version=version+1 WHERE id=$1",
        [id, state.potentialCredits ? "charged" : "not_required", now],
      );
      q.settlement_status = state.potentialCredits ? "charged" : "not_required";
    }
    if (claim)
      await c.query(
        "INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at) VALUES($1,'query.claim',$2,$3::text,$3::uuid,'committed',$4) ON CONFLICT(owner_scope,operation,key_hash) DO UPDATE SET request_hash=excluded.request_hash,resource_id=excluded.resource_id,expires_at=excluded.expires_at",
        [identity.userId, keyHash, id, new Date(now.getTime() + 86400000)],
      );
    return { q, now, state, charged, history: delivered };
  }
  private async resultLocked(
    c: Transaction,
    r: Awaited<ReturnType<QueryService["readable"]>>,
    requestId: string,
    sort?: PresentationSort,
  ) {
    const { q, now, state, charged, history } = r;
    const policy = await permissions(c, q.id);
    const candidates = (
      await c.query(
        `SELECT s.source_id,s.candidate,i.sale_event_id,i.price_usd_cents,i.sold_at
         FROM query_calculation_inputs i JOIN query_snapshot_records s USING (query_id,sale_event_id)
         WHERE i.query_id=$1 ORDER BY i.sale_event_id`,
        [q.id],
      )
    ).rows.flatMap((row) => {
      const allowed = policy.get(row.source_id);
      if (!allowed || !canPrice(allowed)) return [];
      const record = { ...row.candidate, sourceId: row.source_id } as Candidate;
      if (sort) record.eventKey = row.sale_event_id;
      if (!allowed.has("title")) delete record.title;
      if (!allowed.has("condition")) delete record.condition;
      delete record.sellerDisplayName;
      return [{ row, record, price: Number(row.price_usd_cents), allowed }];
    });
    const shown = sortComparables(candidates, sort).slice(0, q.requested_limit);
    const images = await this.imageViews(
      c,
      q.id,
      shown.filter(({ allowed }) => allowed.has("primary_image")).map(({ row }) => row.sale_event_id),
      now,
    );
    const comps = shown.map(({ row, record, price, allowed }) => ({
      ...comparablePayload(row.sale_event_id, record, price, iso(row.sold_at)),
      primary_image: allowed.has("primary_image")
        ? (images.get(row.sale_event_id) ?? missingImage)
        : withheldImage,
    }));
    const stopped = Boolean(
      (
        await c.query(
          "SELECT 1 FROM query_result_sources r JOIN sources s ON s.id=r.source_id LEFT JOIN collector_circuits x ON x.source_id=r.source_id AND x.category_key='*' LEFT JOIN collector_daily_budget_policies p ON p.source_id=s.id AND p.policy_hash=s.daily_budget_policy_hash WHERE r.query_id=$1 AND (x.status<>'closed' OR (s.daily_budget_policy_hash IS NOT NULL AND (p.source_id IS NULL OR p.valid_from>$2 OR p.valid_until<=$2))) LIMIT 1",
          [q.id, now],
        )
      ).rowCount,
    );
    const stats = q.stats,
      supplemental = q.supplemental_stats;
    return {
      data: {
        query_id: q.id,
        query: q.filters,
        stats,
        quality: qualityReport(
          q,
          state.freshness !== "fresh",
          allSourcesAllow(policy, "attributes") ? "details" : "hidden",
        ),
        comps,
        supplemental_stats: supplemental
          ? {
              ...supplemental,
              shipping_summary:
                supportsVerifiedShippingContexts(q.parser_versions) &&
                allSourcesAllow(policy, "shipping_context", "shipping")
                  ? supplemental.shipping_summary
                  : { groups: [], mixed_contexts: false, unknown_or_withheld_count: stats.n_price_verified },
              seller_summary: allSourcesAllow(policy, "seller_aggregate")
                ? supplemental.seller_summary
                : {
                    distinct_count: null,
                    identified_count: 0,
                    unknown_or_withheld_count: stats.n_price_verified,
                  },
              source_reported_match_count: allSourcesAllow(policy, "source_match_count")
                ? (supplemental.source_reported_match_count ?? null)
                : null,
            }
          : supplemental,
      },
      meta: {
        request_id: requestId,
        credits_charged: charged,
        query_total_credits_charged: q.settlement_status === "charged" ? 1 : 0,
        cache_hit: history,
        reused: history,
        engine_version: q.engine_version,
        cleaner_version: q.cleaner_version,
        normalizer_version: q.normalizer_version,
        billing_policy_version: q.billing_policy_version,
        data_as_of: iso(q.data_as_of),
        evaluated_at: q.as_of.toISOString(),
        stale: state.freshness !== "fresh",
        freshness_state: state.freshness,
        result_mode: history ? "history" : "current",
        source_status: stopped ? "stopped" : state.freshness === "fresh" ? "healthy" : "degraded",
        coverage_status: "unknown",
        archive_coverage: null,
        source_scope: q.source_scope,
        parser_versions: q.parser_versions,
        candidate_set_hash: q.candidate_set_hash,
        returned_comp_count: comps.length,
        available_comp_count: stats.n_price_verified,
        permitted_comp_count: candidates.length,
        truncated: comps.length < stats.n_price_verified,
        truncation_reasons: [
          ...(candidates.length < stats.n_price_verified ? ["field_rights"] : []),
          ...(comps.length < candidates.length ? ["presentation_limit"] : []),
        ],
        source_window_start: iso(q.source_window_start),
        source_window_end: iso(q.source_window_end),
        data_mode: "synthetic_fixture",
      },
    };
  }
  async result(
    identity: Identity,
    id: string,
    requestId: string,
    claim = false,
    key?: string,
    sort?: PresentationSort,
  ) {
    return transaction(this.db, async (c) =>
      this.resultLocked(c, await this.readable(c, identity, id, claim, key), requestId, sort),
    );
  }
  async readSnapshot<T>(
    identity: Identity,
    id: string,
    work: (c: Transaction, result: Awaited<ReturnType<QueryService["readable"]>>) => Promise<T>,
  ) {
    return transaction(this.db, async (c) => work(c, await this.readable(c, identity, id, false)));
  }
  async readDeliveredSnapshot(c: Transaction, identity: Identity, id: string) {
    return this.readable(c, identity, id, false, undefined, true);
  }
  private async imageViews(c: Transaction, id: string, eventIds: string[], now: Date) {
    const images = new Map<
      string,
      { state: string; url: string | null; width: number | null; height: number | null }
    >();
    if (!eventIds.length) return images;
    const { rows } = await c.query(
      `SELECT i.sale_event_id,i.id,i.state,i.retention_until,i.permission_epoch,i.width,i.height,
              src.permission_epoch AS current_epoch,src.media_store_identity AS storage_identity
       FROM listing_images i JOIN sources src ON src.id=i.source_id
       JOIN query_snapshot_records s ON (s.sale_event_id,s.observation_id,s.listing_id,s.source_id)=(i.sale_event_id,i.observation_id,i.listing_id,i.source_id)
       WHERE s.query_id=$1 AND s.sale_event_id=ANY($2::uuid[]) AND i.role='primary'`,
      [id, eventIds],
    );
    const storage = rows.some((image) => image.state === "available")
      ? await this.media.storageIdentity().catch(() => null)
      : null;
    for (const image of rows) {
      let state = image.state;
      if (state === "available") {
        if (image.permission_epoch !== image.current_epoch) state = "revoked";
        else if (!image.retention_until || image.retention_until <= now) state = "expired";
        else if (!storage || (image.storage_identity && image.storage_identity !== storage)) state = "failed";
      }
      const available = state === "available";
      images.set(image.sale_event_id, {
        state,
        url: available ? `/v1/media/${image.id}` : null,
        width: available ? image.width : null,
        height: available ? image.height : null,
      });
    }
    return images;
  }
  async imageView(c: Transaction, id: string, eventId: string, now: Date) {
    return (await this.imageViews(c, id, [eventId], now)).get(eventId) ?? missingImage;
  }
  async calculation(identity: Identity, id: string) {
    return transaction(this.db, async (c) => {
      const { q } = await this.readable(c, identity, id, false);
      return this.calculationLocked(c, q);
    });
  }
  async calculationLocked(c: Transaction, q: Awaited<ReturnType<QueryService["readable"]>>["q"]) {
    const id = q.id;
    const policy = await permissions(c, id);
    if ([...policy.values()].some((p) => !canPrice(p)))
      fail("forbidden", 403, "Current field rights do not allow complete calculation inputs.");
    const items = (
      await c.query(
        `SELECT i.sale_event_id,i.price_usd_cents,i.sold_at,i.sale_format,s.candidate->'time' AS sold_date
           FROM query_calculation_inputs i LEFT JOIN query_snapshot_records s USING (query_id,sale_event_id)
           WHERE i.query_id=$1 ORDER BY i.sale_event_id`,
        [id],
      )
    ).rows.map((r) => ({
      ...r,
      price_usd_cents: Number(r.price_usd_cents),
      sold_at: iso(r.sold_at),
      sold_date: saleDateEvidence(r.sold_date),
    }));
    return {
      query_id: id,
      candidate_set_hash: q.candidate_set_hash,
      as_of: iso(q.as_of),
      price_basis: q.price_basis,
      versions: {
        engine_version: q.engine_version,
        cleaner_version: q.cleaner_version,
        billing_policy_version: q.billing_policy_version,
        normalizer_version: q.normalizer_version,
      },
      original_stats: q.stats,
      items,
      is_complete: true,
    };
  }
  async job(identity: Identity, id: string) {
    return transaction(this.db, async (c) => {
      const now = await this.owner(c, identity, "jobs:read");
      return this.jobView(c, identity.userId, id, now);
    });
  }
  private async jobView(c: Transaction, owner: string, id: string, now: Date) {
    const j = (
      await c.query(
        "SELECT j.*,q.compute_status,q.result_state,q.settlement_status FROM query_jobs j JOIN queries q ON q.id=j.query_id WHERE j.id=$1 AND q.user_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!j) fail("not_found", 404, "Job not found.");
    return {
      job_id: j.id,
      query_id: j.query_id,
      status: j.status,
      compute_status: j.compute_status,
      result_state:
        j.status === "completed" && j.settlement_status === "pending" && j.expires_at <= now
          ? "expired"
          : j.result_state,
      settlement_status: j.settlement_status,
      attempt_count: j.attempt_count,
      created_at: iso(j.created_at),
      updated_at: iso(j.updated_at),
      expires_at: iso(j.expires_at),
      error_code: j.error_code,
      retryable: j.retryable,
      result_url: j.status === "completed" ? `/v1/sold/${j.query_id}` : null,
      claim_url: j.status === "completed" ? `/v1/sold/${j.query_id}/claim` : null,
      version: j.version,
    };
  }
  async cancel(identity: Identity, id: string, version: number, key: string | undefined) {
    if (!key || !/^[\x21-\x7e]{16,128}$/.test(key))
      throw new AppError("invalid_parameter", 400, "A valid Idempotency-Key is required.");
    const keyHash = createHash("sha256").update(key).digest("hex");
    const requestHash = createHash("sha256").update(`${id}:${version}`).digest("hex");
    return transaction(this.db, async (c) => {
      const now = await this.owner(c, identity, "jobs:read");
      const peek = (
        await c.query(
          "SELECT j.query_id FROM query_jobs j JOIN queries q ON q.id=j.query_id WHERE j.id=$1 AND q.user_id=$2",
          [id, identity.userId],
        )
      ).rows[0];
      if (!peek) fail("not_found", 404, "Job not found.");
      const previous = (
        await c.query(
          "SELECT request_hash FROM idempotency_records WHERE owner_scope=$1 AND operation='query.cancel' AND key_hash=$2 AND expires_at>$3",
          [identity.userId, keyHash, now],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          fail("idempotency_conflict", 409, "Idempotency key was used for a different cancellation.");
        return this.jobView(c, identity.userId, id, now);
      }
      await c.query("SELECT id FROM queries WHERE id=$1 FOR UPDATE", [peek.query_id]);
      const j = (await c.query("SELECT * FROM query_jobs WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (j.version !== version) fail("state_conflict", 409, "Job version changed.");
      if (!["queued", "running"].includes(j.status)) fail("state_conflict", 409, "Job cannot be cancelled.");
      await c.query(
        "UPDATE query_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,retryable=false,error_code=NULL,updated_at=$2,version=version+1 WHERE id=$1",
        [id, now],
      );
      await c.query("UPDATE queries SET compute_status='cancelled',version=version+1 WHERE id=$1", [
        peek.query_id,
      ]);
      await c.query(
        `INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at)
         VALUES($1,'query.cancel',$2,$3,$4,'committed',$5)
         ON CONFLICT(owner_scope,operation,key_hash) DO UPDATE SET
         request_hash=excluded.request_hash,resource_id=excluded.resource_id,expires_at=excluded.expires_at`,
        [identity.userId, keyHash, requestHash, id, new Date(now.getTime() + 86400000)],
      );
      return this.jobView(c, identity.userId, id, now);
    });
  }
  async image(identity: Identity, imageId: string) {
    return transaction(this.db, async (c) => {
      const now = await this.owner(c, identity);
      const links = (
        await c.query(
          "SELECT DISTINCT q.id FROM queries q JOIN query_snapshot_records s ON s.query_id=q.id JOIN listing_images i ON i.sale_event_id=s.sale_event_id AND i.listing_id=s.listing_id AND i.observation_id=s.observation_id AND i.source_id=s.source_id WHERE q.user_id=$1 AND i.id=$2 AND q.result_state='available' ORDER BY q.id",
          [identity.userId, imageId],
        )
      ).rows;
      if (!links.length) fail("not_found", 404, "Image not found.");
      await this.assertImageSnapshotRights(c, links, now);
      const i = (await c.query("SELECT * FROM listing_images WHERE id=$1 FOR SHARE", [imageId])).rows[0];
      if (!i) fail("not_found", 404, "Image not found.");
      for (const link of links) {
        const allowed = (await permissions(c, link.id)).get(i.source_id);
        if (!allowed?.has("primary_image") || !allowed.has("identity"))
          fail("not_found", 404, "Image not found.");
      }
      const source = (
        await c.query("SELECT permission_epoch,media_store_identity FROM sources WHERE id=$1", [i.source_id])
      ).rows[0];
      if (
        i.state !== "available" ||
        !i.retention_until ||
        i.retention_until <= now ||
        i.permission_epoch !== source.permission_epoch ||
        !i.object_key
      )
        fail("not_found", 404, "Image not found.");
      let bytes: Buffer;
      try {
        bytes = await this.media.get(i.object_key, source.media_store_identity ?? undefined);
      } catch (error) {
        if (
          error instanceof Error &&
          ([
            "media_store_mismatch",
            "media_hash_mismatch",
            "invalid_media_object",
            "unsafe_media_directory",
          ].includes(error.message) ||
            ("code" in error && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))))
        )
          fail("not_found", 404, "Image not found.");
        throw error;
      }

      // The locks prevent concurrent rights changes, but an expiry can pass during object I/O.
      const afterRead = await this.now(c);
      if (afterRead >= i.retention_until) fail("not_found", 404, "Image not found.");
      if (afterRead.getTime() !== now.getTime()) {
        await this.auth.assertIdentityLocked(c, identity, "sold:read", afterRead);
        await this.assertImageSnapshotRights(c, links, afterRead);
      }
      return bytes;
    });
  }
  private async assertImageSnapshotRights(c: Transaction, links: { id: string }[], clock: Date) {
    // A withdrawn linked query cannot be bypassed through another cached result.
    for (const link of links) {
      try {
        await this.assertSnapshotRights(c, link.id, clock);
      } catch (error) {
        if (error instanceof AppError && ["forbidden", "source_unavailable"].includes(error.code))
          fail("not_found", 404, "Image not found.");
        throw error;
      }
    }
  }
  makeCursor(owner: string, kind: string, row: { id: string; cursor_at: string }) {
    const data = Buffer.from(JSON.stringify({ owner, kind, id: row.id, time: row.cursor_at })).toString(
      "base64url",
    );
    return `${data}.${this.auth.crypto.hash("query.cursor", data)}`;
  }
  readCursor(owner: string, kind: string, value?: string) {
    if (!value) return null;
    const [data, signature, ...extra] = value.split(".");
    if (
      value.length > 2048 ||
      extra.length ||
      !data ||
      !signature ||
      !this.auth.crypto.equal(signature, this.auth.crypto.hash("query.cursor", data))
    )
      fail("invalid_parameter", 400, "Invalid cursor.");
    let row: { owner?: unknown; kind?: unknown; id?: unknown; time?: unknown } | null = null;
    try {
      row = JSON.parse(Buffer.from(data ?? "", "base64url").toString());
    } catch {
      fail("invalid_parameter", 400, "Invalid cursor.");
    }
    if (
      row?.owner !== owner ||
      row.kind !== kind ||
      typeof row.id !== "string" ||
      typeof row.time !== "string" ||
      !/^[a-f0-9-]{36}$/.test(row.id) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.time)
    )
      fail("invalid_parameter", 400, "Invalid cursor scope.");
    return row as { id: string; time: string };
  }
  async history(identity: Identity, cursor?: string, pageSize = 20) {
    if (!identity.sessionId || identity.keyId)
      fail("forbidden", 403, "Research history requires an account session.");
    return transaction(this.db, async (c) => {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
        fail("invalid_parameter", 400, "Invalid page size.");
      await this.owner(c, identity);
      const after = this.readCursor(identity.userId, "queries", cursor);
      const rows = (
        await c.query(
          `SELECT q.*,j.id AS job_id,to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM queries q LEFT JOIN query_jobs j ON j.query_id=q.id WHERE q.user_id=$1 AND ($2::timestamptz IS NULL OR (q.created_at,q.id)<($2::timestamptz,$3::uuid)) ORDER BY q.created_at DESC,q.id DESC LIMIT $4`,
          [identity.userId, after?.time ?? null, after?.id ?? null, pageSize + 1],
        )
      ).rows;
      const page = rows.slice(0, pageSize);
      return {
        items: page.map((q) => ({
          query_id: q.id,
          q: q.normalized_query,
          filters: q.filters,
          created_at: iso(q.created_at),
          compute_status: q.compute_status,
          settlement_status: q.settlement_status,
          result_state: q.result_state,
          credits_charged: q.settlement_status === "charged" ? 1 : 0,
          job_id: q.job_id,
        })),
        next_cursor:
          rows.length > pageSize ? this.makeCursor(identity.userId, "queries", page[page.length - 1]) : null,
      };
    });
  }
  async usage(identity: Identity, cursor?: string, pageSize = 20) {
    return transaction(this.db, async (c) => {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
        fail("invalid_parameter", 400, "Invalid page size.");
      const after = this.readCursor(identity.userId, "ledger", cursor);
      const now = await this.owner(c, identity, "usage:read"),
        user = (await c.query("SELECT id,free_anchor_at FROM users WHERE id=$1", [identity.userId])).rows[0];
      await this.billing.expireLocked(c, identity.userId, now);
      await this.billing.ensureFreeLocked(c, user, now);
      const wallets = (
        await c.query(
          "SELECT id,bucket_type,balance,expires_at,period_start,period_end,status FROM credit_wallets WHERE user_id=$1 AND status='active' ORDER BY expires_at NULLS LAST,id",
          [identity.userId],
        )
      ).rows;
      const ledger = (
        await c.query(
          `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM credit_ledger WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
          [identity.userId, after?.time ?? null, after?.id ?? null, pageSize + 1],
        )
      ).rows;
      const subscription = (
        await c.query(
          "SELECT status FROM subscriptions WHERE user_id=$1 ORDER BY current_period_end DESC LIMIT 1",
          [identity.userId],
        )
      ).rows[0];
      return {
        wallets: wallets.map((w) => ({
          id: w.id,
          type: w.bucket_type,
          balance: w.balance,
          expires_at: iso(w.expires_at),
          period_start: iso(w.period_start),
          period_end: iso(w.period_end),
        })),
        total_available: wallets.reduce((n, w) => n + w.balance, 0),
        subscription_status: subscription?.status ?? "free",
        policy_version: VERSIONS.billing,
        ledger: ledger.slice(0, pageSize).map((l) => ({
          id: l.id,
          delta: l.delta,
          balance_after: l.balance_after,
          kind: l.kind,
          query_id: l.ref_type === "query" ? l.ref_id : null,
          created_at: iso(l.created_at),
        })),
        next_cursor:
          ledger.length > pageSize ? this.makeCursor(identity.userId, "ledger", ledger[pageSize - 1]) : null,
        credit_recovery_open: await this.billing.hasPaymentHold(c, identity.userId),
      };
    });
  }
}
export function safeCsvCell(value: unknown) {
  return csv(value);
}

export * from "./alerts.ts";
export * from "./batch.ts";
export * from "./best-offer.ts";
export * from "./history-archive.ts";
export * from "./inventory.ts";
export * from "./lookup.ts";
export { PublicResults } from "./public-results.ts";
export * from "./request-audit.ts";
export * from "./research.ts";
export { SavedResearch } from "./saved-research.ts";
