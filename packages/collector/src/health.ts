import { instant } from "@soldbench/core";
import { type Database, transaction } from "@soldbench/db";
import { COLLECTOR_VERSION, PARSER_VERSION } from "./fixture.ts";
/** Internal aggregate facts, deliberately excludes item text, URLs, credentials and prices. */
export async function collectorHealth(
  db: Database,
  sourceId: string,
  options: { now?: string; from?: string; persist?: boolean } = {},
) {
  return transaction(db, async (c) => {
    const source = (
      await c.query(
        "SELECT s.*,x.provider,x.status AS clearance_status,x.effective_at,x.expires_at FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 FOR SHARE OF s,x",
        [sourceId],
      )
    ).rows[0];
    if (source?.access_method !== "offline_fixture" || source.provider !== "synthetic_fixture")
      throw new Error("network_collector_not_enabled");
    const now = options.now
        ? new Date(instant(options.now))
        : ((await c.query("SELECT clock_timestamp() t")).rows[0].t as Date),
      from = options.from ? new Date(instant(options.from)) : new Date(now.getTime() - 86400000);
    if (from > now || now.getTime() - from.getTime() > 366 * 86400000)
      throw new Error("invalid_health_window");
    const counts = (
      await c.query(
        "SELECT count(*)::int enqueued,count(*) FILTER(WHERE status='completed')::int completed,count(*) FILTER(WHERE status='failed')::int failed,count(*) FILTER(WHERE status='expired')::int expired,count(*) FILTER(WHERE status='cancelled')::int cancelled,count(*) FILTER(WHERE status IN ('queued','retry','running'))::int pending,count(*) FILTER(WHERE status='running' AND lease_until<=$3)::int lost_leases,count(*) FILTER(WHERE status='completed' AND page_count>0 AND page_count=(SELECT count(*) FROM collector_dispatches d WHERE d.job_id=j.id AND d.kind='page' AND d.dispatched_at IS NOT NULL))::int first_pass_page_jobs FROM collector_jobs j WHERE source_id=$1 AND created_at>=$2 AND created_at<=$3",
        [sourceId, from, now],
      )
    ).rows[0];
    const bytes = (
      await c.query(
        "SELECT count(*) FILTER(WHERE dispatched_at IS NOT NULL)::int dispatched,count(*) FILTER(WHERE state='reserved')::int reserved,count(*) FILTER(WHERE state='abandoned')::int abandoned,coalesce(sum(actual_bytes) FILTER(WHERE state='settled'),0)::text settled_bytes,coalesce(sum(max_bytes) FILTER(WHERE state='abandoned'),0)::text unconfirmed_budget_bytes FROM collector_dispatches WHERE source_id=$1 AND created_at>=$2 AND created_at<=$3",
        [sourceId, from, now],
      )
    ).rows[0];
    const images = (
      await c.query(
        "SELECT state,count(*)::int n FROM listing_images WHERE source_id=$1 AND created_at>=$2 AND created_at<=$3 GROUP BY state ORDER BY state",
        [sourceId, from, now],
      )
    ).rows;
    const retries = (
      await c.query(
        "SELECT status,count(*)::int n,coalesce(sum(attempts),0)::int attempts FROM collector_image_jobs WHERE source_id=$1 AND created_at>=$2 AND created_at<=$3 GROUP BY status ORDER BY status",
        [sourceId, from, now],
      )
    ).rows;
    const watermarks = (
      await c.query(
        "SELECT count(*)::int total,count(*) FILTER(WHERE data_as_of>$2)::int future,count(*) FILTER(WHERE data_as_of<=$2 AND data_as_of>=$2-interval '24 hours')::int fresh,count(*) FILTER(WHERE data_as_of<$2-interval '24 hours' AND data_as_of>=$2-interval '72 hours')::int stale,count(*) FILTER(WHERE data_as_of<$2-interval '72 hours')::int expired,min(data_as_of) oldest,max(data_as_of) newest FROM collector_watermarks WHERE source_id=$1",
        [sourceId, now],
      )
    ).rows[0];
    const circuit = (
      await c.query(
        "SELECT status,opened_reason,opened_at FROM collector_circuits WHERE source_id=$1 AND category_key='*'",
        [sourceId],
      )
    ).rows[0];
    const last = (
      await c.query(
        "SELECT max(completed_at) t FROM collector_runs WHERE source_id=$1 AND outcome='completed'",
        [sourceId],
      )
    ).rows[0].t as Date | null;
    const budget = (
      await c.query(
        "SELECT day::text,budget_kind,cap::text,used::text,reserved::text FROM source_daily_budget WHERE source_id=$1 AND day=$2 ORDER BY budget_kind",
        [sourceId, now.toISOString().slice(0, 10)],
      )
    ).rows;
    const quarantines = (
      await c.query(
        "SELECT count(*)::int n FROM collector_quarantines WHERE source_id=$1 AND captured_at>=$2 AND captured_at<=$3",
        [sourceId, from, now],
      )
    ).rows[0].n;
    const fraction = (numerator: number, denominator: number) => ({
      numerator,
      denominator,
      ratio: denominator ? numerator / denominator : null,
    });
    const plans = (
      await c.query(
        "SELECT start_at,interval_seconds,retired_at FROM collector_refresh_plans WHERE source_id=$1",
        [sourceId],
      )
    ).rows;
    let planned = 0;
    for (const p of plans) {
      const start = p.start_at.getTime(),
        interval = p.interval_seconds * 1000,
        end = Math.min(now.getTime(), p.retired_at ? p.retired_at.getTime() - 1 : now.getTime());
      const first = Math.max(0, Math.ceil((from.getTime() - start) / interval)),
        last = Math.floor((end - start) / interval);
      planned += Math.max(0, last - first + 1);
    }
    const execution = (
      await c.query(
        "SELECT count(*)::int materialized,count(*) FILTER(WHERE j.started_at IS NOT NULL AND j.started_at<=$3)::int started,count(*) FILTER(WHERE j.started_at IS NOT NULL AND j.started_at<=o.deadline_at AND j.started_at<=$3)::int on_time FROM collector_refresh_occurrences o LEFT JOIN collector_jobs j ON j.source_id=o.source_id AND j.run_key=('refresh:'||o.id::text) WHERE o.source_id=$1 AND o.scheduled_for>=$2 AND o.scheduled_for<=$3",
        [sourceId, from, now],
      )
    ).rows[0];
    const refreshStates = (
      await c.query(
        "SELECT status,count(*)::int n FROM collector_refresh_occurrences WHERE source_id=$1 AND scheduled_for>=$2 AND scheduled_for<=$3 GROUP BY status ORDER BY status",
        [sourceId, from, now],
      )
    ).rows;
    const report = {
      schema: "soldbench.collector-health.v1",
      mode: "offline_fixture",
      onlineVerified: false,
      networkRequests: 0,
      collectorVersion: COLLECTOR_VERSION,
      parserVersion: PARSER_VERSION,
      sourceId,
      clock: options.now ? "explicit_simulation" : "database",
      retryAfterUntil: source.retry_after_until?.toISOString() ?? null,
      capturedAt: now.toISOString(),
      window: { from: from.toISOString(), until: now.toISOString() },
      sourceStatus: source.status,
      permissionEpoch: String(source.permission_epoch),
      circuit: circuit?.status ?? "closed",
      sourceStopped:
        source.status !== "active" ||
        !["draft", "reviewed", "active"].includes(source.clearance_status) ||
        Boolean(source.effective_at && source.effective_at > now) ||
        Boolean(source.expires_at && source.expires_at <= now) ||
        Boolean(circuit && circuit.status !== "closed"),
      lastSuccessAt: last?.toISOString() ?? null,
      jobs: counts,
      pageSemanticCompletion: fraction(counts.completed, counts.enqueued),
      firstPassPageJobs: fraction(counts.first_pass_page_jobs, counts.enqueued),
      scheduleExecutionRate: plans.length ? fraction(execution.started, planned) : null,
      scheduleOnTimeRate: plans.length ? fraction(execution.on_time, planned) : null,
      scheduleDenominator: plans.length ? "frozen_refresh_plan" : "no_frozen_schedule_evidence",
      refresh: {
        frozenPlans: plans.length,
        planned,
        materialized: execution.materialized,
        unmaterialized: Math.max(0, planned - execution.materialized),
        states: refreshStates,
      },
      freshWatermarks: fraction(watermarks.fresh, watermarks.total),
      watermarks: {
        ...watermarks,
        oldest: watermarks.oldest?.toISOString() ?? null,
        newest: watermarks.newest?.toISOString() ?? null,
      },
      dispatches: bytes,
      images,
      retries,
      budget,
      quarantines,
      measuredCostCents: null,
      actualEbayFieldVerification: "unverified",
      limitations: [
        "Synthetic offline execution only.",
        "Job completion is not verified-price or whole-market coverage.",
        "Pending jobs remain in the completion denominator.",
        "Abandoned bytes are conservative budget usage, not measured transport bytes.",
        "No actual source cost or 14-day/production stability certification; frozen schedules are synthetic intent.",
      ],
    };
    if (options.persist)
      await c.query(
        "INSERT INTO collector_health_snapshots(source_id,captured_at,last_success_at,metrics) VALUES($1,$2,$3,$4)",
        [sourceId, now, last, JSON.stringify(report)],
      );
    return report;
  });
}
