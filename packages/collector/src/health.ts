import { instant } from "@soldbench/core";
import { type Database, type Transaction, transaction } from "@soldbench/db";
import type { PrivateMediaStore } from "@soldbench/media";
import { COLLECTOR_VERSION, PARSER_VERSION } from "./fixture.ts";
import { mediaHealth } from "./media-health.ts";

const dayMs = 86400000;
type FrozenPlan = { start_at: Date; interval_seconds: number; retired_at: Date | null };

function scheduledCount(plans: FrozenPlan[], from: number, through: number) {
  return plans.reduce((total, plan) => {
    const start = plan.start_at.getTime(),
      interval = plan.interval_seconds * 1000,
      end = plan.retired_at ? Math.min(through, plan.retired_at.getTime() - 1) : through,
      first = Math.max(0, Math.ceil((from - start) / interval)),
      last = Math.floor((end - start) / interval);
    return total + Math.max(0, last - first + 1);
  }, 0);
}

/** Internal aggregate facts, deliberately excludes item text, URLs, credentials and prices. */
export async function collectorHealth(
  db: Database,
  sourceId: string,
  options: {
    now?: string;
    from?: string;
    persist?: boolean;
    dailyDays?: 7 | 14;
    mediaProbe?: { store: PrivateMediaStore; limit: number };
  } = {},
) {
  const probeLimit = options.mediaProbe?.limit;
  if (options.dailyDays !== undefined && options.dailyDays !== 7 && options.dailyDays !== 14)
    throw new Error("invalid_collector_daily_window");
  if (options.mediaProbe && options.now !== undefined) throw new Error("media_probe_requires_database_clock");
  if (probeLimit !== undefined && (!Number.isSafeInteger(probeLimit) || probeLimit < 1 || probeLimit > 20))
    throw new Error("invalid_media_probe_limit");
  return transaction(db, async (c) => {
    if (options.dailyDays) await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const source = (
      await c.query(
        "SELECT s.*,x.provider,x.status AS clearance_status,x.effective_at,x.expires_at,x.permitted_fields FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 FOR SHARE OF s,x",
        [sourceId],
      )
    ).rows[0];
    if (source?.access_method !== "offline_fixture" || source.provider !== "synthetic_fixture")
      throw new Error("network_collector_not_enabled");
    const now = options.now
        ? new Date(instant(options.now))
        : ((await c.query("SELECT clock_timestamp() t")).rows[0].t as Date),
      from = options.from ? new Date(instant(options.from)) : new Date(now.getTime() - dayMs);
    if (from > now || now.getTime() - from.getTime() > 366 * dayMs) throw new Error("invalid_health_window");
    const sourceRights =
      source.status === "active" &&
      ["draft", "reviewed", "active"].includes(source.clearance_status) &&
      (!source.effective_at || source.effective_at <= now) &&
      (!source.expires_at || source.expires_at > now);
    const media = await mediaHealth(
      c,
      sourceId,
      now,
      source.permission_epoch,
      source.media_store_identity,
      source.expires_at,
      sourceRights &&
        Array.isArray(source.permitted_fields?.research) &&
        source.permitted_fields.research.includes("primary_image"),
      options.mediaProbe,
    );
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
    const policy = (
      await c.query(
        "SELECT policy_hash,valid_from,valid_until FROM collector_daily_budget_policies WHERE source_id=$1 AND policy_hash=$2",
        [sourceId, source.daily_budget_policy_hash],
      )
    ).rows[0];
    const policyUnavailable = Boolean(
      source.daily_budget_policy_hash && (!policy || policy.valid_from > now || policy.valid_until <= now),
    );
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
      await c.query<FrozenPlan>(
        "SELECT start_at,interval_seconds,retired_at FROM collector_refresh_plans WHERE source_id=$1 AND created_at<=$2",
        [sourceId, now],
      )
    ).rows;
    const planned = scheduledCount(plans, from.getTime(), now.getTime());
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
    const daily = options.dailyDays
      ? await readDailyEvidence(c, sourceId, plans, now, options.dailyDays)
      : undefined;
    const report = {
      schema: "soldbench.collector-health.v1",
      mode: "offline_fixture",
      onlineVerified: false,
      networkRequests: 0,
      networkRequestsScope: "external_source_access_only",
      collectorVersion: COLLECTOR_VERSION,
      parserVersion: PARSER_VERSION,
      sourceId,
      clock: options.now ? "explicit_simulation" : "database",
      retryAfterUntil: source.retry_after_until?.toISOString() ?? null,
      dailyBudgetPolicy: {
        status: source.daily_budget_policy_hash
          ? policyUnavailable
            ? "unavailable"
            : "active"
          : "legacy_explicit_days_only",
        hash: source.daily_budget_policy_hash,
        validUntil: policy?.valid_until.toISOString() ?? null,
      },
      capturedAt: now.toISOString(),
      window: { from: from.toISOString(), until: now.toISOString() },
      sourceStatus: source.status,
      permissionEpoch: String(source.permission_epoch),
      circuit: circuit?.status ?? "closed",
      sourceStopped: policyUnavailable || !sourceRights || Boolean(circuit && circuit.status !== "closed"),
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
      media,
      retries,
      budget,
      quarantines,
      measuredCostCents: null,
      actualEbayFieldVerification: "unverified",
      ...(daily && { daily }),
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

async function readDailyEvidence(
  c: Transaction,
  sourceId: string,
  plans: FrozenPlan[],
  now: Date,
  days: number,
) {
  const until = Math.floor(now.getTime() / dayMs) * dayMs;
  const from = until - days * dayMs;
  const parameters = [sourceId, new Date(from), new Date(until), now];
  // Occurrence counts are attributed to the scheduled day. Transport counts use the UTC dispatch day.
  const { rows: scheduleRows } = await c.query(
    `SELECT to_char(o.scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day,
       count(*)::int materialized,
       count(*) FILTER (WHERE j.started_at<=$4)::int started,
       count(*) FILTER (WHERE j.started_at<=$4 AND j.started_at<=o.deadline_at)::int on_time,
       count(*) FILTER (WHERE j.status='completed' AND j.finished_at<=$4)::int completed,
       count(*) FILTER (WHERE j.status IN ('failed','expired','cancelled') AND j.finished_at<=$4)::int failed_jobs,
       count(*) FILTER (WHERE o.status IN ('blocked','missed') AND o.finished_at<=$4)::int stopped_occurrences
     FROM collector_refresh_occurrences o
     LEFT JOIN collector_jobs j ON j.source_id=o.source_id AND j.run_key=('refresh:'||o.id::text)
     WHERE o.source_id=$1 AND o.scheduled_for>=$2 AND o.scheduled_for<$3 AND o.created_at<=$4
     GROUP BY 1`,
    parameters,
  );
  const { rows: transportRows } = await c.query(
    `SELECT to_char(dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day,
       count(*) FILTER (WHERE kind='page')::int page_attempts,
       count(*) FILTER (WHERE kind='image')::int image_attempts
     FROM collector_dispatches WHERE source_id=$1 AND dispatched_at>=$2 AND dispatched_at<$3 GROUP BY 1`,
    parameters.slice(0, 3),
  );
  const schedule = new Map(scheduleRows.map((row) => [row.utc_day, row]));
  const transport = new Map(transportRows.map((row) => [row.utc_day, row]));
  return {
    from: new Date(from).toISOString(),
    until: new Date(until).toISOString(),
    days: Array.from({ length: days }, (_, offset) => {
      const start = from + offset * dayMs;
      const day = new Date(start).toISOString().slice(0, 10);
      const planned = scheduledCount(plans, start, start + dayMs - 1);
      const row = schedule.get(day);
      return {
        day,
        planned,
        materialized: row?.materialized ?? 0,
        unmaterialized: Math.max(0, planned - (row?.materialized ?? 0)),
        started: row?.started ?? 0,
        onTime: row?.on_time ?? 0,
        completed: row?.completed ?? 0,
        failedJobs: row?.failed_jobs ?? 0,
        stoppedOccurrences: row?.stopped_occurrences ?? 0,
        pageAttempts: transport.get(day)?.page_attempts ?? 0,
        imageAttempts: transport.get(day)?.image_attempts ?? 0,
      };
    }),
  };
}
