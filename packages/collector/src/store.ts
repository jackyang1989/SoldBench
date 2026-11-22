import { randomUUID } from "node:crypto";
import {
  type Candidate,
  candidateFromJson,
  canonicalJson,
  instant,
  isStandardCondition,
} from "@soldbench/core";
import { type Database, type Transaction, transaction } from "@soldbench/db";
import type { PrimaryImage, PrivateMediaStore } from "@soldbench/media";
import { artifactRetentionFields } from "./artifact-retention.ts";
import { type ConfigSnapshot, collectorConfigHash, type SourceSnapshot } from "./config-snapshot.ts";
import type { EbayItemDetailEvidence } from "./ebay-detail.ts";
import {
  COLLECTOR_VERSION,
  digest,
  eventFacts,
  type FixturePage,
  PARSER_VERSION,
  parseFixturePage,
  uncertainCandidateKey,
} from "./fixture.ts";
import { type HtmlProfile, parseHtmlPage, validateHtmlProfile } from "./html.ts";
import { CollectorIntegrityError, type QuarantineReason, quarantineReasons } from "./integrity.ts";
import { recordEvidenceFromJson } from "./record-evidence.ts";

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
type Source = SourceSnapshot & { media_store_identity: string | null };
type Config = ConfigSnapshot;
export type CollectorEnqueueInput = {
  sourceId: string;
  configId: string;
  queryHash: string;
  runKey: string;
  asOf: string;
  ttlSeconds?: number;
  expectedConfigHash?: string;
  dispatchDeadline?: string;
  refreshClaim?: { id: string; token: string };
};
export function collectorRequestHash(input: CollectorEnqueueInput, profileHash: string | null) {
  const { refreshClaim: _claim, ...stable } = input;
  return digest(
    canonicalJson({ ...stable, ttlSeconds: input.ttlSeconds ?? 3600, parserProfileHash: profileHash }),
  );
}
export type Lease = { jobId: string; token: string; sourceId: string; imageTaskId?: string };
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
  readonly htmlProfile?: HtmlProfile;
  readonly profileHash: string | null;
  constructor(
    readonly db: Database,
    readonly clock?: () => string,
    options: { htmlProfile?: HtmlProfile } = {},
  ) {
    this.htmlProfile =
      options.htmlProfile === undefined ? undefined : validateHtmlProfile(options.htmlProfile);
    this.profileHash = this.htmlProfile ? digest(canonicalJson(this.htmlProfile)) : null;
  }
  get pageContentType() {
    return this.htmlProfile ? "text/html" : "application/json";
  }
  parsePage(raw: Uint8Array, binding: { sourceId: string; queryHash: string; cursor: string; asOf: string }) {
    const page = this.htmlProfile
      ? parseHtmlPage(raw, binding, this.htmlProfile)
      : parseFixturePage(raw, binding);
    if (page.records.some((row) => row.recordEvidence && row.recordEvidence.profileHash !== this.profileHash))
      throw new Error("record_profile_mismatch");
    return page;
  }
  private async now(c: Transaction): Promise<Date> {
    if (this.clock) return new Date(instant(this.clock()));
    return (await c.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0]?.t ?? missingRow();
  }
  private async source(c: Transaction, sourceId: string) {
    const source = (await c.query<Source>("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [sourceId]))
      .rows[0];
    if (source?.access_method !== "offline_fixture") throw new Error("network_collector_not_enabled");
    if (source.status !== "active") throw new Error("source_inactive");
    const clearance = (
        await c.query("SELECT * FROM source_clearances WHERE id=$1 FOR SHARE", [source.source_clearance_id])
      ).rows[0],
      now = await this.now(c);
    if (
      clearance?.provider !== "synthetic_fixture" ||
      !["draft", "reviewed", "active"].includes(clearance.status) ||
      (clearance.expires_at && clearance.expires_at <= now) ||
      (clearance.effective_at && clearance.effective_at > now)
    )
      throw new Error("source_clearance_unavailable");
    const control = (
      await c.query(
        "SELECT status<>'closed' AS circuit_open FROM collector_circuits WHERE source_id=$1 AND category_key='*'",
        [sourceId],
      )
    ).rows[0];
    if (control?.circuit_open) throw new Error("source_circuit_open");
    return source;
  }
  private async budgetPolicy(c: Transaction, source: Source, now: Date) {
    if (!source.daily_budget_policy_hash) return null; // Legacy explicit day budgets are not a renewal policy.
    const p = (
      await c.query(
        "SELECT * FROM collector_daily_budget_policies WHERE source_id=$1 AND policy_hash=$2 FOR SHARE",
        [source.id, source.daily_budget_policy_hash],
      )
    ).rows[0];
    if (!p || p.valid_from > now || p.valid_until <= now) throw new Error("source_budget_policy_unavailable");
    return p;
  }
  private async ensureDailyBudget(c: Transaction, source: Source, now: Date) {
    const policy = await this.budgetPolicy(c, source, now);
    if (!policy) return;
    for (const [kind, cap] of [
      ["jobs", policy.jobs_cap],
      ["pages", policy.pages_cap],
      ["bytes", policy.bytes_cap],
    ]) {
      await c.query(
        "INSERT INTO source_daily_budget(source_id,day,budget_kind,cap) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,day,budget_kind) DO NOTHING",
        [source.id, now.toISOString().slice(0, 10), kind, cap],
      );
      const existing = (
        await c.query(
          "SELECT cap FROM source_daily_budget WHERE source_id=$1 AND day=$2 AND budget_kind=$3",
          [source.id, now.toISOString().slice(0, 10), kind],
        )
      ).rows[0];
      if (!existing || BigInt(existing.cap) > BigInt(cap))
        throw new Error("source_budget_policy_cap_exceeded");
    }
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
    const imageTask = lease.imageTaskId
      ? (
          await c.query(
            "SELECT q.*,o.retention_until AS evidence_expires FROM collector_image_jobs q JOIN listing_images i ON i.id=q.image_id JOIN source_observations o ON o.id=i.observation_id JOIN collector_pages p ON p.observation_id=i.observation_id AND p.source_id=i.source_id AND p.job_id=q.parent_job_id WHERE q.id=$1 AND q.source_id=$2 AND q.parent_job_id=$3 AND i.state='pending' FOR UPDATE OF q",
            [lease.imageTaskId, lease.sourceId, lease.jobId],
          )
        ).rows[0]
      : null;
    if (lease.imageTaskId) {
      if (
        job?.status !== "completed" ||
        imageTask?.status !== "running" ||
        imageTask.lease_owner !== lease.token ||
        !imageTask.lease_until ||
        imageTask.lease_until <= now ||
        imageTask.expires_at <= now ||
        !imageTask.evidence_expires ||
        imageTask.evidence_expires <= now
      )
        throw new Error("collector_image_lease_lost");
    } else if (
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
        "SELECT permission_snapshot_hash,collector_version,parser_version,parser_profile_hash FROM collector_runs WHERE id=$1",
        [job.collector_run_id],
      )
    ).rows[0];
    if (run.collector_version !== COLLECTOR_VERSION || run.parser_version !== PARSER_VERSION)
      throw new Error("collector_version_mismatch");
    if (run.parser_profile_hash !== this.profileHash) throw new Error("collector_profile_mismatch");
    if (run.permission_snapshot_hash !== collectorConfigHash(source, config))
      throw new Error("collector_config_or_permission_changed");
    const clearance = (
      await c.query("SELECT retention_days,expires_at FROM source_clearances WHERE id=$1", [
        source.source_clearance_id,
      ])
    ).rows[0];
    const retentionDays = clearance?.retention_days;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 30)
      throw new Error("fixture_retention_unavailable");
    return {
      job,
      source,
      config,
      now,
      retentionDays,
      imageTask,
      clearanceExpiresAt: clearance.expires_at as Date | null,
    };
  }
  async enqueue(input: CollectorEnqueueInput): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(input.queryHash) || !input.runKey || input.runKey.length > 160)
      throw new Error("invalid_collector_plan");
    instant(input.asOf);
    const ttl = input.ttlSeconds ?? 3600;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error("invalid_collector_deadline");
    return transaction(this.db, async (c) => {
      const source = await this.source(c, input.sourceId),
        now = await this.now(c);
      await this.budgetPolicy(c, source, now);
      if (instant(input.asOf) > now.getTime()) throw new Error("collector_as_of_in_future");
      const requestHash = collectorRequestHash(input, this.profileHash);
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
      if (source.collector_version !== COLLECTOR_VERSION || config.collector_version !== COLLECTOR_VERSION)
        throw new Error("collector_version_mismatch");
      if (
        input.expectedConfigHash !== undefined &&
        input.expectedConfigHash !== collectorConfigHash(source, config)
      )
        throw new Error("collector_config_or_permission_changed");
      if (input.dispatchDeadline && instant(input.dispatchDeadline) <= now.getTime())
        throw new Error("refresh_deadline_expired");
      if (input.runKey.startsWith("refresh:") && !input.refreshClaim)
        throw new Error("refresh_claim_required");
      if (input.refreshClaim) {
        const occurrence = (
          await c.query(
            "SELECT o.*,p.config_id,p.query_hash,p.config_hash,p.retired_at,p.job_ttl_seconds,p.collector_version,p.parser_version,p.profile_hash FROM collector_refresh_occurrences o JOIN collector_refresh_plans p ON p.id=o.plan_id WHERE o.id=$1 AND o.source_id=$2 FOR UPDATE OF o",
            [input.refreshClaim.id, input.sourceId],
          )
        ).rows[0];
        if (
          occurrence?.status !== "dispatching" ||
          occurrence.retired_at ||
          occurrence.lease_owner !== input.refreshClaim.token ||
          occurrence.lease_until <= now ||
          input.runKey !== `refresh:${occurrence.id}` ||
          ttl !== occurrence.job_ttl_seconds ||
          occurrence.collector_version !== COLLECTOR_VERSION ||
          occurrence.parser_version !== PARSER_VERSION ||
          occurrence.profile_hash !== this.profileHash ||
          occurrence.config_id !== input.configId ||
          occurrence.query_hash !== input.queryHash ||
          occurrence.config_hash !== input.expectedConfigHash ||
          occurrence.as_of?.toISOString() !== new Date(input.asOf).toISOString() ||
          occurrence.deadline_at.toISOString() !== input.dispatchDeadline
        )
          throw new Error("refresh_lease_lost");
      }
      const day = now.toISOString().slice(0, 10);
      await this.ensureDailyBudget(c, source, now);
      const budget = await c.query(
        "UPDATE source_daily_budget SET used=used+1 WHERE source_id=$1 AND day=$2 AND budget_kind='jobs' AND used+reserved+1<=cap RETURNING cap",
        [input.sourceId, day],
      );
      if (!budget.rowCount) throw new Error("collector_daily_jobs_exhausted");
      const runId = randomUUID();
      await c.query(
        "INSERT INTO collector_runs(id,source_id,config_id,query_hash,collector_version,parser_version,permission_snapshot_hash,started_at,parser_profile_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          runId,
          input.sourceId,
          input.configId,
          input.queryHash,
          COLLECTOR_VERSION,
          PARSER_VERSION,
          collectorConfigHash(source, config),
          now,
          this.profileHash,
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
      const source = await this.source(c, sourceId);
      const now = await this.now(c);
      await this.budgetPolicy(c, source, now);
      if (source.retry_after_until && source.retry_after_until > now) return null;
      const configs = await c.query<Config>(
        "SELECT * FROM collector_configs WHERE source_id=$1 AND enabled=true AND access_method='offline_fixture' ORDER BY id",
        [sourceId],
      );
      for (const config of configs.rows) {
        const running = (
          await c.query(
            "SELECT ((SELECT count(*) FROM collector_jobs WHERE source_id=$1 AND status='running' AND lease_until>$2)+(SELECT count(*) FROM collector_image_jobs WHERE source_id=$1 AND status='running' AND lease_until>$2))::int AS n",
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
            await c.query(
              "SELECT collector_version,parser_version,parser_profile_hash FROM collector_runs WHERE id=$1",
              [job.collector_run_id],
            )
          ).rows[0];
          if (run?.collector_version !== COLLECTOR_VERSION || run.parser_version !== PARSER_VERSION)
            throw new Error("collector_version_mismatch");
          if (run.parser_profile_hash !== this.profileHash) throw new Error("collector_profile_mismatch");
          await this.abandon(c, job);
          const crashAttempt = job.status === "running" ? 1 : 0;
          if (job.expires_at <= now || job.attempts + crashAttempt >= 3) {
            await this.finishUnclaimableJob(c, job, now);
            continue;
          }
          const token = randomUUID();
          await c.query(
            "UPDATE collector_jobs SET status='running',attempts=attempts+$4,lease_count=lease_count+1,version=version+1,lease_owner=$2,lease_until=$3,started_at=coalesce(started_at,$5) WHERE id=$1",
            [job.id, token, new Date(now.getTime() + leaseSeconds * 1000), crashAttempt, now],
          );
          return { jobId: job.id, token, sourceId };
        }
      }
      return null;
    });
  }
  private async finishUnclaimableJob(c: Transaction, job: Job, now: Date) {
    await c.query(
      "UPDATE collector_runs SET outcome='failed',stop_reason='expired_or_attempts_exhausted',completed_at=$2 WHERE id=$1",
      [job.collector_run_id, now],
    );
    await c.query(
      `UPDATE collector_jobs SET status='failed',error_code='expired_or_attempts_exhausted',finished_at=$2,
         lease_owner=NULL,lease_until=NULL,version=version+1 WHERE id=$1`,
      [job.id, now],
    );
  }
  /** Terminal bookkeeping can proceed without a response artifact or a new transport lease. */
  async settleUnclaimable(sourceId: string) {
    return transaction(this.db, async (c) => {
      const { rows } = await c.query(
        `SELECT s.access_method,p.provider FROM sources s JOIN source_clearances p ON p.id=s.source_clearance_id
         WHERE s.id=$1 FOR UPDATE OF s`,
        [sourceId],
      );
      if (rows[0]?.access_method !== "offline_fixture" || rows[0].provider !== "synthetic_fixture")
        throw new Error("network_collector_not_enabled");
      const now = await this.now(c);
      const { rows: jobs } = await c.query<Job>(
        `SELECT * FROM collector_jobs WHERE source_id=$1
         AND (status IN ('queued','retry') OR (status='running' AND lease_until<=$2))
         AND (expires_at<=$2 OR attempts+CASE WHEN status='running' THEN 1 ELSE 0 END>=3)
         ORDER BY expires_at,id LIMIT 50 FOR UPDATE`,
        [sourceId, now],
      );
      for (const job of jobs) {
        await this.abandon(c, job);
        await this.finishUnclaimableJob(c, job, now);
      }
      const { rows: photos } = await c.query<{
        id: string;
        parent_job_id: string;
        image_id: string;
        lease_owner: string | null;
        reason: string;
        terminal: string;
      }>(
        `SELECT t.id,t.parent_job_id,t.image_id,t.lease_owner,
           CASE WHEN t.expires_at<=$2 THEN 'image_retry_expired'
                WHEN t.attempts>=3 THEN 'image_retry_exhausted' ELSE 'image_retry_source_or_evidence_changed' END reason,
           CASE WHEN t.expires_at<=$2 THEN 'expired' ELSE 'failed' END terminal
         FROM collector_image_jobs t JOIN collector_jobs j ON j.id=t.parent_job_id AND j.source_id=t.source_id
         WHERE t.source_id=$1 AND (t.status='retry' OR (t.status='running' AND t.lease_until<=$2))
           AND (t.expires_at<=$2 OR t.attempts>=3 OR j.status IN ('failed','cancelled','expired'))
         ORDER BY t.expires_at,t.id LIMIT 50 FOR UPDATE OF j,t`,
        [sourceId, now],
      );
      for (const task of photos) {
        if (task.lease_owner) {
          const parent = (
            await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1", [task.parent_job_id])
          ).rows[0];
          if (!parent) missingRow();
          await this.abandon(c, parent, task.lease_owner);
        }
        await this.finishImageRetry(c, task.id, task.image_id, task.terminal, task.reason, now);
      }
      return { pagesClosed: jobs.length, imageRetriesClosed: photos.length };
    });
  }
  private async abandon(c: Transaction, job: Job, leaseOwner?: string) {
    const reservations = await c.query(
      `SELECT * FROM collector_dispatches WHERE job_id=$1 AND state='reserved'
       AND ($2::text IS NULL OR lease_owner=$2) FOR UPDATE`,
      [job.id, leaseOwner ?? null],
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
  async bindFixtureArtifact(
    input: {
      jobId: string;
      sourceId: string;
      queryHash: string;
      asOf: string;
      hash: string;
      pageHashes: ReadonlyMap<string, ReadonlySet<string>>;
    },
    persist?: () => Promise<void>,
  ) {
    if (!/^[a-f0-9]{64}$/.test(input.hash)) throw new Error("invalid_fixture_artifact_hash");
    await transaction(this.db, async (c) => {
      const source = await this.source(c, input.sourceId);
      const job = (
        await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 AND source_id=$2 FOR UPDATE", [
          input.jobId,
          input.sourceId,
        ])
      ).rows[0];
      if (!job || job.query_hash !== input.queryHash || job.as_of.getTime() !== instant(input.asOf))
        throw new Error("fixture_artifact_job_mismatch");
      if (job.permission_epoch !== source.permission_epoch) throw new Error("fixture_artifact_epoch_changed");
      const run = (
        await c.query(
          "SELECT fixture_artifact_hash,parser_profile_hash FROM collector_runs WHERE id=$1 FOR UPDATE",
          [job.collector_run_id],
        )
      ).rows[0];
      if (run.parser_profile_hash !== this.profileHash) throw new Error("collector_profile_mismatch");
      if (run.fixture_artifact_hash && run.fixture_artifact_hash !== input.hash)
        throw new Error("fixture_artifact_changed");
      const pages = await c.query("SELECT cursor,raw_hash FROM collector_pages WHERE job_id=$1", [job.id]);
      if (pages.rows.some((page) => !input.pageHashes.get(page.cursor)?.has(page.raw_hash)))
        throw new Error("fixture_artifact_committed_page_mismatch");
      const now = await this.now(c);
      if (persist && run.fixture_artifact_hash) {
        const {
          rows: [retention],
        } = await c.query(`SELECT ${artifactRetentionFields("$2")} FROM collector_jobs j WHERE j.id=$1`, [
          job.id,
          now,
        ]);
        if (!retention.pending_work && retention.known_evidence && !retention.current_evidence)
          throw new Error("fixture_artifact_retention_expired");
      }
      if (
        !run.fixture_artifact_hash &&
        (job.expires_at <= now || !["queued", "running", "retry"].includes(job.status))
      ) {
        const retry = await c.query(
          `SELECT 1 FROM collector_image_jobs WHERE source_id=$1 AND parent_job_id=$2
             AND status IN ('retry','running') AND expires_at>$3 LIMIT 1`,
          [job.source_id, job.id, now],
        );
        if (!retry.rowCount) throw new Error("fixture_artifact_job_inactive");
      }
      // Disk publication takes the same source lock as pause/revocation. A staged copy is recoverable
      // even if filesystem publication succeeded and the database transaction did not commit.
      await persist?.();
      if (run.fixture_artifact_hash) return;
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
      const { job, now, imageTask } = await this.locked(c, lease);
      if (lease.imageTaskId) {
        await c.query("UPDATE collector_image_jobs SET lease_until=$2 WHERE id=$1", [
          lease.imageTaskId,
          new Date(Math.min(now.getTime() + seconds * 1000, imageTask.expires_at.getTime())),
        ]);
        return;
      }
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
    imageId?: string,
  ): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024)
      throw new Error("invalid_dispatch_budget");
    if (fixtureKey !== undefined && (!fixtureKey.startsWith(`${kind}:`) || fixtureKey.length > 2200))
      throw new Error("invalid_fixture_request_key");
    return transaction(this.db, async (c) => {
      const { job, config, now, source, imageTask } = await this.locked(c, lease);
      if (source.retry_after_until && source.retry_after_until > now)
        throw new Error("collector_rate_limited");
      if (imageTask && imageTask.image_id !== imageId) throw new Error("image_task_target_mismatch");
      if (
        imageId &&
        (kind !== "image" ||
          !(
            await c.query(
              "SELECT 1 FROM listing_images i JOIN collector_pages p ON p.observation_id=i.observation_id AND p.source_id=i.source_id WHERE i.id=$1 AND p.job_id=$2",
              [imageId, job.id],
            )
          ).rowCount)
      )
        throw new Error("image_dispatch_evidence_mismatch");
      if (lease.imageTaskId && kind !== "image") throw new Error("image_lease_cannot_fetch_page");
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
      await this.ensureDailyBudget(c, source, now);
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
        "INSERT INTO collector_dispatches(id,job_id,source_id,lease_owner,kind,budget_day,max_bytes,created_at,fixture_key_hash,fixture_response_index,image_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          job.id,
          job.source_id,
          lease.token,
          kind,
          day,
          maxBytes,
          now,
          keyHash,
          responseIndex,
          imageId ?? null,
        ],
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
      const { job, now, source } = await this.locked(c, lease);
      await this.budgetPolicy(c, source, now);
      if (source.retry_after_until && source.retry_after_until > now)
        throw new Error("collector_rate_limited");
      const row = (
        await c.query(
          "SELECT *,budget_day::text AS budget_day FROM collector_dispatches WHERE id=$1 AND job_id=$2 AND lease_owner=$3 AND state='reserved' FOR UPDATE",
          [dispatchId, lease.jobId, lease.token],
        )
      ).rows[0];
      if (!row?.fixture_key_hash) throw new Error("dispatch_not_reserved");
      if (row.dispatched_at) return row.fixture_response_index;
      if (row.budget_day !== now.toISOString().slice(0, 10)) throw new Error("collector_budget_day_changed");
      if (lease.imageTaskId) {
        const updated = await c.query(
          "UPDATE collector_image_jobs SET attempts=attempts+1 WHERE id=$1 AND attempts<3 RETURNING id",
          [lease.imageTaskId],
        );
        if (!updated.rowCount) throw new Error("image_retry_exhausted");
      }
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
      if (lease.imageTaskId && row.kind === "image" && row.dispatched_at)
        await c.query("UPDATE collector_image_jobs SET attempts=greatest(0,attempts-1) WHERE id=$1", [
          lease.imageTaskId,
        ]);
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
      if (x.source.retry_after_until && x.source.retry_after_until > x.now)
        throw new Error("collector_rate_limited");
      return {
        epoch: Number(x.source.permission_epoch),
        now: x.now.toISOString(),
        expiresAt: new Date(
          Math.min(
            x.now.getTime() + x.retentionDays * 86400000,
            x.imageTask?.evidence_expires?.getTime() ?? Infinity,
            x.clearanceExpiresAt?.getTime() ?? Infinity,
          ),
        ).toISOString(),
      };
    });
  }
  async defer(lease: Lease, reason: string, delaySeconds: number, terminal = false) {
    if (lease.imageTaskId) throw new Error("image_lease_cannot_mutate_parent");
    await transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      await this.abandon(c, job);
      const nextAttempt =
        job.attempts +
        ([
          "upstream_rate_limited",
          "collector_rate_limited",
          "collector_budget_day_changed",
          "worker_yield",
          "worker_shutdown",
        ].includes(reason)
          ? 0
          : 1);
      if (terminal || nextAttempt >= 3)
        await c.query(
          "UPDATE collector_runs SET outcome='failed',stop_reason=$2,completed_at=$3 WHERE id=$1",
          [job.collector_run_id, reason, now],
        );
      await c.query(
        "UPDATE collector_jobs SET status=$2,error_code=$3,available_at=$4,lease_until=$5,attempts=$6,finished_at=CASE WHEN $2='failed' THEN $5::timestamptz ELSE NULL END WHERE id=$1",
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
  /** Trusted operational transaction. Caller authorizes the command and records audit. */
  async stopLocked(c: Transaction, sourceId: string, reason: string, revoke: boolean) {
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
      "UPDATE collector_jobs SET status='failed',error_code=$2,finished_at=$3 WHERE source_id=$1 AND status IN ('queued','running','retry')",
      [sourceId, reason, now],
    );
    const mediaTasks = (
      await c.query(
        "SELECT DISTINCT parent_job_id FROM collector_image_jobs WHERE source_id=$1 AND status='running'",
        [sourceId],
      )
    ).rows;
    for (const task of mediaTasks) {
      const parent = (
        await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 FOR UPDATE", [task.parent_job_id])
      ).rows[0];
      if (parent) await this.abandon(c, parent);
    }
    await c.query(
      "UPDATE listing_images SET state='failed',failure_reason='source_stopped' WHERE source_id=$1 AND state='pending'",
      [sourceId],
    );
    await c.query(
      "UPDATE collector_image_jobs SET status='failed',lease_owner=NULL,lease_until=NULL,failure_reason=$2,finished_at=$3 WHERE source_id=$1 AND status IN ('retry','running')",
      [sourceId, reason, now],
    );
    await c.query("UPDATE sources SET ops_version=ops_version+1 WHERE id=$1", [sourceId]);
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
    const maxBytes = this.htmlProfile?.bindingMode === "envelope" ? 4 * 1024 * 1024 : 1024 * 1024;
    if (
      !quarantineReasons.includes(reason) ||
      raw.byteLength > maxBytes ||
      (reason === "event_identity_conflict") !== (affectedEventId !== undefined)
    )
      throw new Error("invalid_quarantine_evidence");
    if (lease.imageTaskId) throw new Error("image_lease_cannot_mutate_parent");
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
  async revokeInvalidClearance(sourceId: string): Promise<boolean> {
    return transaction(this.db, async (c) => {
      const source = (await c.query<Source>("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [sourceId]))
        .rows[0];
      if (source?.access_method !== "offline_fixture") throw new Error("network_collector_not_enabled");
      const clearance = (
          await c.query("SELECT * FROM source_clearances WHERE id=$1 FOR SHARE", [source.source_clearance_id])
        ).rows[0],
        now = await this.now(c);
      if (clearance?.provider !== "synthetic_fixture") throw new Error("network_collector_not_enabled");
      const invalid =
        !["draft", "reviewed", "active"].includes(clearance.status) ||
        (clearance.effective_at && clearance.effective_at > now) ||
        (clearance.expires_at && clearance.expires_at <= now);
      if (source.status !== "active" || !invalid) return false;
      await this.stopLocked(c, sourceId, "source_clearance_unavailable", true);
      return true;
    });
  }
  async revokeSource(sourceId: string, reason: string) {
    await transaction(this.db, (c) => this.stopLocked(c, sourceId, reason, true));
  }
  async failBlocked(lease: Lease, reason: string) {
    if (lease.imageTaskId) throw new Error("image_lease_cannot_mutate_parent");
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
      await c.query("UPDATE collector_jobs SET status='failed',error_code=$2,finished_at=$3 WHERE id=$1", [
        job.id,
        reason,
        now,
      ]);
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
    if (lease.imageTaskId) throw new Error("image_lease_cannot_mutate_parent");
    return transaction(this.db, async (c) => {
      const { job, now, retentionDays } = await this.locked(c, lease);
      const parsed = this.parsePage(raw, {
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
          new Date(now.getTime() + retentionDays * 86400000),
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
        if (row.recordEvidence) {
          if (row.recordEvidence.profileHash !== this.profileHash) throw new Error("record_profile_mismatch");
          await c.query(
            "INSERT INTO listing_record_evidence(sale_event_id,listing_id,source_id,observation_id,profile_hash,record_index,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
            [
              eventId,
              listing.id,
              job.source_id,
              observationId,
              row.recordEvidence.profileHash,
              row.recordEvidence.recordIndex,
              JSON.stringify(row.recordEvidence),
            ],
          );
        }
        const image =
          (
            await c.query<{ id: string }>(
              "INSERT INTO listing_images(listing_id,source_id,observation_id,sale_event_id,state,permission_epoch,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(sale_event_id,listing_id,observation_id,role) DO UPDATE SET state=listing_images.state RETURNING id",
              [
                listing.id,
                job.source_id,
                observationId,
                eventId,
                row.primaryImage ? "pending" : "missing",
                job.permission_epoch,
                now,
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
  async finish(lease: Lease, options: { allowIncompleteCursor?: boolean } = {}) {
    if (lease.imageTaskId) throw new Error("image_lease_cannot_finish_parent");
    await transaction(this.db, async (c) => {
      const { job, now } = await this.locked(c, lease);
      const last = (
        await c.query("SELECT next_cursor FROM collector_pages WHERE job_id=$1 ORDER BY page_as_of DESC", [
          job.id,
        ])
      ).rows;
      if (
        (!options.allowIncompleteCursor && !last.some((x) => x.next_cursor === null)) ||
        !last.length ||
        !job.min_page_as_of
      )
        throw new Error("collector_run_incomplete");
      if (Number(job.bytes_reserved) !== 0) throw new Error("dispatches_unsettled");
      await c.query(
        "UPDATE collector_jobs SET status='completed',finished_at=$2,error_code=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1",
        [job.id, now],
      );
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
  /** Called under a source lock. Legacy media is adopted only with evidence in this store. */
  async matchMediaStore(c: Transaction, sourceId: string, media: PrivateMediaStore, writing = false) {
    const source = (
      await c.query(
        "SELECT s.media_store_identity,s.access_method,x.provider FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 FOR UPDATE OF s",
        [sourceId],
      )
    ).rows[0];
    if (source?.access_method !== "offline_fixture" || source.provider !== "synthetic_fixture")
      throw new Error("network_collector_not_enabled");
    const identity = await media.storageIdentity(writing && !source.media_store_identity);
    if (!identity) return false;
    if (source.media_store_identity) return source.media_store_identity === identity;
    const references = await c.query(
      "SELECT DISTINCT object_key FROM listing_images WHERE source_id=$1 AND object_key IS NOT NULL",
      [sourceId],
    );
    if (!references.rowCount) {
      if (!writing) return false;
      const dispatched = await c.query(
        "SELECT 1 FROM collector_dispatches WHERE source_id=$1 AND kind='image' LIMIT 1",
        [sourceId],
      );
      if (dispatched.rowCount) return false;
    }
    for (const row of references.rows)
      try {
        if (!row.object_key.startsWith(`${sourceId}/`)) return false;
        await media.get(row.object_key, identity);
      } catch {
        return false;
      }
    if (identity !== (await media.storageIdentity())) return false;
    await c.query("UPDATE sources SET media_store_identity=$2 WHERE id=$1", [sourceId, identity]);
    return true;
  }
  async bindImageStore(lease: Lease, media: PrivateMediaStore) {
    await transaction(this.db, async (c) => {
      await this.locked(c, lease, true);
      if (!(await this.matchMediaStore(c, lease.sourceId, media, true)))
        throw new Error("image_storage_unavailable");
    });
  }
  async persistImage(lease: Lease, id: string, image: PrimaryImage, media: PrivateMediaStore) {
    await transaction(this.db, async (c) => {
      const { job, source, imageTask, now, clearanceExpiresAt } = await this.locked(c, lease, true);
      if (imageTask && imageTask.image_id !== id) throw new Error("image_task_target_mismatch");
      if (image.sourceId !== source.id || image.permissionEpoch !== Number(source.permission_epoch))
        throw new Error("image_permission_changed");
      if (!source.media_store_identity || source.media_store_identity !== (await media.storageIdentity()))
        throw new Error("image_storage_unavailable");
      const target = (
        await c.query(
          "SELECT i.id,o.retention_until AS evidence_expires FROM listing_images i JOIN source_observations o ON o.id=i.observation_id WHERE i.id=$1 AND i.listing_id=$2 AND i.observation_id=$3 AND i.sale_event_id=$4 AND i.source_id=$5 AND i.permission_epoch=$6 FOR UPDATE OF i",
          [id, image.listingId, image.observationId, image.saleEventId, job.source_id, job.permission_epoch],
        )
      ).rows[0];
      if (!target?.evidence_expires || target.evidence_expires <= now)
        throw new Error("image_evidence_mismatch");
      const retentionUntil = new Date(
        Math.min(
          instant(image.retentionUntil),
          target.evidence_expires.getTime(),
          clearanceExpiresAt?.getTime() ?? Infinity,
        ),
      );
      if (retentionUntil <= now) throw new Error("image_evidence_expired");
      // Network/decoding is already complete. Hold the source lock only for private
      // file publication and the matching DB link, so revoke cannot scan too early.
      await c.query("SAVEPOINT image_publication");
      let key: string | null = null;
      try {
        const object = await media.put(lease.sourceId, image.bytes, source.media_store_identity);
        key = object.key;
        if (source.media_store_identity !== (await media.storageIdentity()))
          throw new Error("media_store_mismatch");
        await this.locked(c, lease, true);
        await c.query(
          "UPDATE listing_images SET state='available',object_key=$2,content_hash=$3,mime_type=$4,width=$5,height=$6,byte_size=$7,retention_until=$8,failure_reason=NULL WHERE id=$1",
          [
            id,
            key,
            image.hash,
            image.mimeType,
            image.width,
            image.height,
            image.bytes.length,
            retentionUntil,
          ],
        );
        if (lease.imageTaskId)
          await c.query(
            "UPDATE collector_image_jobs SET status='completed',lease_owner=NULL,lease_until=NULL,finished_at=$2,failure_reason=NULL WHERE id=$1",
            [lease.imageTaskId, now],
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
          await media.remove(key, source.media_store_identity);
        throw error;
      }
    });
  }
  async failImage(lease: Lease, id: string, reason: string) {
    await transaction(this.db, async (c) => {
      const { job, now, imageTask } = await this.locked(c, lease, true);
      if (imageTask && imageTask.image_id !== id) throw new Error("image_task_target_mismatch");
      if (lease.imageTaskId)
        await c.query(
          "UPDATE collector_image_jobs SET status='failed',lease_owner=NULL,lease_until=NULL,failure_reason=$2,finished_at=$3 WHERE id=$1",
          [lease.imageTaskId, reason, now],
        );
      await c.query(
        "UPDATE listing_images SET state='failed',failure_reason=$2 WHERE id=$1 AND source_id=$3 AND state='pending'",
        [id, reason, job.source_id],
      );
    });
  }
  async recordBackoff(lease: Lease, seconds: number) {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("invalid_retry_after");
    await transaction(this.db, async (c) => {
      const { now } = await this.locked(c, lease, true);
      await c.query(
        "UPDATE sources SET retry_after_until=greatest(coalesce(retry_after_until,$2),$2) WHERE id=$1",
        [lease.sourceId, new Date(now.getTime() + seconds * 1000)],
      );
    });
  }
  async queueImageRetry(lease: Lease, imageId: string, reason: string, delaySeconds = 30) {
    if (lease.imageTaskId || !Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400)
      throw new Error("image_task_already_queued");
    return transaction(this.db, async (c) => {
      const { job, now, clearanceExpiresAt } = await this.locked(c, lease, true);
      const image = (
        await c.query(
          "SELECT i.*,o.retention_until AS evidence_expires FROM listing_images i JOIN source_observations o ON o.id=i.observation_id JOIN collector_pages p ON p.observation_id=i.observation_id AND p.source_id=i.source_id WHERE i.id=$1 AND p.job_id=$2 AND i.source_id=$3 FOR UPDATE OF i",
          [imageId, job.id, lease.sourceId],
        )
      ).rows[0];
      if (image?.state !== "pending") throw new Error("image_retry_evidence_missing");
      const expires = new Date(
        Math.min(
          image.evidence_expires?.getTime() ?? 0,
          now.getTime() + 86400000,
          clearanceExpiresAt?.getTime() ?? Infinity,
        ),
      );
      if (expires <= now) {
        await c.query(
          "UPDATE listing_images SET state='expired',failure_reason='evidence_expired' WHERE id=$1",
          [imageId],
        );
        return;
      }
      const count = (
        await c.query(
          "SELECT count(*)::int n FROM collector_dispatches WHERE job_id=$1 AND image_id=$2 AND dispatched_at IS NOT NULL",
          [job.id, imageId],
        )
      ).rows[0].n;
      if (count >= 3) {
        await c.query(
          "UPDATE listing_images SET state='failed',failure_reason='image_retry_exhausted' WHERE id=$1",
          [imageId],
        );
        return;
      }
      await c.query(
        "INSERT INTO collector_image_jobs(image_id,source_id,parent_job_id,status,attempts,available_at,expires_at,failure_reason,created_at) VALUES($1,$2,$3,'retry',$8,$4,$5,$6,$7) ON CONFLICT(image_id) DO NOTHING",
        [
          imageId,
          lease.sourceId,
          job.id,
          new Date(now.getTime() + delaySeconds * 1000),
          expires,
          reason,
          now,
          count,
        ],
      );
      await c.query("UPDATE listing_images SET failure_reason=$2 WHERE id=$1", [imageId, reason]);
      await c.query(
        "INSERT INTO outbox(kind,event_key,payload,available_at) VALUES('collector.image_retry',$1,$2,$3) ON CONFLICT DO NOTHING",
        [`image-retry:${imageId}`, JSON.stringify({ image_id: imageId, parent_job_id: job.id }), now],
      );
    });
  }
  async claimImageRetry(sourceId: string, parentJobId?: string): Promise<Lease | null> {
    return transaction(this.db, async (c) => {
      const source = await this.source(c, sourceId),
        now = await this.now(c);
      await this.budgetPolicy(c, source, now);
      if (source.retry_after_until && source.retry_after_until > now) return null;
      const tasks = (
        await c.query(
          "SELECT t.* FROM collector_image_jobs t JOIN collector_jobs j ON j.id=t.parent_job_id WHERE t.source_id=$1 AND ($2::uuid IS NULL OR t.parent_job_id=$2) AND (t.status='retry' AND (t.available_at<=$3 OR t.expires_at<=$3) OR t.status='running' AND t.lease_until<=$3) AND ((j.status='completed' AND NOT EXISTS(SELECT 1 FROM collector_image_jobs busy WHERE busy.parent_job_id=t.parent_job_id AND busy.status='running' AND busy.lease_until>$3)) OR j.status IN ('failed','cancelled','expired') OR t.expires_at<=$3) ORDER BY CASE WHEN j.status='completed' AND t.expires_at>$3 THEN 0 ELSE 1 END,t.available_at,t.id LIMIT 50",
          [sourceId, parentJobId ?? null, now],
        )
      ).rows;
      for (const task of tasks) {
        const job = (
          await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 FOR UPDATE", [task.parent_job_id])
        ).rows[0];
        const current = (
          await c.query("SELECT * FROM collector_image_jobs WHERE id=$1 FOR UPDATE", [task.id])
        ).rows[0];
        if (!job || !current || !["retry", "running"].includes(current.status)) continue;
        if (current.status === "running") {
          if (current.lease_until > now) continue;
          await this.abandon(c, job);
          job.bytes_reserved = (
            await c.query("SELECT bytes_reserved FROM collector_jobs WHERE id=$1", [job.id])
          ).rows[0].bytes_reserved;
          await c.query(
            "UPDATE collector_image_jobs SET status='retry',lease_owner=NULL,lease_until=NULL WHERE id=$1",
            [current.id],
          );
        }
        const image = (
          await c.query("SELECT * FROM listing_images WHERE id=$1 FOR UPDATE", [current.image_id])
        ).rows[0];
        const config = (
          await c.query<Config>("SELECT * FROM collector_configs WHERE id=$1 AND source_id=$2", [
            job.config_id,
            sourceId,
          ])
        ).rows[0];
        const run = (
          await c.query(
            "SELECT collector_version,parser_version,parser_profile_hash,permission_snapshot_hash FROM collector_runs WHERE id=$1",
            [job.collector_run_id],
          )
        ).rows[0];
        const expired = current.expires_at <= now;
        const linked = (
          await c.query(
            "SELECT 1 FROM listing_images i JOIN collector_pages p ON p.observation_id=i.observation_id AND p.source_id=i.source_id JOIN source_observations o ON o.id=i.observation_id WHERE i.id=$1 AND p.job_id=$2 AND o.retention_until>$3",
            [current.image_id, job.id, now],
          )
        ).rowCount;
        const valid =
          Boolean(linked) &&
          image?.state === "pending" &&
          image.permission_epoch === source.permission_epoch &&
          job.permission_epoch === source.permission_epoch &&
          config?.enabled &&
          config.access_method === "offline_fixture" &&
          run?.collector_version === COLLECTOR_VERSION &&
          run.parser_version === PARSER_VERSION &&
          run.parser_profile_hash === this.profileHash &&
          run.permission_snapshot_hash === collectorConfigHash(source, config);
        if (
          expired ||
          current.attempts >= 3 ||
          !valid ||
          ["failed", "cancelled", "expired"].includes(job.status)
        ) {
          const reason = expired
            ? "image_retry_expired"
            : current.attempts >= 3
              ? "image_retry_exhausted"
              : "image_retry_source_or_evidence_changed";
          await this.finishImageRetry(
            c,
            current.id,
            current.image_id,
            expired ? "expired" : "failed",
            reason,
            now,
          );
          continue;
        }
        if (job.status !== "completed") continue;
        const busy = (
          await c.query(
            "SELECT ((SELECT count(*) FROM collector_jobs WHERE source_id=$1 AND status='running' AND lease_until>$2)+(SELECT count(*) FROM collector_image_jobs WHERE source_id=$1 AND status='running' AND lease_until>$2))::int n",
            [sourceId, now],
          )
        ).rows[0].n;
        if (busy >= config.concurrency_cap) continue;
        const parentBusy = (
          await c.query("SELECT 1 FROM collector_image_jobs WHERE parent_job_id=$1 AND status='running'", [
            job.id,
          ])
        ).rowCount;
        if (parentBusy || Number(job.bytes_reserved) > 0) continue;
        const token = randomUUID();
        await c.query(
          "UPDATE collector_image_jobs SET status='running',lease_owner=$2,lease_until=$3 WHERE id=$1",
          [current.id, token, new Date(Math.min(now.getTime() + 60000, current.expires_at.getTime()))],
        );
        return { jobId: job.id, sourceId, token, imageTaskId: current.id };
      }
      return null;
    });
  }
  private async finishImageRetry(
    c: Transaction,
    id: string,
    imageId: string,
    status: string,
    reason: string,
    now: Date,
  ) {
    await c.query(
      "UPDATE collector_image_jobs SET status=$2,lease_owner=NULL,lease_until=NULL,failure_reason=$3,finished_at=$4 WHERE id=$1",
      [id, status, reason, now],
    );
    await c.query("UPDATE listing_images SET state=$2,failure_reason=$3 WHERE id=$1 AND state='pending'", [
      imageId,
      status,
      reason,
    ]);
  }
  async deferImageRetry(lease: Lease, reason: string, delaySeconds = 30) {
    if (!lease.imageTaskId || !Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400)
      throw new Error("invalid_image_retry");
    return transaction(this.db, async (c) => {
      const { job, now, imageTask } = await this.locked(c, lease, true);
      await this.abandon(c, job);
      const attempts = imageTask.attempts;
      const next = new Date(now.getTime() + delaySeconds * 1000),
        terminal = attempts >= 3 || next >= imageTask.expires_at;
      await c.query(
        "UPDATE collector_image_jobs SET status=$2,lease_owner=NULL,lease_until=NULL,available_at=$3,failure_reason=$4,finished_at=$5 WHERE id=$1",
        [imageTask.id, terminal ? "failed" : "retry", next, reason, terminal ? now : null],
      );
      if (terminal)
        await c.query(
          "UPDATE listing_images SET state='failed',failure_reason=$2 WHERE id=$1 AND state='pending'",
          [imageTask.image_id, reason],
        );
      return terminal ? "failed" : "retry";
    });
  }
  /** Current readable synthetic evidence; circuit stops collection, rights withdrawal stops reads. */
  async readScope(c: Transaction, sourceId: string) {
    const row = (
        await c.query(
          "SELECT s.*,x.provider,x.status AS clearance_status,x.effective_at,x.expires_at FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 FOR SHARE OF s,x",
          [sourceId],
        )
      ).rows[0],
      now = await this.now(c);
    if (
      row?.access_method !== "offline_fixture" ||
      row.provider !== "synthetic_fixture" ||
      row.status !== "active" ||
      !["draft", "reviewed", "active"].includes(row.clearance_status) ||
      (row.effective_at && row.effective_at > now) ||
      (row.expires_at && row.expires_at <= now)
    )
      throw new Error("source_rights_unavailable");
    return { source: row, now };
  }
  async candidates(jobId: string): Promise<Candidate[]> {
    const job = await this.view(jobId);
    return transaction(this.db, async (c) => {
      const { source, now } = await this.readScope(c, job.source_id);
      if (source.permission_epoch !== job.permission_epoch) throw new Error("source_rights_unavailable");
      const expired = (
        await c.query(
          "SELECT 1 FROM collector_pages p JOIN source_observations o ON o.id=p.observation_id WHERE p.job_id=$1 AND (o.retention_until IS NULL OR o.retention_until<=$2) LIMIT 1",
          [jobId, now],
        )
      ).rowCount;
      if (expired) throw new Error("source_evidence_expired");
      const rows = await c.query(
        "SELECT DISTINCT ON(e.sale_event_id) e.candidate,o.retention_until,EXISTS(SELECT 1 FROM collector_quarantines q WHERE q.affected_event_id=e.sale_event_id) AS quarantined FROM sale_event_evidence e JOIN source_observations o ON o.id=e.observation_id JOIN collector_pages p ON p.observation_id=e.observation_id AND p.source_id=e.source_id JOIN collector_jobs j ON j.id=p.job_id CROSS JOIN LATERAL jsonb_array_elements_text(j.visited_cursors) WITH ORDINALITY AS seq(cursor,position) WHERE p.job_id=$1 AND seq.cursor=p.cursor ORDER BY e.sale_event_id,seq.position DESC",
        [jobId],
      );
      if (rows.rows.some((r) => r.quarantined)) throw new Error("collector_evidence_quarantined");
      if (rows.rows.some((r) => !r.retention_until || r.retention_until <= now))
        throw new Error("source_evidence_expired");
      return rows.rows.map((r) => candidateFromJson(r.candidate));
    });
  }

  /** Enriches same-observation listing record evidence from a verified item detail page without mutating prices or billing. */
  async enrichRecordEvidence(input: {
    sourceId: string;
    jobId: string;
    listingId: string;
    detail: EbayItemDetailEvidence;
  }): Promise<{ updated: number }> {
    if (!/^\d{6,19}$/.test(input.listingId) || input.detail.listingId !== input.listingId)
      throw new Error("detail_listing_id_mismatch");
    return transaction(this.db, async (c) => {
      const { source, now } = await this.readScope(c, input.sourceId);
      const job = (
        await c.query<Job>("SELECT * FROM collector_jobs WHERE id=$1 AND source_id=$2 FOR SHARE", [
          input.jobId,
          input.sourceId,
        ])
      ).rows[0];
      if (!job || job.permission_epoch !== source.permission_epoch)
        throw new Error("source_rights_unavailable");
      const rows = (
        await c.query<{
          sale_event_id: string;
          listing_id: string;
          source_id: string;
          observation_id: string;
          evidence: unknown;
        }>(
          `SELECT e.sale_event_id, e.listing_id, e.source_id, e.observation_id, e.evidence
           FROM listing_record_evidence e
           JOIN collector_pages p ON p.observation_id=e.observation_id AND p.source_id=e.source_id
           JOIN sold_listings l ON l.id=e.listing_id AND l.source_id=e.source_id
           JOIN source_observations o ON o.id=e.observation_id AND o.source_id=e.source_id
           WHERE p.job_id=$1
             AND e.source_id=$2
             AND l.external_listing_id=$3
             AND o.retention_until IS NOT NULL AND o.retention_until>$4
             AND NOT EXISTS(SELECT 1 FROM collector_quarantines q WHERE q.affected_event_id=e.sale_event_id)
           FOR UPDATE OF e`,
          [input.jobId, input.sourceId, input.listingId, now],
        )
      ).rows;
      if (!rows.length) return { updated: 0 };

      for (const row of rows) {
        const existing = recordEvidenceFromJson(row.evidence);
        const mergedAttributes: Record<string, string> = { ...existing.attributes };
        for (const [k, v] of Object.entries(input.detail.attributes)) {
          if (Object.hasOwn(mergedAttributes, k)) {
            if (mergedAttributes[k] !== v) throw new Error("detail_attribute_conflict");
          } else {
            mergedAttributes[k] = v;
          }
        }
        if (Object.keys(mergedAttributes).length > 32) throw new Error("html_attribute_budget_exceeded");

        const existingStandard =
          existing.schema === "soldbench.record-evidence.v2" ? existing.conditionStandard : null;
        const conditionRaw = existing.conditionRaw ?? input.detail.conditionRaw;
        const conditionId = existing.conditionId ?? input.detail.conditionId;
        const conditionStandard = existingStandard ?? input.detail.conditionStandard;
        if (conditionStandard !== null && !isStandardCondition(conditionStandard))
          throw new Error("html_standard_condition_invalid");

        const existingDescription =
          existing.schema === "soldbench.record-evidence.v2" ? existing.description : null;
        const existingDefects = existing.schema === "soldbench.record-evidence.v2" ? existing.defects : null;
        const description = existingDescription ?? input.detail.description;
        const defects = existingDefects ?? input.detail.defects;
        const listingUrl = existing.listingUrl ?? input.detail.canonicalUrl;

        const nextEvidence = recordEvidenceFromJson({
          schema: "soldbench.record-evidence.v2",
          profileHash: existing.profileHash,
          recordIndex: existing.recordIndex,
          listingUrl,
          conditionId,
          conditionRaw,
          conditionStandard,
          description,
          defects,
          priceRaw: existing.priceRaw,
          shippingRaw: existing.shippingRaw,
          soldDateRaw: existing.soldDateRaw,
          sourceTimeZone: existing.sourceTimeZone,
          attributes: mergedAttributes,
          fields: {
            listingUrl: listingUrl ? "present" : "missing",
            condition: conditionRaw || conditionId || conditionStandard ? "present" : "missing",
            price: existing.fields.price,
            shipping: existing.fields.shipping,
            soldDate: existing.fields.soldDate,
            seller: existing.fields.seller,
            primaryImage: existing.fields.primaryImage,
            attributes: Object.keys(mergedAttributes).length ? "present" : "missing",
            description: description ? "present" : "missing",
            defects: defects ? "present" : "missing",
          },
        });
        await c.query(
          "UPDATE listing_record_evidence SET evidence=$5 WHERE sale_event_id=$1 AND listing_id=$2 AND source_id=$3 AND observation_id=$4",
          [
            row.sale_event_id,
            row.listing_id,
            row.source_id,
            row.observation_id,
            JSON.stringify(nextEvidence),
          ],
        );
      }
      return { updated: rows.length };
    });
  }
}
