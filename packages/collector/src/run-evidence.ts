import { type Database, transaction } from "@soldbench/db";

export type FrozenSchedule = { start_at: Date; interval_seconds: number; retired_at: Date | null };
const dayMs = 86400000;
const maxSlots = 5000;

/** Both summaries and row-level evidence use an inclusive upper bound. */
export function scheduledRange(plan: FrozenSchedule, from: number, through: number) {
  const start = plan.start_at.getTime();
  const interval = plan.interval_seconds * 1000;
  const end = plan.retired_at ? Math.min(through, plan.retired_at.getTime() - 1) : through;
  return {
    start,
    interval,
    first: Math.max(0, Math.ceil((from - start) / interval)),
    last: Math.floor((end - start) / interval),
  };
}

function utcDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid_collector_evidence_day");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error("invalid_collector_evidence_day");
  return parsed;
}

const factualRows = `
WITH slots AS MATERIALIZED (
  SELECT o.*,j.id AS matched_job_id,j.started_at AS claimed_at,j.finished_at AS job_finished_at,
         j.status AS job_status,j.collector_run_id
  FROM collector_refresh_occurrences o
  LEFT JOIN collector_jobs j ON j.source_id=o.source_id AND j.run_key=('refresh:'||o.id::text)
  WHERE o.source_id=$1 AND o.scheduled_for >= $2 AND o.scheduled_for < $3
  LIMIT $4
), dispatch AS (
  SELECT d.job_id,
    min(d.dispatched_at) FILTER (WHERE d.kind='page') AS first_page_request_at,
    count(*) FILTER (WHERE d.dispatched_at IS NOT NULL AND d.kind='page')::int page_attempts,
    count(*) FILTER (WHERE d.dispatched_at IS NOT NULL AND d.kind='image')::int image_attempts,
    count(*) FILTER (WHERE d.state='reserved')::int open_reservations,
    coalesce(sum(d.actual_bytes) FILTER (WHERE d.state='settled'),0)::text settled_bytes,
    coalesce(sum(d.max_bytes) FILTER (WHERE d.state='abandoned'),0)::text unconfirmed_bytes
  FROM collector_dispatches d JOIN slots s ON s.matched_job_id=d.job_id AND s.source_id=d.source_id
  GROUP BY d.job_id
), pages AS (
  SELECT p.job_id,count(*)::int committed_pages
  FROM collector_pages p JOIN slots s ON s.matched_job_id=p.job_id AND s.source_id=p.source_id
  GROUP BY p.job_id
), image_counts AS (
  SELECT p.job_id,i.state,count(*)::int n
  FROM collector_pages p JOIN slots s ON s.matched_job_id=p.job_id AND s.source_id=p.source_id
  JOIN listing_images i ON i.observation_id=p.observation_id AND i.source_id=p.source_id AND i.role='primary'
  GROUP BY p.job_id,i.state
), images AS (
  SELECT job_id,jsonb_object_agg(state,n) AS image_states FROM image_counts GROUP BY job_id
)
SELECT s.plan_id,s.scheduled_for,s.id AS occurrence_id,s.status AS occurrence_state,s.finished_at AS occurrence_finished_at,
       s.matched_job_id AS job_id,s.job_status,s.claimed_at,s.job_finished_at,
       r.id AS run_id,r.outcome AS run_outcome,r.parser_version,s.failure_reason AS dispatch_failure_reason,
       d.first_page_request_at,coalesce(d.page_attempts,0) AS page_attempts,coalesce(d.image_attempts,0) AS image_attempts,
       coalesce(d.open_reservations,0) AS open_reservations,coalesce(d.settled_bytes,'0') AS settled_bytes,
       coalesce(d.unconfirmed_bytes,'0') AS unconfirmed_bytes,coalesce(p.committed_pages,0) AS committed_pages,
       coalesce(i.image_states,'{}'::jsonb) AS image_states
FROM slots s
LEFT JOIN collector_runs r ON r.id=s.collector_run_id AND r.source_id=s.source_id
LEFT JOIN dispatch d ON d.job_id=s.matched_job_id
LEFT JOIN pages p ON p.job_id=s.matched_job_id
LEFT JOIN images i ON i.job_id=s.matched_job_id
`;

const slotKey = (id: string, scheduled: Date) => `${scheduled.toISOString()}/${id}`;

