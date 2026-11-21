import { instant } from "@soldbench/core";
import { transaction } from "@soldbench/db";
import { collectPrimaryImage, type PrivateMediaStore } from "@soldbench/media";
import {
  type CollectorTransport,
  digest,
  type FixturePage,
  type FixtureResponse,
  parseFixturePage,
  TransportReadError,
  uncertainCandidateKey,
} from "./fixture.ts";
import { hasHtmlAccessBlock } from "./html.ts";
import { CollectorIntegrityError } from "./integrity.ts";
import type { CollectorStore, Lease } from "./store.ts";

const mediaMaintenanceBatch = 50;
const dueImageReferences = `SELECT i.id FROM listing_images i JOIN source_observations o
  ON o.source_id=i.source_id AND o.id=i.observation_id
  WHERE i.source_id=$1 AND i.state='available'
    AND (i.retention_until<=$2 OR o.retention_until IS NULL OR o.retention_until<=$2)`;
const revokedImageReferences = "SELECT id FROM listing_images WHERE source_id=$1 AND object_key IS NOT NULL";

class ImageBackoff extends Error {
  constructor(readonly seconds: number) {
    super("image_upstream_rate_limited");
  }
}

/** A fixture-only worker; neither its page nor image transport can access networks. */
export class OfflineCollectorWorker {
  constructor(
    readonly store: CollectorStore,
    readonly transport: CollectorTransport,
    readonly media: PrivateMediaStore,
    readonly limits = { pageBytes: 1024 * 1024, imageBytes: 5 * 1024 * 1024 },
  ) {
    if (!["memory_fixture", "loopback_fixture"].includes(transport.mode))
      throw new Error("network_collector_not_enabled");
  }
  private async response(
    lease: Lease,
    key: string,
    kind: "page" | "image",
    signal?: AbortSignal,
    imageId?: string,
  ) {
    if (signal?.aborted) throw new Error("worker_shutdown");
    await this.store.renew(lease);
    const max = kind === "page" ? this.limits.pageBytes : this.limits.imageBytes;
    const id = await this.store.reserve(lease, kind, max, key, imageId);
    let responseIndex: number;
    try {
      await this.store.check(lease);
      if (signal?.aborted) throw new Error("worker_shutdown");
      responseIndex = await this.store.fixtureResponseIndex(lease, id);
      if (signal?.aborted) throw new Error("worker_shutdown");
    } catch (error) {
      try {
        await this.store.cancelUndispatchedFixture(lease, id);
      } catch {
        /* Stop/revocation has already accounted for the reservation. */
      }
      throw error;
    }
    let response: FixtureResponse;
    try {
      response = await this.transport.read(key, responseIndex, signal);
    } catch (error) {
      await this.store.settle(
        lease,
        id,
        error instanceof TransportReadError ? Math.min(max, error.receivedBytes) : 0,
      );
      throw error;
    }
    const oversized = response.bytes.length > max;
    await this.store.settle(lease, id, Math.min(response.bytes.length, max), digest(response.bytes));
    const html = response.contentType.split(";")[0]?.toLowerCase().trim() === "text/html";
    if (
      [401, 403].includes(response.status) ||
      (html &&
        (this.store.htmlProfile
          ? hasHtmlAccessBlock(response.bytes, this.store.htmlProfile)
          : /captcha|challenge|sign.?in|verify you are human/i.test(
              Buffer.from(response.bytes.subarray(0, 8192)).toString(),
            )))
    ) {
      await this.store.stop(lease.sourceId, "source_access_refused");
      throw new Error("source_access_refused");
    }
    if (oversized) throw new Error("response_exceeds_budget");
    if (response.status === 429) {
      const delay = response.retryAfterSeconds;
      if (typeof delay !== "number" || !Number.isSafeInteger(delay) || delay < 1 || delay > 86400)
        throw new Error("invalid_retry_after");
      await this.store.recordBackoff(lease, delay);
      if (kind === "image" && !lease.imageTaskId) throw new ImageBackoff(delay);
      if (lease.imageTaskId) await this.store.deferImageRetry(lease, "upstream_rate_limited", delay);
      else await this.store.defer(lease, "upstream_rate_limited", delay);
      throw new Error("job_deferred");
    }
    if (response.status !== 200) throw new Error("upstream_unavailable");
    return { response, id };
  }
  private async images(lease: Lease, signal?: AbortSignal) {
    const tasks = await this.store.db.query(
      "SELECT i.id AS image_id,i.listing_id,i.sale_event_id,i.observation_id,e.external_listing_id,e.candidate AS evidence_candidate,p.raw_hash,p.payload FROM listing_images i JOIN collector_pages p ON p.observation_id=i.observation_id AND p.source_id=i.source_id JOIN sale_event_evidence e ON e.sale_event_id=i.sale_event_id AND e.listing_id=i.listing_id AND e.source_id=i.source_id AND e.observation_id=i.observation_id WHERE p.job_id=$1 AND i.state='pending' AND (($2::uuid IS NULL AND NOT EXISTS(SELECT 1 FROM collector_image_jobs q WHERE q.image_id=i.id)) OR EXISTS(SELECT 1 FROM collector_image_jobs q WHERE q.id=$2 AND q.image_id=i.id AND q.status='running')) ORDER BY i.created_at,e.external_listing_id,i.id",
      [lease.jobId, lease.imageTaskId ?? null],
    );
    let mediaBound = false;
    for (const task of tasks.rows) {
      let current: Awaited<ReturnType<CollectorStore["check"]>>;
      try {
        current = await this.store.check(lease);
      } catch (error) {
        if (!lease.imageTaskId && error instanceof Error && error.message === "collector_rate_limited") {
          await this.store.queueImageRetry(lease, task.image_id, "source_cooldown", 30);
          continue;
        }
        throw error;
      }
      const page = parseFixturePage(
        Buffer.from(JSON.stringify(task.payload)),
        {
          sourceId: lease.sourceId,
          queryHash: task.payload.queryHash,
          cursor: task.payload.cursor,
          asOf: (await this.store.view(lease.jobId)).as_of.toISOString(),
        },
        this.store.htmlProfile?.shippingContexts,
      );
      const row = page.records.find(
        (r) =>
          r.listingId === task.external_listing_id &&
          r.primaryImage &&
          (task.evidence_candidate.eventKey !== null
            ? r.candidate.eventKey === task.evidence_candidate.eventKey
            : r.candidate.eventKey === null &&
              uncertainCandidateKey(r) === task.evidence_candidate.observationKey),
      );
      if (!row?.primaryImage) {
        await this.store.failImage(lease, task.image_id, "primary_missing");
        continue;
      }
      let phase: "fetch" | "decode" | "publish" = "fetch";
      try {
        if (!mediaBound) {
          phase = "publish";
          await this.store.bindImageStore(lease, this.media);
          mediaBound = true;
          phase = "fetch";
        }
        const response = await this.response(
          lease,
          `image:${row.primaryImage.url}`,
          "image",
          signal,
          task.image_id,
        );
        const latest = await this.store.check(lease);
        const rights = {
          sourceId: lease.sourceId,
          permissionEpoch: current.epoch,
          mayCopy: true,
          mayDisplay: true,
          expiresAt: current.expiresAt,
        };
        if (latest.epoch !== current.epoch) throw new Error("image_permission_changed");
        phase = "decode";
        const image = await collectPrimaryImage(
          {
            listingId: task.listing_id,
            observationId: task.observation_id,
            saleEventId: task.sale_event_id,
            sourceId: lease.sourceId,
            hosts: this.store.htmlProfile?.imageHosts ?? ["images.example.test"],
            candidates: [
              {
                listingId: task.listing_id,
                observationId: task.observation_id,
                saleEventId: task.sale_event_id,
                role: "primary",
                url: row.primaryImage.url,
              },
            ],
          },
          {
            transport: async () => ({
              status: response.response.status,
              contentType: response.response.contentType,
              bytes: response.response.bytes,
            }),
            currentRights: () => rights,
            now: () => latest.now,
            tripSourceCircuit: async (reason) => this.store.stop(lease.sourceId, reason),
          },
        );
        phase = "publish";
        await this.store.persistImage(lease, task.image_id, image, this.media);
      } catch (error) {
        if (error instanceof ImageBackoff) {
          await this.store.queueImageRetry(lease, task.image_id, "upstream_rate_limited", error.seconds);
          continue;
        }
        if (error instanceof Error && error.message === "job_deferred") throw error;
        // Source rights and lease refusal must never become a harmless missing-photo result.
        await this.store.check(lease);
        const message = error instanceof Error ? error.message : "image_failed";
        if (phase === "publish") {
          if (lease.imageTaskId) await this.store.deferImageRetry(lease, "image_storage_unavailable", 60);
          else await this.store.queueImageRetry(lease, task.image_id, "image_storage_unavailable");
          continue;
        }
        if (
          /^(upstream_unavailable|fixture_response_missing|http_request_failed|http_request_timeout|http_response_interrupted)$/.test(
            message,
          )
        ) {
          if (lease.imageTaskId) await this.store.deferImageRetry(lease, message, 60);
          else await this.store.queueImageRetry(lease, task.image_id, message);
          continue;
        }
        if (["source_budget_policy_unavailable", "source_budget_policy_cap_exceeded"].includes(message)) {
          // Acquisition budget expiry does not withdraw rights to the fully committed page.
          await this.store.failImage(lease, task.image_id, "image_budget_policy_unavailable");
          continue;
        }
        if (message === "collector_job_budget_exhausted") {
          await this.store.failImage(lease, task.image_id, "image_job_budget_exhausted");
          continue;
        }
        if (
          !lease.imageTaskId &&
          [
            "collector_rate_limited",
            "collector_daily_budget_exhausted",
            "collector_budget_day_changed",
          ].includes(message)
        ) {
          const until =
            message === "collector_daily_budget_exhausted"
              ? Math.ceil(
                  (new Date(`${new Date(current.now).toISOString().slice(0, 10)}T00:00:00Z`).getTime() +
                    86400000 -
                    Date.parse(current.now)) /
                    1000,
                )
              : message === "collector_budget_day_changed"
                ? 1
                : 60;
          await this.store.queueImageRetry(
            lease,
            task.image_id,
            message,
            Math.max(1, Math.min(86400, until)),
          );
          continue;
        }
        if (
          /budget|rate_limited|job_deferred|worker_shutdown|permission|lease|source_|network_|config/.test(
            message,
          )
        )
          throw error;
        await this.store.failImage(lease, task.image_id, "image_decode_failed");
      }
    }
  }
  async runOne(
    sourceId: string,
    options: { jobId?: string; maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<{ jobId: string; status: string } | null> {
    if (
      options.maxPages !== undefined &&
      (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 1000)
    )
      throw new Error("invalid_worker_page_limit");
    if (options.signal?.aborted) return null;
    // Rights checks precede acquisition, but photo maintenance is an independent operation.
    await this.store.revokeInvalidClearance(sourceId);
    const lease = await this.store.claim(sourceId, 60, options.jobId);
    if (!lease) return null;
    let processed = 0;
    try {
      for (;;) {
        if (options.signal?.aborted) throw new Error("worker_shutdown");
        const job = await this.store.view(lease.jobId);
        const terminal = await this.store.db.query(
          "SELECT 1 FROM collector_pages WHERE job_id=$1 AND next_cursor IS NULL",
          [job.id],
        );
        if (terminal.rowCount) {
          await this.images(lease, options.signal);
          await this.store.finish(lease);
          return { jobId: job.id, status: "completed" };
        }
        const { response, id } = await this.response(lease, `page:${job.cursor}`, "page", options.signal);
        let page: FixturePage;
        try {
          if (response.contentType.split(";")[0]?.trim().toLowerCase() !== this.store.pageContentType)
            throw new CollectorIntegrityError("page_content_type_invalid");
          try {
            page = this.store.parsePage(response.bytes, {
              sourceId,
              queryHash: job.query_hash,
              cursor: job.cursor,
              asOf: job.as_of.toISOString(),
            });
          } catch {
            throw new CollectorIntegrityError("page_structure_invalid");
          }
          await this.store.commitPage(lease, page, response.bytes, id);
        } catch (error) {
          if (error instanceof CollectorIntegrityError)
            await this.store.quarantinePage(lease, id, response.bytes, error.reason, error.affectedEventId);
          throw error;
        }
        await this.images(lease, options.signal);
        processed++;
        if (options.maxPages !== undefined && processed >= options.maxPages && page.nextCursor !== null) {
          await this.store.defer(lease, "worker_yield", 1, false);
          return { jobId: job.id, status: "retry" };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "collector_failed";
      if (message !== "job_deferred") {
        try {
          await this.store.defer(
            lease,
            message,
            ["worker_shutdown", "collector_budget_day_changed"].includes(message) ? 1 : 60,
            !/fixture_response_missing|upstream_unavailable|http_request_failed|http_request_timeout|http_response_interrupted|collector_rate_limited|collector_budget_day_changed|worker_shutdown/.test(
              message,
            ),
          );
        } catch {
          await this.store.failBlocked(lease, message);
        }
      }
      return { jobId: lease.jobId, status: (await this.store.view(lease.jobId)).status };
    }
  }
  async retryImages(
    sourceId: string,
    options: { parentJobId?: string; maxTasks?: number; signal?: AbortSignal } = {},
  ) {
    const max = options.maxTasks ?? 32;
    if (!Number.isSafeInteger(max) || max < 1 || max > 100) throw new Error("invalid_media_cycle_limit");
    const results: Array<{ taskId: string; status: string }> = [];
    for (let i = 0; i < max; i++) {
      if (options.signal?.aborted) break;
      let lease: Lease | null;
      try {
        lease = await this.store.claimImageRetry(sourceId, options.parentJobId);
      } catch (error) {
        if (
          results.length &&
          error instanceof Error &&
          /^(source_circuit_open|source_inactive)$/.test(error.message)
        )
          break;
        throw error;
      }
      if (!lease?.imageTaskId) break;
      try {
        await this.images(lease, options.signal);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "image_retry_failed";
        if (reason !== "job_deferred") {
          try {
            await this.store.deferImageRetry(
              lease,
              /^[a-z_]+$/.test(reason) ? reason : "image_retry_failed",
              reason === "worker_shutdown" ? 1 : 60,
            );
          } catch {
            /* Revocation/stop/lease takeover has already closed or owns the task. */
          }
        }
      }
      const task = (
        await this.store.db.query("SELECT status FROM collector_image_jobs WHERE id=$1", [lease.imageTaskId])
      ).rows[0];
      results.push({ taskId: lease.imageTaskId, status: task?.status ?? "unavailable" });
    }
    return results;
  }
  /** Internal worker read only, NOT a substitute for customer owner authorization. */
  async readImageInternal(id: string): Promise<Buffer> {
    return transaction(this.store.db, async (c) => {
      const ref = (await c.query("SELECT source_id FROM listing_images WHERE id=$1", [id])).rows[0];
      if (!ref) throw new Error("image_unavailable");
      const first = await this.store.readScope(c, ref.source_id);
      const row = (
        await c.query(
          "SELECT i.*,o.retention_until AS evidence_expires,EXISTS(SELECT 1 FROM collector_quarantines q WHERE q.affected_event_id=i.sale_event_id) AS quarantined FROM listing_images i JOIN source_observations o ON o.id=i.observation_id WHERE i.id=$1 FOR SHARE OF i",
          [id],
        )
      ).rows[0];
      const valid = (now: Date) =>
        row?.state === "available" &&
        row.permission_epoch === first.source.permission_epoch &&
        row.retention_until &&
        row.retention_until > now &&
        row.evidence_expires &&
        row.evidence_expires > now &&
        !row.quarantined &&
        row.object_key;
      if (!valid(first.now)) throw new Error("image_unavailable");
      const bytes = await this.media.get(row.object_key, first.source.media_store_identity ?? undefined),
        after = await this.store.readScope(c, ref.source_id);
      if (!valid(after.now)) throw new Error("image_unavailable");
      return bytes;
    }).catch((error) => {
      if (error instanceof Error && error.message === "source_rights_unavailable")
        throw new Error("image_unavailable");
      throw error;
    });
  }

  private async purgeStoppedImages(sourceId: string) {
    // Persist proven legacy ownership before touching bytes. A partial delete must not undo the proof.
    await transaction(this.store.db, (c) => this.store.matchMediaStore(c, sourceId, this.media));
    return transaction(this.store.db, async (c) => {
      const source = (
        await c.query("SELECT status,media_store_identity FROM sources WHERE id=$1 FOR UPDATE", [sourceId])
      ).rows[0];
      if (source?.status !== "revoked") return null;
      const identity = await this.media.storageIdentity();
      if (source.media_store_identity) {
        if (source.media_store_identity !== identity) return null;
      } else {
        const history = (
          await c.query(
            `SELECT EXISTS(SELECT 1 FROM listing_images WHERE source_id=$1 AND object_key IS NOT NULL) AS has_references,
             EXISTS(SELECT 1 FROM collector_dispatches WHERE source_id=$1 AND kind='image') AS may_have_written`,
            [sourceId],
          )
        ).rows[0];
        if (history.has_references) return null;
        if (history.may_have_written) {
          // Remove any local orphans without declaring all former roots empty.
          const more = identity
            ? await this.media.purgeNamespace(sourceId, identity, mediaMaintenanceBatch)
            : false;
          return { processed: 0, pending: more, matched: false };
        }
      }
      if (identity) {
        const more = await this.media.purgeNamespace(sourceId, identity, mediaMaintenanceBatch);
        if (identity !== (await this.media.storageIdentity())) throw new Error("media_store_mismatch");
        if (more) return { processed: 0, pending: true, matched: true };
      }
      const cleared = await c.query(
        `WITH batch AS (${revokedImageReferences} ORDER BY id LIMIT $2)
         UPDATE listing_images i SET state='revoked',object_key=NULL FROM batch WHERE i.id=batch.id`,
        [sourceId, mediaMaintenanceBatch],
      );
      if (
        cleared.rowCount === mediaMaintenanceBatch &&
        (await c.query(`${revokedImageReferences} LIMIT 1`, [sourceId])).rowCount
      )
        return { processed: 0, pending: true, matched: true };
      await c.query("UPDATE listing_images SET state='revoked' WHERE source_id=$1 AND state<>'revoked'", [
        sourceId,
      ]);
      const processed = await c.query(
        "UPDATE outbox SET processed_at=clock_timestamp() WHERE kind='collector.media_cleanup' AND processed_at IS NULL AND payload->>'sourceId'=$1",
        [sourceId],
      );
      return { processed: processed.rowCount ?? 0, pending: false, matched: true };
    });
  }
  async drainMediaCleanup() {
    const identity = await this.media.storageIdentity();
    if (!identity) return 0;
    const sources = await this.store.db.query(
      `SELECT s.id FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id
       WHERE s.access_method='offline_fixture' AND x.provider='synthetic_fixture'
         AND s.status='revoked' AND (s.media_store_identity=$1 OR s.media_store_identity IS NULL)
         AND EXISTS(SELECT 1 FROM outbox WHERE kind='collector.media_cleanup' AND processed_at IS NULL AND payload->>'sourceId'=s.id::text)
       ORDER BY s.media_store_identity NULLS LAST,s.id LIMIT 100`,
      [identity],
    );
    let processed = 0;
    for (const source of sources.rows)
      processed += (await this.purgeStoppedImages(source.id))?.processed ?? 0;
    return processed;
  }
  async runMaintenance(sourceId: string) {
    const state = (
      await this.store.db.query(
        "SELECT s.status,s.access_method,x.provider,x.status AS clearance_status,x.effective_at,x.expires_at FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1",
        [sourceId],
      )
    ).rows[0];
    if (state?.access_method !== "offline_fixture") throw new Error("network_collector_not_enabled");
    if (state.provider !== "synthetic_fixture") throw new Error("network_collector_not_enabled");
    const inspectedNow = this.store.clock
      ? new Date(instant(this.store.clock()))
      : ((await this.store.db.query("SELECT clock_timestamp() t")).rows[0].t as Date);
    if (
      state.status === "active" &&
      (!["draft", "reviewed", "active"].includes(state.clearance_status) ||
        (state.effective_at && state.effective_at > inspectedNow) ||
        (state.expires_at && state.expires_at <= inspectedNow))
    ) {
      if (await this.store.revokeInvalidClearance(sourceId)) state.status = "revoked";
    }
    if (state.status === "revoked") {
      const cleanup = await this.purgeStoppedImages(sourceId);
      return {
        expired: 0,
        expirationPending: false,
        revocationPending: cleanup?.pending ?? false,
        orphans: 0,
        cleanupProcessed: cleanup?.processed ?? 0,
        mediaStoreMatched: cleanup?.matched ?? false,
      };
    }
    if (
      state.status !== "active" ||
      !(await transaction(this.store.db, (c) => this.store.matchMediaStore(c, sourceId, this.media)))
    )
      return {
        expired: 0,
        expirationPending: false,
        revocationPending: false,
        orphans: 0,
        cleanupProcessed: 0,
        mediaStoreMatched: false,
      };
    return transaction(this.store.db, async (c) => {
      const source = (
        await c.query(
          "SELECT s.status,s.media_store_identity,x.retention_days FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 FOR UPDATE OF s",
          [sourceId],
        )
      ).rows[0];
      const identity = source?.media_store_identity;
      if (source?.status !== "active" || !identity || identity !== (await this.media.storageIdentity()))
        return {
          expired: 0,
          expirationPending: false,
          revocationPending: false,
          orphans: 0,
          cleanupProcessed: 0,
          mediaStoreMatched: false,
        };
      const now = this.store.clock
        ? new Date(instant(this.store.clock()))
        : (await c.query("SELECT clock_timestamp() t")).rows[0].t;
      const expired = await c.query(
        `WITH due AS (${dueImageReferences} ORDER BY i.retention_until,i.id LIMIT $3)
         UPDATE listing_images i SET state='expired' FROM due WHERE i.id=due.id`,
        [sourceId, now, mediaMaintenanceBatch],
      );
      const keys = await c.query(
        `WITH batch AS (
           SELECT DISTINCT object_key FROM listing_images
           WHERE source_id=$1 AND state='expired' AND object_key IS NOT NULL ORDER BY object_key LIMIT $3
         )
         SELECT batch.object_key,EXISTS(
           SELECT 1 FROM listing_images i JOIN source_observations o
             ON o.source_id=i.source_id AND o.id=i.observation_id
           WHERE i.source_id=$1 AND i.object_key=batch.object_key AND i.state='available'
             AND i.retention_until>$2 AND o.retention_until>$2
         ) AS retained FROM batch`,
        [sourceId, now, mediaMaintenanceBatch],
      );
      for (const { object_key: key, retained } of keys.rows) {
        if (!retained) await this.media.remove(key, identity);
      }
      if (keys.rowCount)
        await c.query(
          "UPDATE listing_images SET object_key=NULL WHERE source_id=$1 AND object_key=ANY($2::text[]) AND state='expired'",
          [sourceId, keys.rows.map((row) => row.object_key)],
        );
      const {
        rows: [{ pending }],
      } = await c.query(
        `SELECT EXISTS(${dueImageReferences}) OR EXISTS(
           SELECT 1 FROM listing_images WHERE source_id=$1 AND state='expired' AND object_key IS NOT NULL
         ) AS pending`,
        [sourceId, now],
      );
      let orphans = 0;
      if (!pending && source.retention_days) {
        const refs = await c.query(
          "SELECT object_key FROM listing_images WHERE source_id=$1 AND object_key IS NOT NULL",
          [sourceId],
        );
        orphans = await this.media.sweepUnreferenced(
          sourceId,
          new Set<string>(refs.rows.map((row) => row.object_key)),
          new Date(now.getTime() - source.retention_days * 86400000),
          identity,
        );
      }
      if (identity !== (await this.media.storageIdentity())) throw new Error("media_store_mismatch");
      return {
        expired: expired.rowCount ?? 0,
        expirationPending: pending,
        revocationPending: false,
        orphans,
        cleanupProcessed: 0,
        mediaStoreMatched: true,
      };
    });
  }
}
