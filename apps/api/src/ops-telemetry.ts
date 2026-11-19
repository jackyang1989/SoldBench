import { availability } from "@soldbench/core";
import type { Transaction } from "@soldbench/db";
import { VERSIONS } from "@soldbench/shared";

export const telemetryViews = [
  "monitoring",
  "api",
  "collector",
  "records",
  "rules",
  "coverage",
  "quality",
  "growth",
  "costs",
] as const;
export type TelemetryView = (typeof telemetryViews)[number];
export type TelemetryInput = { days: number; limit: number; source?: string; record?: string };
type Cell = string | number | boolean | null;
type Section = { key: string; columns: string[]; rows: Cell[][] };
export type AlertSettings = {
  heartbeat_stale_seconds: number;
  query_delay_seconds: number;
  collector_failure_percent: number;
  version: number;
};
const asCell = (value: Cell | Date | undefined): Cell =>
  value instanceof Date ? value.toISOString() : (value ?? null);
const allowedSource = `s.status='active' AND s.access_method='offline_fixture' AND x.provider='synthetic_fixture'
  AND x.status IN ('draft','reviewed','active') AND (x.effective_at IS NULL OR x.effective_at<=$2)
  AND (x.expires_at IS NULL OR x.expires_at>$2)`;

export async function telemetry(c: Transaction, now: Date, view: TelemetryView, input: TelemetryInput) {
  const from = new Date(now.getTime() - input.days * 86400000);
  const sections: Section[] = [];
  const section = (key: string, columns: string[], rows: Cell[][]) => sections.push({ key, columns, rows });
  const table = async (key: string, columns: string[], sql: string, args: unknown[]) => {
    const rows = (await c.query(sql, args)).rows;
    section(
      key,
      columns,
      rows.map((row) => columns.map((field) => asCell(row[field]))),
    );
  };
  const scope = [from, now, input.source ?? null, input.limit];
  let alertSettings: AlertSettings | null = null;
  switch (view) {
    case "monitoring": {
      alertSettings =
        (
          await c.query<AlertSettings>(
            "SELECT heartbeat_stale_seconds,query_delay_seconds,collector_failure_percent,version FROM operator_alert_settings WHERE singleton",
          )
        ).rows[0] ?? null;
      if (!alertSettings) throw new Error("operator_alert_settings_missing");
      const row = (
        await c.query(
          `SELECT (SELECT last_cycle_at FROM worker_heartbeats WHERE worker_kind='query' AND last_cycle_at<=$2) AS heartbeat,
                (SELECT count(*)::int FROM query_jobs WHERE status='queued' AND expires_at>$2
                  AND available_at<=$2-make_interval(secs=>$3)) AS overdue,
                (SELECT count(*)::int FROM collector_runs WHERE started_at>=$1 AND completed_at<=$2) AS completed_runs,
                (SELECT count(*)::int FROM collector_runs WHERE started_at>=$1 AND completed_at<=$2 AND outcome<>'completed') AS unsuccessful_runs`,
          [from, now, alertSettings.query_delay_seconds],
        )
      ).rows[0];
      const failed = row.completed_runs ? (100 * row.unsuccessful_runs) / row.completed_runs : null;
      const age = row.heartbeat ? Math.floor((now.getTime() - row.heartbeat.getTime()) / 1000) : null;
      section(
        "alerts",
        ["signal", "value", "denominator", "state"],
        [
          [
            "worker_heartbeat_age",
            age,
            null,
            age === null
              ? "unknown"
              : age >= alertSettings.heartbeat_stale_seconds
                ? "alert"
                : "within_budget",
          ],
          ["overdue_query_jobs", row.overdue, null, row.overdue ? "alert" : "within_budget"],
          [
            "collector_failure_percent",
            failed,
            row.completed_runs,
            failed === null
              ? "unknown"
              : failed >= alertSettings.collector_failure_percent
                ? "alert"
                : "within_budget",
          ],
        ],
      );
      break;
    }
    case "api":
      await table(
        "requests",
        ["channel", "operation", "requests", "errors", "p95_ms", "credits"],
        `SELECT channel,operation,count(*)::int requests,count(*) FILTER (WHERE http_status>=400)::int errors,
          percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) p95_ms,coalesce(sum(credits_charged),0)::int credits
          FROM query_request_audit WHERE created_at>=$1 AND created_at<=$2 AND retention_until>$2
          GROUP BY channel,operation ORDER BY requests DESC,channel,operation LIMIT $3`,
        [from, now, input.limit],
      );
      break;
    case "collector":
      await table(
        "collection_runs",
        [
          "run_id",
          "source_id",
          "started_at",
          "completed_at",
          "outcome",
          "stop_reason",
          "requests",
          "pages",
          "bytes",
          "unconfirmed_bytes",
          "parser_version",
        ],
        `SELECT r.id run_id,r.source_id,r.started_at,r.completed_at,r.outcome,r.stop_reason,r.request_count requests,
          r.page_count pages,r.bytes_in::text bytes,r.bytes_unconfirmed::text unconfirmed_bytes,r.parser_version
          FROM collector_runs r JOIN sources s ON s.id=r.source_id WHERE s.access_method='offline_fixture'
            AND r.started_at BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR r.source_id=$3)
          ORDER BY r.started_at DESC,r.id LIMIT $4`,
        scope,
      );
      break;
    case "records":
      await table(
        "sale_evidence",
        [
          "event_id",
          "source_id",
          "observation_id",
          "captured_at",
          "kind",
          "identity_status",
          "price_status",
          "title",
          "primary_image",
        ],
        `SELECT e.id event_id,e.source_id,o.id observation_id,o.captured_at,e.sale_format kind,
          e.event_identity_status identity_status,
          CASE WHEN x.permitted_fields->'research' @> '["price"]'::jsonb THEN e.sale_price_status END price_status,
          CASE WHEN x.permitted_fields->'research' @> '["title"]'::jsonb THEN evidence.candidate->>'title' END title,
          CASE WHEN x.permitted_fields->'research' @> '["primary_image"]'::jsonb THEN
            EXISTS(SELECT 1 FROM listing_images i WHERE i.sale_event_id=e.id AND i.source_id=e.source_id AND i.observation_id=o.id
              AND i.listing_id=e.listing_id AND i.role='primary' AND i.state='available' AND i.permission_epoch=s.permission_epoch
              AND i.retention_until>$2) END primary_image
          FROM sale_events e JOIN source_observations o ON (o.id,o.source_id)=(e.observation_id,e.source_id)
          JOIN sale_event_evidence evidence ON (evidence.sale_event_id,evidence.listing_id,evidence.source_id,evidence.observation_id)
            =(e.id,e.listing_id,e.source_id,e.observation_id)
          JOIN sources s ON s.id=e.source_id JOIN source_clearances x ON x.id=s.source_clearance_id
          WHERE ${allowedSource} AND x.permitted_fields->'research' @> '["identity"]'::jsonb AND o.retention_until>$2
            AND NOT EXISTS(SELECT 1 FROM collector_quarantines quarantine WHERE quarantine.affected_event_id=e.id)
            AND o.captured_at BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR e.source_id=$3)
            AND ($5::uuid IS NULL OR e.id=$5)
          ORDER BY o.captured_at DESC,e.id LIMIT $4`,
        [...scope, input.record ?? null],
      );
      break;
    case "rules":
      section("effective_versions", ["rule", "version"], Object.entries(VERSIONS));
      await table(
        "observed_parsers",
        ["source_id", "parser_version", "runs", "last_seen"],
        `SELECT r.source_id,r.parser_version,count(*)::int runs,max(r.started_at) last_seen FROM collector_runs r
          JOIN sources s ON s.id=r.source_id WHERE s.access_method='offline_fixture'
            AND r.started_at BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR r.source_id=$3)
          GROUP BY r.source_id,r.parser_version ORDER BY last_seen DESC,r.source_id,r.parser_version LIMIT $4`,
        scope,
      );
      break;
    case "coverage": {
      const rows = (
        await c.query(
          `SELECT a.source_id,a.category_path category,
          ((${allowedSource}) AND a.freshness_state<>'forbidden') AS allowed,
          CASE WHEN a.last_successful_observation_at<=$2 THEN a.last_successful_observation_at END last_observation,
          a.collector_status
          FROM data_availability a JOIN sources s ON s.id=a.source_id JOIN source_clearances x ON x.id=s.source_clearance_id
          WHERE a.last_transition_at<=$2 AND ($1::uuid IS NULL OR a.source_id=$1)
          ORDER BY a.category_path,a.source_id LIMIT $3`,
          [input.source ?? null, now, input.limit],
        )
      ).rows;
      section(
        "source_coverage",
        ["source_id", "category", "data_as_of", "freshness", "collector_status", "market_coverage"],
        rows.map((row) => {
          const dataAsOf = row.allowed && row.last_observation ? row.last_observation.toISOString() : null;
          const projected = availability({
            now: now.toISOString(),
            dataAsOf,
            currentRights: row.allowed ? "allowed" : "revoked",
            snapshotExists: dataAsOf !== null,
            allowStale: false,
            verifiedSamples: 0,
          });
          return [
            row.source_id,
            row.category,
            dataAsOf,
            projected.freshness === "unknown" ? "never_observed" : projected.freshness,
            row.allowed ? row.collector_status : null,
            null,
          ];
        }),
      );
      break;
    }
    case "quality":
      await table(
        "snapshot_quality",
        ["engine_version", "cleaner_version", "snapshots", "observations", "comparables", "verified_prices"],
        `SELECT r.engine_version,r.cleaner_version,count(*)::int snapshots,
          coalesce(sum((r.stats->>'n_observed')::bigint),0)::text observations,
          coalesce(sum((r.stats->>'n_comparable')::bigint),0)::text comparables,
          coalesce(sum((r.stats->>'n_price_verified')::bigint),0)::text verified_prices
          FROM query_results r JOIN queries q ON q.id=r.query_id
          WHERE q.created_at BETWEEN $1 AND $2 AND r.data_as_of<=$2
          AND EXISTS(SELECT 1 FROM query_result_sources k WHERE k.query_id=q.id AND ($3::uuid IS NULL OR k.source_id=$3))
          AND NOT EXISTS(SELECT 1 FROM query_result_sources k JOIN sources s ON s.id=k.source_id
            JOIN source_clearances x ON x.id=s.source_clearance_id WHERE k.query_id=q.id AND
            (NOT (${allowedSource}) OR k.permission_epoch<>s.permission_epoch OR k.clearance_id<>x.id))
          AND NOT EXISTS(SELECT 1 FROM query_snapshot_records input JOIN source_observations observation ON observation.id=input.observation_id
            WHERE input.query_id=q.id AND (observation.retention_until IS NULL OR observation.retention_until<=$2
              OR EXISTS(SELECT 1 FROM collector_quarantines quarantine WHERE quarantine.affected_event_id=input.sale_event_id)))
          AND NOT EXISTS(SELECT 1 FROM collector_jobs j JOIN source_observations observation ON observation.collector_run_id=j.collector_run_id
            WHERE j.id=q.collector_job_id AND (observation.retention_until IS NULL OR observation.retention_until<=$2))
          GROUP BY r.engine_version,r.cleaner_version ORDER BY snapshots DESC,r.engine_version,r.cleaner_version LIMIT $4`,
        scope,
      );
      break;
    case "growth":
      await table(
        "fixture_activity",
        ["verified_accounts", "distinct_query_owners", "delivered_queries", "paid_conversion", "retention"],
        `SELECT (SELECT count(*)::int FROM users WHERE email_verified_at BETWEEN $1 AND $2 AND status='active') AS verified_accounts,
          (SELECT count(DISTINCT user_id)::int FROM queries WHERE created_at BETWEEN $1 AND $2) AS distinct_query_owners,
          (SELECT count(*)::int FROM queries WHERE delivered_at BETWEEN $1 AND $2) AS delivered_queries,
          NULL::int paid_conversion,NULL::int retention`,
        [from, now],
      );
      break;
    case "costs":
      await table(
        "budget_usage",
        ["source_id", "day", "unit", "cap", "used", "reserved"],
        `SELECT b.source_id,b.day::text,b.budget_kind unit,b.cap::text,b.used::text,b.reserved::text
          FROM source_daily_budget b JOIN sources s ON s.id=b.source_id
          WHERE s.access_method='offline_fixture' AND b.day BETWEEN ($1 AT TIME ZONE 'UTC')::date AND ($2 AT TIME ZONE 'UTC')::date
            AND ($3::uuid IS NULL OR b.source_id=$3)
          ORDER BY b.day DESC,b.source_id,b.budget_kind LIMIT $4`,
        scope,
      );
      section(
        "commercial_costs",
        ["compute_cost", "network_cost", "cost_per_usable_query"],
        [[null, null, null]],
      );
      break;
  }
  return {
    view,
    data_mode: "offline_fixture",
    range_start: from.toISOString(),
    as_of: now.toISOString(),
    sections,
    alert_settings: alertSettings,
  };
}