/** Row-level observations for a completed UTC window, in one non-mutating database snapshot. */
export async function collectorRunEvidence(
  db: Database,
  sourceId: string,
  fromDay: string,
  untilDay: string,
) {
  const from = utcDay(fromDay);
  const until = utcDay(untilDay);
  if (until <= from || until.getTime() - from.getTime() > 14 * dayMs)
    throw new Error("invalid_collector_evidence_window");
  return transaction(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const {
      rows: [{ now }],
    } = await c.query("SELECT statement_timestamp() AS now");
    if (until > now) throw new Error("collector_evidence_window_not_closed");
    const source = await c.query(
      `SELECT 1 FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id
        WHERE s.id=$1 AND s.access_method='offline_fixture' AND x.provider='synthetic_fixture'`,
      [sourceId],
    );
    if (!source.rowCount) throw new Error("collector_evidence_source_unavailable");
    const { rows: plans } = await c.query<FrozenSchedule & { id: string; max_lag_seconds: number }>(
      `SELECT id,start_at,interval_seconds,max_lag_seconds,retired_at FROM collector_refresh_plans
        WHERE source_id=$1 AND start_at<$2 AND (retired_at IS NULL OR retired_at>$3)
        ORDER BY id LIMIT $4`,
      [sourceId, until, from, maxSlots + 1],
    );
    if (plans.length > maxSlots) throw new Error("collector_evidence_window_too_large");
    const scheduled = [];
    for (const plan of plans) {
      const { start, interval, first, last } = scheduledRange(plan, from.getTime(), until.getTime() - 1);
      if (scheduled.length + Math.max(0, last - first + 1) > maxSlots)
        throw new Error("collector_evidence_window_too_large");
      for (let sequence = first; sequence <= last; sequence++) {
        const at = new Date(start + sequence * interval);
        scheduled.push({ at, plan, key: slotKey(plan.id, at) });
      }
    }
    const { rows } = await c.query(factualRows, [sourceId, from, until, maxSlots + 1]);
    if (rows.length > maxSlots) throw new Error("collector_evidence_window_too_large");
    const facts = new Map(rows.map((r) => [slotKey(r.plan_id, r.scheduled_for), r]));
    const slots = scheduled
      .sort((a, b) => a.key.localeCompare(b.key, "en"))
      .map(({ at, plan, key }) => {
        const fact = facts.get(key);
        facts.delete(key);
        const deadline = new Date(at.getTime() + plan.max_lag_seconds * 1000);
        return {
          plan_id: plan.id,
          scheduled_at: at.toISOString(),
          deadline_at: deadline.toISOString(),
          occurrence: fact
            ? {
                id: fact.occurrence_id,
                state: fact.occurrence_state,
                finished_at: fact.occurrence_finished_at,
                failure_reason: fact.dispatch_failure_reason,
              }
            : null,
          job: fact?.job_id
            ? {
                id: fact.job_id,
                state: fact.job_status,
                claimed_at: fact.claimed_at,
                finished_at: fact.job_finished_at,
                run_id: fact.run_id,
                run_outcome: fact.run_outcome,
                parser_version: fact.parser_version,
              }
            : null,
          first_page_request_at: fact?.first_page_request_at ?? null,
          page_started_on_time: fact?.first_page_request_at ? fact.first_page_request_at <= deadline : null,
          completed_with_page_evidence: Boolean(
            fact?.run_outcome === "completed" &&
              fact.job_status === "completed" &&
              fact.page_attempts > 0 &&
              fact.committed_pages > 0,
          ),
          page_attempts: fact?.page_attempts ?? 0,
          image_attempts: fact?.image_attempts ?? 0,
          committed_pages: fact?.committed_pages ?? 0,
          bytes: { settled: fact?.settled_bytes ?? "0", unconfirmed: fact?.unconfirmed_bytes ?? "0" },
          open_reservations: fact?.open_reservations ?? 0,
          primary_image_states_at_snapshot: fact?.image_states ?? {},
        };
      });
    if (facts.size) throw new Error("collector_evidence_occurrence_outside_frozen_plan");
    return {
      schema: "soldbench.collector-run-evidence.v1",
      mode: "offline_fixture",
      onlineVerified: false,
      externalNetworkRequests: 0,
      source_id: sourceId,
      captured_at: (now as Date).toISOString(),
      window: { from: from.toISOString(), until: until.toISOString() },
      slots,
    };
  });
}
