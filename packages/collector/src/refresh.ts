import { randomUUID } from "node:crypto";
import { canonicalJson, collectionQueryHash, instant, normalizeQuery } from "@soldbench/core";
import { type Transaction, transaction } from "@soldbench/db";
import { type ConfigSnapshot, collectorConfigHash, type SourceSnapshot } from "./config-snapshot.ts";
import { COLLECTOR_VERSION, digest, PARSER_VERSION } from "./fixture.ts";
import { type CollectorEnqueueInput, type CollectorStore, collectorRequestHash } from "./store.ts";

type Occurrence = {
  id: string;
  source_id: string;
  config_id: string;
  query_hash: string;
  config_hash: string;
  job_ttl_seconds: number;
  as_of: Date | null;
  deadline_at: Date;
  collector_version: string;
  parser_version: string;
  profile_hash: string | null;
  retired_at: Date | null;
  attempts: number;
};
export class CollectorRefresh {
  constructor(readonly store: CollectorStore) {}
  private async now(c: Transaction) {
    return this.store.clock
      ? new Date(instant(this.store.clock()))
      : ((await c.query("SELECT clock_timestamp() t")).rows[0].t as Date);
  }
  private async source(c: Transaction, id: string) {
    const s = (
      await c.query<SourceSnapshot & { provider: string }>(
        "SELECT s.*,x.provider FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 FOR UPDATE OF s",
        [id],
      )
    ).rows[0];
    if (s?.access_method !== "offline_fixture" || s.provider !== "synthetic_fixture")
      throw new Error("network_collector_not_enabled");
    return s;
  }
  async create(input: {
    sourceId: string;
    configId: string;
    query: URLSearchParams;
    key: string;
    startAt?: string;
    intervalSeconds: number;
    maxLagSeconds: number;
    jobTtlSeconds?: number;
  }) {
    if (!/^[\x21-\x7e]{16,128}$/.test(input.key)) throw new Error("invalid_refresh_key");
    for (const [value, min, max] of [
      [input.intervalSeconds, 60, 86400],
      [input.maxLagSeconds, 1, 86400],
      [input.jobTtlSeconds ?? 3600, 1, 86400],
    ])
      if (!Number.isSafeInteger(value) || value === undefined || value < (min ?? 1) || value > (max ?? 86400))
        throw new Error("invalid_refresh_interval");
    const query = normalizeQuery(input.query),
      hash = collectionQueryHash(query),
      requestHash = digest(
        canonicalJson({
          source: input.sourceId,
          config: input.configId,
          query,
          start: input.startAt ? new Date(instant(input.startAt)).toISOString() : null,
          interval: input.intervalSeconds,
          lag: input.maxLagSeconds,
          ttl: input.jobTtlSeconds ?? 3600,
          profile: this.store.profileHash,
        }),
      );
    return transaction(this.store.db, async (c) => {
      const source = await this.source(c, input.sourceId),
        now = await this.now(c);
      const old = (
        await c.query("SELECT * FROM collector_refresh_plans WHERE source_id=$1 AND create_key=$2", [
          input.sourceId,
          input.key,
        ])
      ).rows[0];
      if (old) {
        if (old.request_hash !== requestHash) throw new Error("refresh_idempotency_conflict");
        return old.id as string;
      }
      await this.store.readScope(c, input.sourceId);
      const config = (
        await c.query<ConfigSnapshot>(
          "SELECT * FROM collector_configs WHERE id=$1 AND source_id=$2 FOR SHARE",
          [input.configId, input.sourceId],
        )
      ).rows[0];
      if (
        !config?.enabled ||
        config.access_method !== "offline_fixture" ||
        config.collector_version !== COLLECTOR_VERSION ||
        source.collector_version !== COLLECTOR_VERSION
      )
        throw new Error("refresh_config_unavailable");
      const active = (
        await c.query(
          "SELECT query_hash FROM collector_refresh_plans WHERE source_id=$1 AND retired_at IS NULL",
          [input.sourceId],
        )
      ).rows;
      if (active.some((r) => r.query_hash === hash)) throw new Error("refresh_plan_already_active");
      if (active.length >= 200) throw new Error("refresh_plan_cap_exceeded");
      const retiredBoundary = (
        await c.query(
          "SELECT max(retired_at) t FROM collector_refresh_plans WHERE source_id=$1 AND query_hash=$2",
          [input.sourceId, hash],
        )
      ).rows[0].t as Date | null;
      const start = input.startAt
        ? new Date(instant(input.startAt))
        : new Date(Math.max(now.getTime(), retiredBoundary?.getTime() ?? 0));
      if (start < now) throw new Error("refresh_start_in_past");
      if (retiredBoundary && start < retiredBoundary) throw new Error("refresh_start_overlaps_history");
      const id = randomUUID();
      await c.query(
        "INSERT INTO collector_refresh_plans(id,source_id,config_id,create_key,request_hash,query_parameters,query_hash,permission_epoch,config_hash,collector_version,parser_version,profile_hash,start_at,interval_seconds,max_lag_seconds,job_ttl_seconds,next_due_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$13,$17)",
        [
          id,
          input.sourceId,
          input.configId,
          input.key,
          requestHash,
          JSON.stringify(query),
          hash,
          source.permission_epoch,
          collectorConfigHash(source, config),
          COLLECTOR_VERSION,
          PARSER_VERSION,
          this.store.profileHash,
          start,
          input.intervalSeconds,
          input.maxLagSeconds,
          input.jobTtlSeconds ?? 3600,
          now,
        ],
      );
      return id;
    });
  }
  async retire(sourceId: string, planId: string) {
    return transaction(this.store.db, async (c) => {
      await this.source(c, sourceId);
      const now = await this.now(c);
      // Keep every slot at the current clock instant, including ones materialized before retirement.
      const boundary = new Date(now.getTime() + 1);
      const changed = await c.query(
        "UPDATE collector_refresh_plans SET retired_at=coalesce(retired_at,$3) WHERE id=$1 AND source_id=$2 RETURNING id",
        [planId, sourceId, boundary],
      );
      if (!changed.rowCount) throw new Error("refresh_plan_not_found");
    });
  }
  async materialize(sourceId: string, maxSlots = 1000) {
    if (!Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > 1000)
      throw new Error("invalid_refresh_batch");
    return transaction(this.store.db, async (c) => {
      await this.source(c, sourceId);
      const now = await this.now(c),
        plans = (
          await c.query(
            "SELECT * FROM collector_refresh_plans WHERE source_id=$1 AND next_due_at<=$2 AND (retired_at IS NULL OR next_due_at<retired_at) ORDER BY next_due_at,id FOR UPDATE",
            [sourceId, now],
          )
        ).rows;
      let count = 0;
      for (const p of plans) {
        let due = p.next_due_at as Date;
        while (due <= now && (!p.retired_at || due < p.retired_at) && count < maxSlots) {
          const deadline = new Date(due.getTime() + p.max_lag_seconds * 1000),
            missed = deadline <= now;
          await c.query(
            "INSERT INTO collector_refresh_occurrences(plan_id,source_id,scheduled_for,deadline_at,status,failure_reason,created_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(plan_id,scheduled_for) DO NOTHING",
            [
              p.id,
              sourceId,
              due,
              deadline,
              missed ? "missed" : "planned",
              missed ? "scheduler_late" : null,
              now,
              missed ? now : null,
            ],
          );
          due = new Date(due.getTime() + p.interval_seconds * 1000);
          count++;
        }
        await c.query("UPDATE collector_refresh_plans SET next_due_at=$2 WHERE id=$1", [p.id, due]);
        if (count >= maxSlots) break;
      }
      return {
        materialized: count,
        more: Boolean(
          (
            await c.query(
              "SELECT 1 FROM collector_refresh_plans WHERE source_id=$1 AND next_due_at<=$2 AND (retired_at IS NULL OR next_due_at<retired_at) LIMIT 1",
              [sourceId, now],
            )
          ).rowCount,
        ),
      };
    });
  }
  private input(o: Occurrence): CollectorEnqueueInput {
    if (!o.as_of) throw new Error("refresh_clock_missing");
    return {
      sourceId: o.source_id,
      configId: o.config_id,
      queryHash: o.query_hash,
      runKey: `refresh:${o.id}`,
      asOf: o.as_of.toISOString(),
      ttlSeconds: o.job_ttl_seconds,
      expectedConfigHash: o.config_hash,
      dispatchDeadline: o.deadline_at.toISOString(),
    };
  }
  async dispatchNext(sourceId: string) {
    const claim = await transaction(this.store.db, async (c) => {
      await this.source(c, sourceId);
      const now = await this.now(c);
      const rows = (
        await c.query<Occurrence>(
          "SELECT o.*,p.config_id,p.query_hash,p.config_hash,p.job_ttl_seconds,p.collector_version,p.parser_version,p.profile_hash,p.permission_epoch,p.retired_at FROM collector_refresh_occurrences o JOIN collector_refresh_plans p ON p.id=o.plan_id WHERE o.source_id=$1 AND (o.status='planned' OR o.status='dispatching' AND o.lease_until<=$2) ORDER BY o.scheduled_for,o.id LIMIT 100 FOR UPDATE OF o",
          [sourceId, now],
        )
      ).rows;
      for (const o of rows) {
        const existing = (
          await c.query("SELECT * FROM collector_jobs WHERE source_id=$1 AND run_key=$2", [
            sourceId,
            `refresh:${o.id}`,
          ])
        ).rows[0];
        if (existing) {
          if (!o.as_of || existing.request_hash !== collectorRequestHash(this.input(o), o.profile_hash))
            throw new Error("refresh_recovery_conflict");
          await c.query(
            "UPDATE collector_refresh_occurrences SET status='enqueued',job_id=$2,lease_owner=NULL,lease_until=NULL,failure_reason=NULL,finished_at=$3 WHERE id=$1",
            [o.id, existing.id, now],
          );
          return { recovered: true as const, occurrenceId: o.id as string, jobId: existing.id as string };
        }
        const reason =
          o.deadline_at <= now
            ? "scheduler_late"
            : o.attempts >= 3
              ? "refresh_attempts_exhausted"
              : o.retired_at
                ? "plan_retired"
                : o.collector_version !== COLLECTOR_VERSION ||
                    o.parser_version !== PARSER_VERSION ||
                    o.profile_hash !== this.store.profileHash
                  ? "refresh_version_changed"
                  : null;
        if (reason) {
          await c.query(
            "UPDATE collector_refresh_occurrences SET status=$2,failure_reason=$3,lease_owner=NULL,lease_until=NULL,finished_at=$4 WHERE id=$1",
            [o.id, reason === "scheduler_late" ? "missed" : "blocked", reason, now],
          );
          continue;
        }
        const token = randomUUID();
        o.as_of ??= now;
        await c.query(
          "UPDATE collector_refresh_occurrences SET status='dispatching',as_of=$2,lease_owner=$3,lease_until=$4,attempts=attempts+1 WHERE id=$1",
          [o.id, o.as_of, token, new Date(Math.min(now.getTime() + 60000, o.deadline_at.getTime()))],
        );
        return { recovered: false as const, occurrenceId: o.id as string, token, input: this.input(o) };
      }
      return null;
    });
    if (!claim || claim.recovered) return claim;
    let jobId: string;
    try {
      jobId = await this.store.enqueue({
        ...claim.input,
        refreshClaim: { id: claim.occurrenceId, token: claim.token },
      });
    } catch (error) {
      // A DB/transport disconnect is uncertain; preserve lease for recovery, never assume no job exists.
      const reason = error instanceof Error ? error.message : "refresh_dispatch_failed";
      const terminal = /^(source_|collector_(config|version|daily_jobs|as_of)|refresh_)/.test(reason);
      if (!terminal) throw error;
      await transaction(this.store.db, async (c) => {
        await this.source(c, sourceId);
        await c.query(
          "UPDATE collector_refresh_occurrences SET status='blocked',lease_owner=NULL,lease_until=NULL,failure_reason=$3,finished_at=$4 WHERE id=$1 AND lease_owner=$2 AND status='dispatching'",
          [claim.occurrenceId, claim.token, reason, await this.now(c)],
        );
      });
      return { occurrenceId: claim.occurrenceId, status: "blocked", reason };
    }
    await transaction(this.store.db, async (c) => {
      await this.source(c, sourceId);
      await c.query(
        "UPDATE collector_refresh_occurrences SET status='enqueued',lease_owner=NULL,lease_until=NULL,job_id=$3,failure_reason=NULL,finished_at=$4 WHERE id=$1 AND lease_owner=$2 AND status='dispatching'",
        [claim.occurrenceId, claim.token, jobId, await this.now(c)],
      );
    });
    return { occurrenceId: claim.occurrenceId, jobId, status: "enqueued" };
  }
}
