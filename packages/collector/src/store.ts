import { randomUUID } from "node:crypto";
import { type Candidate, candidateFromJson, canonicalJson, instant } from "@soldbench/core";
import { type Database, type Transaction, transaction } from "@soldbench/db";
import type { PrimaryImage, PrivateMediaStore } from "@soldbench/media";
import {
  COLLECTOR_VERSION,
  digest,
  eventFacts,
  type FixturePage,
  PARSER_VERSION,
  parseFixturePage,
  uncertainCandidateKey,
} from "./fixture.ts";
import { CollectorIntegrityError, type QuarantineReason, quarantineReasons } from "./integrity.ts";

export type Job = {
  id: string;
  source_id: string;
  config_id: string;
  collector_run_id: string;
  run_key: string;
  request_hash: string;
  query_hash: string;
  as_of: Date;
  permission_epoch: string;
  status: string;
  cursor: string;
  visited_cursors: string[];
  page_count: number;
  request_count: number;
  bytes_used: string;
  bytes_reserved: string;
  attempts: number;
  lease_count: number;
  lease_owner: string | null;
  lease_until: Date | null;
  available_at: Date;
  expires_at: Date;
  min_page_as_of: Date | null;
  error_code: string | null;
};
type Source = {
  id: string;
  access_method: string;
  status: string;
  permission_epoch: string;
  source_clearance_id: string;
};
type Config = {
  id: string;
  enabled: boolean;
  access_method: string;
  rate_cap: number;
  concurrency_cap: number;
  max_pages: number;
  max_bytes_per_job: string;
  updated_at: Date;
};
export type Lease = { jobId: string; token: string; sourceId: string };
export type EvidenceItem = {
  listingId: string;
  eventId: string;
  observationId: string;
  imageId: string;
  url: string | null;
};
function missingRow(): never {
  throw new Error("collector_database_row_missing");
}
export class CollectorStore {
  constructor(
    readonly db: Database,
    readonly clock?: () => string,
  ) {}
  private async now(c: Transaction): Promise<Date> {
    if (this.clock) return new Date(instant(this.clock()));
    return (await c.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0]?.t ?? missingRow();
  }
  private async source(c: Transaction, sourceId: string) {
    const source = (await c.query<Source>("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [sourceId]))
      .rows[0];
    if (source?.access_method !== "offline_fixture") throw new Error("network_collector_not_enabled");
    if (source.status !== "active") throw new Error("source_inactive");
    const control = (
      await c.query(
        "SELECT status<>'closed' AS circuit_open FROM collector_circuits WHERE source_id=$1 AND category_key='*'",
        [sourceId],
      )
    ).rows[0];
    if (control?.circuit_open) throw new Error("source_circuit_open");
    return source;
  }
  private async locked(c: Transaction, lease: Lease, allowCompleted = false) {
    const source = await this.source(c, lease.sourceId);
    const job = (
      await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 AND source_id=$2 FOR UPDATE", [
        lease.jobId,
        lease.sourceId,
      ])
    ).rows[0];
    const now = await this.now(c);
    if (
      !job ||
      job.lease_owner !== lease.token ||
      (!allowCompleted && job.status !== "running") ||
      (allowCompleted && !["running", "completed"].includes(job.status)) ||
      !job.lease_until ||
      job.lease_until <= now ||
      job.expires_at <= now
    )
      throw new Error("collector_lease_lost");
    if (job.permission_epoch !== source.permission_epoch) throw new Error("source_permission_changed");
    const config = (
      await c.query<Config>("SELECT * FROM collector_configs WHERE id=$1 AND source_id=$2 FOR UPDATE", [
        job.config_id,
        job.source_id,
      ])
    ).rows[0];
    if (!config?.enabled || config.access_method !== "offline_fixture")
      throw new Error("collector_config_disabled");
    const run = (
      await c.query(
        "SELECT permission_snapshot_hash,collector_version,parser_version FROM collector_runs WHERE id=$1",
        [job.collector_run_id],
      )
    ).rows[0];
    if (run.collector_version !== COLLECTOR_VERSION || run.parser_version !== PARSER_VERSION)
      throw new Error("collector_version_mismatch");
    if (
      run.permission_snapshot_hash !==
      digest(`offline:${source.permission_epoch}:${config.updated_at.toISOString()}`)
    )
      throw new Error("collector_config_or_permission_changed");
    return { job, source, config, now };
  }
  async enqueue(input: {
    sourceId: string;
    configId: string;
    queryHash: string;
    runKey: string;
    asOf: string;
    ttlSeconds?: number;
  }): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(input.queryHash) || !input.runKey || input.runKey.length > 160)
      throw new Error("invalid_collector_plan");
    instant(input.asOf);
    const ttl = input.ttlSeconds ?? 3600;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error("invalid_collector_deadline");
    return transaction(this.db, async (c) => {
      const source = await this.source(c, input.sourceId),
        now = await this.now(c);
      if (instant(input.asOf) > now.getTime()) throw new Error("collector_as_of_in_future");
      const requestHash = digest(canonicalJson({ ...input, ttlSeconds: ttl }));
      const old = (
        await c.query<Job>("SELECT * FROM collector_jobs WHERE source_id=$1 AND run_key=$2", [
          input.sourceId,
          input.runKey,
        ])
      ).rows[0];
      if (old) {
        if (old.request_hash !== requestHash) throw new Error("collector_idempotency_conflict");
        return old.id;
      }
      const config = (
        await c.query<Config>("SELECT * FROM collector_configs WHERE id=$1 AND source_id=$2 FOR UPDATE", [
          input.configId,
          input.sourceId,
        ])
      ).rows[0];
      if (!config?.enabled || config.access_method !== "offline_fixture")
        throw new Error("collector_config_disabled");
      const day = now.toISOString().slice(0, 10);
      const budget = await c.query(
        "UPDATE source_daily_budget SET used=used+1 WHERE source_id=$1 AND day=$2 AND budget_kind='jobs' AND used+reserved+1<=cap RETURNING cap",
        [input.sourceId, day],
      );
      if (!budget.rowCount) throw new Error("collector_daily_jobs_exhausted");
      const runId = randomUUID();
      await c.query(
        "INSERT INTO collector_runs(id,source_id,config_id,query_hash,collector_version,parser_version,permission_snapshot_hash,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          runId,
          input.sourceId,
          input.configId,
          input.queryHash,
          COLLECTOR_VERSION,
          PARSER_VERSION,
          digest(`offline:${source.permission_epoch}:${config.updated_at.toISOString()}`),
          now,
        ],
      );
      const result = await c.query<{ id: string }>(
        "INSERT INTO collector_jobs(source_id,config_id,collector_run_id,run_key,request_hash,query_hash,as_of,permission_epoch,available_at,expires_at,created_at,reason,dedupe_key,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,'offline_fixture',$11,'queued') RETURNING id",
        [
          input.sourceId,
          input.configId,
          runId,
          input.runKey,
          requestHash,
          input.queryHash,
          input.asOf,
          source.permission_epoch,
          now,
          new Date(now.getTime() + ttl * 1000),
          digest(`${input.sourceId}:${input.runKey}`),
        ],
      );
      return result.rows[0]?.id ?? missingRow();
    });
  }
  async claim(sourceId: string, leaseSeconds = 60, onlyJobId?: string): Promise<Lease | null> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300)
      throw new Error("invalid_lease_duration");
    return transaction(this.db, async (c) => {
      await this.source(c, sourceId);
      const now = await this.now(c);
      const configs = await c.query<Config>(
        "SELECT * FROM collector_configs WHERE source_id=$1 AND enabled=true AND access_method='offline_fixture' ORDER BY id",
        [sourceId],
      );
      for (const config of configs.rows) {
        const running = (
          await c.query(
            "SELECT count(*)::int AS n FROM collector_jobs WHERE source_id=$1 AND status='running' AND lease_until>$2",
            [sourceId, now],
          )
        ).rows[0].n;
        if (running >= config.concurrency_cap) continue;
        const jobs = await c.query<Job>(
          "SELECT * FROM collector_jobs WHERE source_id=$1 AND config_id=$2 AND (status IN ('queued','retry') OR (status='running' AND lease_until<=$3)) AND available_at<=$3 AND ($4::uuid IS NULL OR id=$4) ORDER BY created_at,id FOR UPDATE",
          [sourceId, config.id, now, onlyJobId ?? null],
        );
        for (const job of jobs.rows) {
          const run = (
            await c.query("SELECT collector_version,parser_version FROM collector_runs WHERE id=$1", [
              job.collector_run_id,
            ])
          ).rows[0];
          if (run?.collector_version !== COLLECTOR_VERSION || run.parser_version !== PARSER_VERSION)
            throw new Error("collector_version_mismatch");
          await this.abandon(c, job);
          const crashAttempt = job.status === "running" ? 1 : 0;
          if (job.expires_at <= now || job.attempts + crashAttempt >= 3) {
            await c.query(
              "UPDATE collector_runs SET outcome='failed',stop_reason='expired_or_attempts_exhausted',completed_at=$2 WHERE id=$1",
              [job.collector_run_id, now],
            );
            await c.query(
              "UPDATE collector_jobs SET status='failed',error_code='expired_or_attempts_exhausted' WHERE id=$1",
              [job.id],
            );
            continue;
          }
          const token = randomUUID();
          await c.query(
            "UPDATE collector_jobs SET status='running',attempts=attempts+$4,lease_count=lease_count+1,version=version+1,lease_owner=$2,lease_until=$3 WHERE id=$1",
            [job.id, token, new Date(now.getTime() + leaseSeconds * 1000), crashAttempt],
          );
          return { jobId: job.id, token, sourceId };
        }
      }
      return null;
    });
  }
  private async abandon(c: Transaction, job: Job) {
    const reservations = await c.query(
      "SELECT * FROM collector_dispatches WHERE job_id=$1 AND state='reserved' FOR UPDATE",
      [job.id],
    );
    for (const r of reservations.rows) {
      await c.query("UPDATE collector_runs SET bytes_unconfirmed=bytes_unconfirmed+$2 WHERE id=$1", [
        job.collector_run_id,
        r.max_bytes,
      ]);
      await c.query(
        "UPDATE source_daily_budget SET reserved=reserved-$4,used=used+$4 WHERE source_id=$1 AND day=$2 AND budget_kind=$3",
        [job.source_id, r.budget_day, "bytes", r.max_bytes],
      );
      if (r.kind === "page")
        await c.query(
          "UPDATE source_daily_budget SET reserved=reserved-1,used=used+1 WHERE source_id=$1 AND day=$2 AND budget_kind='pages'",
          [job.source_id, r.budget_day],
        );
      await c.query(
        "UPDATE collector_jobs SET bytes_reserved=bytes_reserved-$2,bytes_used=bytes_used+$2 WHERE id=$1",
        [job.id, r.max_bytes],
      );
      await c.query("UPDATE collector_dispatches SET state='abandoned',actual_bytes=max_bytes WHERE id=$1", [
        r.id,
      ]);
    }
  }
  async bindFixtureArtifact(input: {
    jobId: string;
    sourceId: string;
    queryHash: string;
    asOf: string;
    hash: string;
    pageHashes: ReadonlyMap<string, ReadonlySet<string>>;
  }) {
    if (!/^[a-f0-9]{64}$/.test(input.hash)) throw new Error("invalid_fixture_artifact_hash");
    await transaction(this.db, async (c) => {
      await this.source(c, input.sourceId);
      const job = (
        await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 AND source_id=$2 FOR UPDATE", [
          input.jobId,
          input.sourceId,
        ])
      ).rows[0];
      if (!job || job.query_hash !== input.queryHash || job.as_of.getTime() !== instant(input.asOf))
        throw new Error("fixture_artifact_job_mismatch");
      const run = (
        await c.query("SELECT fixture_artifact_hash FROM collector_runs WHERE id=$1 FOR UPDATE", [
          job.collector_run_id,
        ])
      ).rows[0];
      if (run.fixture_artifact_hash && run.fixture_artifact_hash !== input.hash)
        throw new Error("fixture_artifact_changed");
      const pages = await c.query("SELECT cursor,raw_hash FROM collector_pages WHERE job_id=$1", [job.id]);
      if (pages.rows.some((page) => !input.pageHashes.get(page.cursor)?.has(page.raw_hash)))
        throw new Error("fixture_artifact_committed_page_mismatch");
      await c.query("UPDATE collector_runs SET fixture_artifact_hash=$2 WHERE id=$1", [
        job.collector_run_id,
        input.hash,
      ]);
    });
  }
  async renew(lease: Lease, seconds = 60) {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300)
      throw new Error("invalid_lease_duration");
    await transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      await c.query("UPDATE collector_jobs SET lease_until=$2 WHERE id=$1", [
        job.id,
        new Date(Math.min(now.getTime() + seconds * 1000, job.expires_at.getTime())),
      ]);
    });
  }
  async reserve(
    lease: Lease,
    kind: "page" | "image",
    maxBytes: number,
    fixtureKey?: string,
  ): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024)
      throw new Error("invalid_dispatch_budget");
    if (fixtureKey !== undefined && (!fixtureKey.startsWith(`${kind}:`) || fixtureKey.length > 2200))
      throw new Error("invalid_fixture_request_key");
    return transaction(this.db, async (c) => {
      const { job, config, now } = await this.locked(c, lease);
      if (
        job.request_count >= config.max_pages * 4 + 1000 ||
        (kind === "page" && job.page_count >= config.max_pages) ||
        BigInt(job.bytes_used) + BigInt(job.bytes_reserved) + BigInt(maxBytes) >
          BigInt(config.max_bytes_per_job)
      )
        throw new Error("collector_job_budget_exhausted");
      const concurrent = await c.query(
        "SELECT id FROM collector_dispatches WHERE job_id=$1 AND state='reserved'",
        [job.id],
      );
      if (concurrent.rowCount) throw new Error("dispatch_already_reserved");
      const day = now.toISOString().slice(0, 10),
        minute = new Date(Math.floor(now.getTime() / 60000) * 60000);
      const rate = await c.query(
        "INSERT INTO collector_rate_windows(source_id,minute,used) VALUES($1,$2,1) ON CONFLICT(source_id,minute) DO UPDATE SET used=collector_rate_windows.used+1 WHERE collector_rate_windows.used<$3 RETURNING used",
        [job.source_id, minute, config.rate_cap],
      );
      if (!rate.rowCount) throw new Error("collector_rate_limited");
      for (const [kindName, amount] of [
        ["bytes", maxBytes],
        ...(kind === "page" ? [["pages", 1]] : []),
      ] as Array<[string, number]>) {
        const result = await c.query(
          "UPDATE source_daily_budget SET reserved=reserved+$4 WHERE source_id=$1 AND day=$2 AND budget_kind=$3 AND used+reserved+$4<=cap RETURNING cap",
          [job.source_id, day, kindName, amount],
        );
        if (!result.rowCount) throw new Error("collector_daily_budget_exhausted");
      }
      const keyHash = fixtureKey === undefined ? null : digest(fixtureKey);
      const responseIndex = 0;
      const id = randomUUID();
      await c.query(
        "INSERT INTO collector_dispatches(id,job_id,source_id,lease_owner,kind,budget_day,max_bytes,created_at,fixture_key_hash,fixture_response_index) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [id, job.id, job.source_id, lease.token, kind, day, maxBytes, now, keyHash, responseIndex],
      );
      await c.query(
        "UPDATE collector_jobs SET bytes_reserved=bytes_reserved+$2,request_count=request_count+1 WHERE id=$1",
        [job.id, maxBytes],
      );
      await c.query("UPDATE collector_runs SET request_count=request_count+1 WHERE id=$1", [
        job.collector_run_id,
      ]);
      return id;
    });
  }
  async fixtureResponseIndex(lease: Lease, dispatchId: string): Promise<number> {
    return transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      const row = (
        await c.query(
          "SELECT * FROM collector_dispatches WHERE id=$1 AND job_id=$2 AND lease_owner=$3 AND state='reserved' FOR UPDATE",
          [dispatchId, lease.jobId, lease.token],
        )
      ).rows[0];
      if (!row?.fixture_key_hash) throw new Error("dispatch_not_reserved");
      if (row.dispatched_at) return row.fixture_response_index;
      const index = (
        await c.query(
          "SELECT count(*)::int AS n FROM collector_dispatches WHERE job_id=$1 AND fixture_key_hash=$2 AND dispatched_at IS NOT NULL",
          [job.id, row.fixture_key_hash],
        )
      ).rows[0].n;
      await c.query(
        "UPDATE collector_dispatches SET dispatched_at=$2,fixture_response_index=$3 WHERE id=$1",
        [dispatchId, now, index],
      );
      return index;
    });
  }
  /** Caller knows the in-memory transport has not been invoked. Unlike unknown
   * crash reservations, graceful pre-dispatch shutdown consumes no bytes/pages. */
  async cancelUndispatchedFixture(lease: Lease, dispatchId: string) {
    await transaction(this.db, async (c) => {
      const { job } = await this.locked(c, lease);
      const row = (
        await c.query(
          "SELECT * FROM collector_dispatches WHERE id=$1 AND job_id=$2 AND lease_owner=$3 FOR UPDATE",
          [dispatchId, job.id, lease.token],
        )
      ).rows[0];
      if (!row) throw new Error("dispatch_not_reserved");
      if (row.state === "settled" && row.actual_bytes === "0" && row.dispatched_at === null) return;
      if (row.state !== "reserved") throw new Error("dispatch_already_consumed");
      await c.query(
        "UPDATE source_daily_budget SET reserved=reserved-$3 WHERE source_id=$1 AND day=$2 AND budget_kind='bytes'",
        [job.source_id, row.budget_day, row.max_bytes],
      );
      if (row.kind === "page")
        await c.query(
          "UPDATE source_daily_budget SET reserved=reserved-1 WHERE source_id=$1 AND day=$2 AND budget_kind='pages'",
          [job.source_id, row.budget_day],
        );
      await c.query(
        "UPDATE collector_jobs SET bytes_reserved=bytes_reserved-$2,request_count=request_count-1 WHERE id=$1",
        [job.id, row.max_bytes],
      );
      await c.query("UPDATE collector_runs SET request_count=request_count-1 WHERE id=$1", [
        job.collector_run_id,
      ]);
      await c.query(
        "UPDATE collector_rate_windows SET used=used-1 WHERE source_id=$1 AND minute=date_trunc('minute',$2::timestamptz)",
        [job.source_id, row.created_at],
      );
      await c.query(
        "UPDATE collector_dispatches SET state='settled',actual_bytes=0,response_hash=NULL,dispatched_at=NULL WHERE id=$1",
        [dispatchId],
      );
    });
  }
  async settle(lease: Lease, dispatchId: string, bytes: number, responseHash?: string): Promise<void> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      (responseHash !== undefined && !/^[a-f0-9]{64}$/.test(responseHash))
    )
      throw new Error("invalid_response_bytes");
    await transaction(this.db, async (c) => {
      const { job } = await this.locked(c, lease, true);
      const r = (
        await c.query(
          "SELECT * FROM collector_dispatches WHERE id=$1 AND job_id=$2 AND lease_owner=$3 FOR UPDATE",
          [dispatchId, lease.jobId, lease.token],
        )
      ).rows[0];
      if (!r || BigInt(bytes) > BigInt(r.max_bytes)) throw new Error("dispatch_response_exceeds_budget");
      if (r.state === "settled") {
        if (Number(r.actual_bytes) !== bytes || r.response_hash !== (responseHash ?? null))
          throw new Error("dispatch_settlement_conflict");
        return;
      }
      if (r.state !== "reserved") throw new Error("dispatch_abandoned");
      await c.query("UPDATE collector_runs SET bytes_in=bytes_in+$2 WHERE id=$1", [
        job.collector_run_id,
        bytes,
      ]);
      await c.query(
        "UPDATE source_daily_budget SET reserved=reserved-$3,used=used+$4 WHERE source_id=$1 AND day=$2 AND budget_kind='bytes'",
        [lease.sourceId, r.budget_day, r.max_bytes, bytes],
      );
      if (r.kind === "page")
        await c.query(
          "UPDATE source_daily_budget SET reserved=reserved-1,used=used+1 WHERE source_id=$1 AND day=$2 AND budget_kind='pages'",
          [lease.sourceId, r.budget_day],
        );
      await c.query(
        "UPDATE collector_dispatches SET state='settled',actual_bytes=$2,response_hash=$3 WHERE id=$1",
        [dispatchId, bytes, responseHash ?? null],
      );
      await c.query(
        "UPDATE collector_jobs SET bytes_reserved=bytes_reserved-$2,bytes_used=bytes_used+$3 WHERE id=$1",
        [lease.jobId, r.max_bytes, bytes],
      );
    });
  }
  async view(jobId: string): Promise<Job> {
    const row = (await this.db.query<Job>("SELECT * FROM collector_jobs WHERE id=$1", [jobId])).rows[0];
    if (!row) throw new Error("collector_job_not_found");
    return row;
  }
  async check(lease: Lease) {
    return transaction(this.db, async (c) => {
      const x = await this.locked(c, lease, true);
      return {
        epoch: Number(x.source.permission_epoch),
        now: x.now.toISOString(),
        expiresAt: new Date(Math.min(x.now.getTime() + 86400000, x.job.expires_at.getTime())).toISOString(),
      };
    });
  }
  async defer(lease: Lease, reason: string, delaySeconds: number, terminal = false) {
    await transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      await this.abandon(c, job);
      const nextAttempt =
        job.attempts +
        (["upstream_rate_limited", "collector_rate_limited", "worker_yield", "worker_shutdown"].includes(
          reason,
        )
          ? 0
          : 1);
      if (terminal || nextAttempt >= 3)
        await c.query(
          "UPDATE collector_runs SET outcome='failed',stop_reason=$2,completed_at=$3 WHERE id=$1",
          [job.collector_run_id, reason, now],
        );
      await c.query(
        "UPDATE collector_jobs SET status=$2,error_code=$3,available_at=$4,lease_until=$5,attempts=$6 WHERE id=$1",
        [
          job.id,
          terminal || nextAttempt >= 3 ? "failed" : "retry",
          reason,
          new Date(now.getTime() + Math.max(1, delaySeconds) * 1000),
          now,
          nextAttempt,
        ],
      );
    });
  }
  private async stopLocked(c: Transaction, sourceId: string, reason: string, revoke: boolean) {
    const source = (await c.query("SELECT id FROM sources WHERE id=$1 FOR UPDATE", [sourceId])).rows[0];
    if (!source) throw new Error("source_missing");
    const now = await this.now(c);
    await c.query(
      "INSERT INTO collector_circuits(source_id,category_key,status,opened_reason,opened_at) VALUES($1,'*','open',$2,$3) ON CONFLICT(source_id,category_key) DO UPDATE SET status='open',opened_reason=$2,opened_at=$3",
      [sourceId, reason, now],
    );
    const interrupted = await c.query<Job>(
      "SELECT * FROM collector_jobs WHERE source_id=$1 AND status IN ('queued','running','retry') FOR UPDATE",
      [sourceId],
    );
    for (const job of interrupted.rows) {
      await this.abandon(c, job);
      await c.query("UPDATE collector_runs SET outcome='failed',stop_reason=$2,completed_at=$3 WHERE id=$1", [
        job.collector_run_id,
        reason,
        now,
      ]);
    }
    await c.query(
      "UPDATE collector_jobs SET status='failed',error_code=$2 WHERE source_id=$1 AND status IN ('queued','running','retry')",
      [sourceId, reason],
    );
    if (revoke) {
      const row = (
        await c.query(
          "UPDATE sources SET status='revoked',permission_epoch=permission_epoch+1 WHERE id=$1 RETURNING permission_epoch",
          [sourceId],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO outbox(event_key,kind,payload,available_at) VALUES($1,'collector.media_cleanup',$2,$3) ON CONFLICT DO NOTHING",
        [`source-revoke:${sourceId}:${row.permission_epoch}`, JSON.stringify({ sourceId, reason }), now],
      );
    }
  }
  async stop(sourceId: string, reason: string) {
    await transaction(this.db, (c) => this.stopLocked(c, sourceId, reason, false));
  }
  async quarantinePage(
    lease: Lease,
    dispatchId: string,
    raw: Uint8Array,
    reason: QuarantineReason,
    affectedEventId?: string,
  ) {
    if (
      !quarantineReasons.includes(reason) ||
      raw.byteLength > 1024 * 1024 ||
      (reason === "event_identity_conflict") !== (affectedEventId !== undefined)
    )
      throw new Error("invalid_quarantine_evidence");
    return transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      const dispatch = (
        await c.query(
          "SELECT * FROM collector_dispatches WHERE id=$1 AND job_id=$2 AND source_id=$3 AND lease_owner=$4 AND kind='page' AND state='settled' FOR UPDATE",
          [dispatchId, job.id, job.source_id, lease.token],
        )
      ).rows[0];
      if (
        !dispatch ||
        dispatch.response_hash !== digest(raw) ||
        Number(dispatch.actual_bytes) !== raw.byteLength ||
        dispatch.committed_observation_id !== null
      )
        throw new Error("quarantine_dispatch_mismatch");
      const incident =
        (
          await c.query(
            "INSERT INTO collector_quarantines(source_id,job_id,collector_run_id,dispatch_id,parser_version,cursor,reason,raw_hash,byte_length,affected_event_id,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
            [
              job.source_id,
              job.id,
              job.collector_run_id,
              dispatchId,
              PARSER_VERSION,
              job.cursor,
              reason,
              digest(raw),
              raw.byteLength,
              affectedEventId ?? null,
              now,
            ],
          )
        ).rows[0] ?? missingRow();
      await this.stopLocked(c, job.source_id, reason, false);
      await c.query(
        "INSERT INTO outbox(event_key,kind,payload,available_at) VALUES($1,'collector.evidence_quarantined',$2,$3)",
        [
          `collector-quarantine:${dispatchId}`,
          JSON.stringify({
            sourceId: job.source_id,
            jobId: job.id,
            incidentId: incident.id,
            reason,
            affectedEventId: affectedEventId ?? null,
          }),
          now,
        ],
      );
      return incident.id as string;
    });
  }
  async revokeSource(sourceId: string, reason: string) {
    await transaction(this.db, (c) => this.stopLocked(c, sourceId, reason, true));
  }
  async failBlocked(lease: Lease, reason: string) {
    return transaction(this.db, async (c) => {
      await c.query("SELECT id FROM sources WHERE id=$1 FOR UPDATE", [lease.sourceId]);
      const job = (
        await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 AND source_id=$2 FOR UPDATE", [
          lease.jobId,
          lease.sourceId,
        ])
      ).rows[0];
      if (!job || job.lease_owner !== lease.token || job.status !== "running") return false;
      await this.abandon(c, job);
      const now = await this.now(c);
      await c.query("UPDATE collector_jobs SET status='failed',error_code=$2 WHERE id=$1", [job.id, reason]);
      await c.query("UPDATE collector_runs SET outcome='failed',stop_reason=$2,completed_at=$3 WHERE id=$1", [
        job.collector_run_id,
        reason,
        now,
      ]);
      return true;
    });
  }
  async cancel(jobId: string) {
    const job = await this.view(jobId);
    await transaction(this.db, async (c) => {
      await c.query("SELECT id FROM sources WHERE id=$1 FOR UPDATE", [job.source_id]);
      const current =
        (await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0] ??
        missingRow();
      if (["completed", "failed", "cancelled"].includes(current.status)) return;
      await this.abandon(c, current);
      await c.query(
        "UPDATE collector_runs SET outcome='cancelled',stop_reason='cancelled',completed_at=$2 WHERE id=$1",
        [current.collector_run_id, await this.now(c)],
      );
      await c.query("UPDATE collector_jobs SET status='cancelled',error_code='cancelled' WHERE id=$1", [
        jobId,
      ]);
    });
  }
  async commitPage(
    lease: Lease,
    page: FixturePage,
    raw: Uint8Array,
    dispatchId: string,
  ): Promise<EvidenceItem[]> {
    return transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      const parsed = parseFixturePage(raw, {
        sourceId: job.source_id,
        queryHash: job.query_hash,
        cursor: job.cursor,
        asOf: job.as_of.toISOString(),
      });
      if (canonicalJson(parsed) !== canonicalJson(page)) throw new Error("page_payload_mismatch");
      if (
        page.sourceId !== job.source_id ||
        page.queryHash !== job.query_hash ||
        page.cursor !== job.cursor ||
        instant(page.asOf) > job.as_of.getTime()
      )
        throw new Error("page_binding_mismatch");
      const visited = job.visited_cursors;
      if (
        visited.includes(page.cursor) ||
        page.nextCursor === page.cursor ||
        (page.nextCursor !== null && visited.includes(page.nextCursor))
      )
        throw new CollectorIntegrityError("pagination_loop");
      const dispatch = (
        await c.query(
          "SELECT * FROM collector_dispatches WHERE id=$1 AND job_id=$2 AND lease_owner=$3 AND kind='page' AND state='settled' FOR UPDATE",
          [dispatchId, job.id, lease.token],
        )
      ).rows[0];
      if (
        !dispatch ||
        dispatch.response_hash !== digest(raw) ||
        Number(dispatch.actual_bytes) !== raw.byteLength ||
        dispatch.committed_observation_id !== null
      )
        throw new Error("page_dispatch_not_settled");
      const total = (
        await c.query(
          "SELECT coalesce(sum(record_count),0)::int AS n FROM source_observations WHERE collector_run_id=$1",
          [job.collector_run_id],
        )
      ).rows[0].n;
      if (total + page.records.length > 1000) throw new Error("collector_candidate_budget_exhausted");
      const rawHash = digest(raw),
        observationId = randomUUID();
      await c.query(
        "INSERT INTO source_observations(id,source_id,collector_run_id,captured_at,source_as_of,raw_hash,parser_version,record_count,permitted_visibility,retention_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{\"synthetic\":true}',$9)",
        [
          observationId,
          job.source_id,
          job.collector_run_id,
          now,
          page.asOf,
          rawHash,
          PARSER_VERSION,
          page.records.length,
          new Date(now.getTime() + 86400000),
        ],
      );
      await c.query("UPDATE collector_dispatches SET committed_observation_id=$2 WHERE id=$1", [
        dispatchId,
        observationId,
      ]);
      const images: EvidenceItem[] = [],
        newEventIds = new Set<string>();
      for (const [index, row] of page.records.entries()) {
        const candidate = structuredClone(row.candidate);
        if (!candidate.eventKey) candidate.observationKey = uncertainCandidateKey(row);
        const listing =
          (
            await c.query<{ id: string }>(
              "INSERT INTO sold_listings(source_id,marketplace,external_listing_id,title,first_seen_at,last_seen_at) VALUES($1,'ebay_us',$2,$3,$4,$4) ON CONFLICT(source_id,external_listing_id) DO UPDATE SET last_seen_at=GREATEST(sold_listings.last_seen_at,excluded.last_seen_at) RETURNING id",
              [job.source_id, row.listingId, row.title, now],
            )
          ).rows[0] ?? missingRow();
        const facts = eventFacts(row);
        let eventId: string;
        const old = candidate.eventKey
          ? (
              await c.query<{ id: string; listing_id: string }>(
                "SELECT id,listing_id FROM sale_events WHERE source_id=$1 AND source_event_key=$2",
                [job.source_id, candidate.eventKey],
              )
            ).rows[0]
          : (
              await c.query<{ id: string; listing_id: string }>(
                "SELECT id,listing_id FROM sale_events WHERE source_id=$1 AND source_event_key IS NULL AND identity_fingerprint=$2",
                [job.source_id, candidate.observationKey],
              )
            ).rows[0];
        if (old) {
          const hashes = await c.query("SELECT facts_hash FROM sale_event_evidence WHERE sale_event_id=$1", [
            old.id,
          ]);
          if (old.listing_id !== listing.id || hashes.rows.some((x) => x.facts_hash !== facts))
            throw new CollectorIntegrityError(
              newEventIds.has(old.id) ? "page_event_conflict" : "event_identity_conflict",
              newEventIds.has(old.id) ? undefined : old.id,
            );
          eventId = old.id;
        } else {
          const hasTime = candidate.time.precision === "instant";
          const result = await c.query<{ id: string }>(
            "INSERT INTO sale_events(listing_id,source_id,observation_id,source_event_key,identity_fingerprint,event_identity_status,sold_at,sold_date_raw,sold_date_precision,source_timezone,sale_format,sale_price_status,item_price_cents,observed_shipping_cents,observed_shipping_status,currency,item_price_usd_cents,shipping_usd_cents,fx_rate_source,evidence_kind,evidence_ref,first_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'synthetic',$20,$21) RETURNING id",
            [
              listing.id,
              job.source_id,
              observationId,
              candidate.eventKey,
              candidate.eventKey ? null : candidate.observationKey,
              candidate.identityVerified ? "verified" : "uncertain",
              candidate.time.precision === "instant" ? candidate.time.value : null,
              candidate.time.precision === "unknown" ? null : candidate.time.value,
              hasTime ? "second" : candidate.time.precision === "day" ? "day" : "unknown",
              candidate.time.precision === "day" ? candidate.time.timeZone : hasTime ? "UTC" : null,
              candidate.format,
              candidate.priceStatus,
              candidate.itemCents,
              candidate.shippingCents,
              candidate.shippingStatus,
              candidate.currency,
              candidate.currency === "USD"
                ? candidate.itemCents
                : (candidate.usdConversion?.itemCents ?? null),
              candidate.shippingStatus === "verified_free_shipping"
                ? 0
                : candidate.currency === "USD"
                  ? candidate.shippingCents
                  : (candidate.usdConversion?.shippingCents ?? null),
              candidate.usdConversion?.evidenceRef ?? null,
              `synthetic:${rawHash}:${index}`,
              now,
            ],
          );
          eventId = result.rows[0]?.id ?? missingRow();
          newEventIds.add(eventId);
        }
        await c.query(
          "INSERT INTO sale_event_evidence(sale_event_id,listing_id,source_id,observation_id,facts_hash,candidate,external_listing_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [
            eventId,
            listing.id,
            job.source_id,
            observationId,
            facts,
            JSON.stringify(candidate),
            row.listingId,
          ],
        );
        const image =
          (
            await c.query<{ id: string }>(
              "INSERT INTO listing_images(listing_id,source_id,observation_id,sale_event_id,state,permission_epoch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sale_event_id,listing_id,observation_id,role) DO UPDATE SET state=listing_images.state RETURNING id",
              [
                listing.id,
                job.source_id,
                observationId,
                eventId,
                row.primaryImage ? "pending" : "missing",
                job.permission_epoch,
              ],
            )
          ).rows[0] ?? missingRow();
        images.push({
          listingId: listing.id,
          eventId,
          observationId,
          imageId: image.id,
          url: row.primaryImage?.url ?? null,
        });
      }
      await c.query(
        "INSERT INTO collector_pages(job_id,source_id,observation_id,cursor,next_cursor,raw_hash,payload,page_as_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          job.id,
          job.source_id,
          observationId,
          page.cursor,
          page.nextCursor,
          rawHash,
          JSON.stringify(page),
          page.asOf,
        ],
      );
      const min = new Date(Math.min(job.min_page_as_of?.getTime() ?? Infinity, instant(page.asOf)));
      await c.query(
        "UPDATE collector_jobs SET page_count=page_count+1,cursor=$2,visited_cursors=$3,min_page_as_of=$4 WHERE id=$1",
        [job.id, page.nextCursor ?? page.cursor, JSON.stringify([...visited, page.cursor]), min],
      );
      await c.query("UPDATE collector_runs SET page_count=page_count+1,checkpoint=$2 WHERE id=$1", [
        job.collector_run_id,
        JSON.stringify({
          cursor: page.nextCursor,
          minimumAsOf: min.toISOString(),
          terminal: page.nextCursor === null,
        }),
      ]);
      await c.query(
        "INSERT INTO outbox(event_key,kind,payload,available_at) VALUES($1,'collector.page_committed',$2,$3) ON CONFLICT DO NOTHING",
        [`collector:${job.id}:${page.cursor}`, JSON.stringify({ jobId: job.id, observationId }), now],
      );
      return images;
    });
  }
  async finish(lease: Lease) {
    await transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      const last = (
        await c.query("SELECT next_cursor FROM collector_pages WHERE job_id=$1 ORDER BY page_as_of DESC", [
          job.id,
        ])
      ).rows;
      if (!last.some((x) => x.next_cursor === null) || !job.min_page_as_of)
        throw new Error("collector_run_incomplete");
      if (Number(job.bytes_reserved) !== 0) throw new Error("dispatches_unsettled");
      await c.query("UPDATE collector_jobs SET status='completed' WHERE id=$1", [job.id]);
      await c.query("UPDATE collector_runs SET completed_at=$2,outcome='completed' WHERE id=$1", [
        job.collector_run_id,
        now,
      ]);
      await c.query(
        "INSERT INTO collector_watermarks(source_id,query_hash,run_id,data_as_of) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,query_hash) DO UPDATE SET run_id=excluded.run_id,data_as_of=excluded.data_as_of WHERE collector_watermarks.data_as_of<=excluded.data_as_of",
        [job.source_id, job.query_hash, job.collector_run_id, job.min_page_as_of],
      );
    });
  }
  async persistImage(lease: Lease, id: string, image: PrimaryImage, media: PrivateMediaStore) {
    await transaction(this.db, async (c) => {
      const { job, source } = await this.locked(c, lease, true);
      if (image.sourceId !== source.id || image.permissionEpoch !== Number(source.permission_epoch))
        throw new Error("image_permission_changed");
      const target = (
        await c.query(
          "SELECT id FROM listing_images WHERE id=$1 AND listing_id=$2 AND observation_id=$3 AND sale_event_id=$4 AND source_id=$5 AND permission_epoch=$6 FOR UPDATE",
          [id, image.listingId, image.observationId, image.saleEventId, job.source_id, job.permission_epoch],
        )
      ).rows[0];
      if (!target) throw new Error("image_evidence_mismatch");
      // Network/decoding is already complete. Hold the source lock only for private
      // file publication and the matching DB link, so revoke cannot scan too early.
      await c.query("SAVEPOINT image_publication");
      let key: string | null = null;
      try {
        const object = await media.put(lease.sourceId, image.bytes);
        key = object.key;
        await this.locked(c, lease, true);
        await c.query(
          "UPDATE listing_images SET state='available',object_key=$2,content_hash=$3,mime_type=$4,width=$5,height=$6,byte_size=$7,retention_until=$8 WHERE id=$1",
          [
            id,
            key,
            image.hash,
            image.mimeType,
            image.width,
            image.height,
            image.bytes.length,
            image.retentionUntil,
          ],
        );
        await c.query("RELEASE SAVEPOINT image_publication");
      } catch (error) {
        await c.query("ROLLBACK TO SAVEPOINT image_publication");
        if (
          key &&
          !(
            await c.query(
              "SELECT 1 FROM listing_images WHERE source_id=$1 AND object_key=$2 AND state='available'",
              [lease.sourceId, key],
            )
          ).rowCount
        )
          await media.remove(key);
        throw error;
      }
    });
  }
  async failImage(lease: Lease, id: string, reason: string) {
    await transaction(this.db, async (c) => {
      const { job } = await this.locked(c, lease, true);
      await c.query(
        "UPDATE listing_images SET state='failed',failure_reason=$2 WHERE id=$1 AND source_id=$3 AND state='pending'",
        [id, reason, job.source_id],
      );
    });
  }
  async candidates(jobId: string): Promise<Candidate[]> {
    const job = await this.view(jobId);
    return transaction(this.db, async (c) => {
      const source = (await c.query<Source>("SELECT * FROM sources WHERE id=$1 FOR SHARE", [job.source_id]))
        .rows[0];
      if (
        source?.access_method !== "offline_fixture" ||
        source.status !== "active" ||
        source.permission_epoch !== job.permission_epoch
      )
        throw new Error("source_rights_unavailable");
      const rows = await c.query(
        "SELECT DISTINCT ON(e.sale_event_id) e.candidate,EXISTS(SELECT 1 FROM collector_quarantines q WHERE q.affected_event_id=e.sale_event_id) AS quarantined FROM sale_event_evidence e JOIN collector_pages p ON p.observation_id=e.observation_id AND p.source_id=e.source_id JOIN collector_jobs j ON j.id=p.job_id CROSS JOIN LATERAL jsonb_array_elements_text(j.visited_cursors) WITH ORDINALITY AS seq(cursor,position) WHERE p.job_id=$1 AND seq.cursor=p.cursor ORDER BY e.sale_event_id,seq.position DESC",
        [jobId],
      );
      if (rows.rows.some((r) => r.quarantined)) throw new Error("collector_evidence_quarantined");
      return rows.rows.map((r) => candidateFromJson(r.candidate));
    });
  }
}
