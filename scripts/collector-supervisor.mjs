import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CollectorRefresh,
  CollectorStore,
  collectorHealth,
  FixtureTransport,
  OfflineCollectorWorker,
} from "@soldbench/collector";
import { database, isDatabaseConnectionError, prepareDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { isSourceKindAllowedForMode, loadConfig } from "@soldbench/shared";
import { fixtureJobId, readRefreshProfile } from "./collector-fixture-file.mjs";
import { createFixtureIntakeScanner } from "./collector-intake.mjs";
import { launchCollector } from "./collector-launcher.mjs";
import { localDatabaseUrl } from "./local-db.mjs";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

const lockNamespace = "soldbench.offline-collector-supervisor";
const candidatesPerLane = 64;
const dispatchPerLane = 4;
const healthPollMs = 60000;
const spoolErrors = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EROFS",
  "ESTALE",
  "ELOOP",
  "fixture_spool_not_directory",
]);

async function availableArtifact(directory, jobId) {
  const entries = await Promise.all(
    ["collector-fixture", "collector-html-fixture"].map(async (kind) => {
      const path = join(directory, `${kind}-${jobId}.json`);
      const stat = await lstat(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return stat ? { path, regular: stat.isFile() } : null;
    }),
  );
  // Two names or a symlink remain ambiguous even when one candidate is valid.
  const present = entries.filter(Boolean);
  return present.length === 1 && present[0].regular ? present[0].path : null;
}

async function sourceState(db, sourceId, dataMode = "offline_fixture") {
  const { rows } = await db.query(
    `SELECT s.status,s.access_method,p.provider,
       CASE WHEN s.status<>'active' THEN 'source_inactive'
        WHEN (CASE WHEN $2='approved_network' THEN p.status<>'active' ELSE p.status NOT IN ('draft','reviewed','active') END)
          OR p.effective_at>now() OR p.expires_at<=now()
          THEN 'source_clearance_unavailable'
        WHEN EXISTS(SELECT 1 FROM collector_circuits k WHERE k.source_id=s.id AND k.category_key='*' AND k.status<>'closed')
          THEN 'source_circuit_open'
        WHEN s.retry_after_until>now() THEN 'source_backoff'
        WHEN s.daily_budget_policy_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collector_daily_budget_policies b
          WHERE b.source_id=s.id AND b.policy_hash=s.daily_budget_policy_hash AND b.valid_from<=now() AND b.valid_until>now())
          THEN 'source_budget_policy_unavailable'
        ELSE 'ready' END dispatch_state
     FROM sources s JOIN source_clearances p ON p.id=s.source_clearance_id WHERE s.id=$1`,
    [sourceId, dataMode],
  );
  const source = rows[0];
  if (!source || !isSourceKindAllowedForMode(dataMode, source))
    throw new Error("network_collector_not_enabled");
  return source.dispatch_state;
}

async function dueJobs(db, sourceId, cursors) {
  return (
    await db.query(
      `WITH ready AS MATERIALIZED (
        SELECT 'pages' AS lane,j.id,j.available_at FROM collector_jobs j WHERE j.source_id=$1
         AND (j.status IN ('queued','retry') OR (j.status='running' AND j.lease_until<=now()))
         AND j.available_at<=now()
        UNION ALL
        SELECT 'images',t.parent_job_id,min(t.available_at) FROM collector_image_jobs t
         JOIN collector_jobs j ON j.id=t.parent_job_id WHERE t.source_id=$1
          AND ((t.status='retry' AND (t.available_at<=now() OR t.expires_at<=now())) OR (t.status='running' AND t.lease_until<=now()))
          AND (t.expires_at<=now() OR j.status IN ('completed','failed','cancelled','expired'))
         GROUP BY t.parent_job_id
        UNION ALL
        SELECT 'details',q.parent_job_id,min(q.available_at) FROM collector_detail_jobs q
         JOIN collector_jobs j ON j.id=q.parent_job_id WHERE q.source_id=$1
          AND (
            (q.status IN ('queued','retry') AND (q.available_at<=now() OR q.expires_at<=now()))
            OR (q.status='running' AND q.lease_until<=now())
          )
          AND (q.expires_at<=now() OR j.status IN ('completed','failed','cancelled','expired'))
         GROUP BY q.parent_job_id
      ), lanes(lane,after_at,after_id) AS (VALUES
        ('pages',$2::timestamptz,$3::uuid), ('images',$4::timestamptz,$5::uuid), ('details',$6::timestamptz,$7::uuid)
      ) SELECT l.lane,(SELECT count(*)::int FROM ready r WHERE r.lane=l.lane) AS due,
         ARRAY(SELECT jsonb_build_object('id',r.id,'availableAt',r.available_at::text) FROM ready r WHERE r.lane=l.lane
           ORDER BY CASE WHEN l.after_at IS NULL OR (r.available_at,r.id)>(l.after_at,l.after_id) THEN 0 ELSE 1 END,
                    r.available_at,r.id LIMIT $8) AS candidates
       FROM lanes l ORDER BY l.lane DESC`,
      [
        sourceId,
        ...["pages", "images", "details"].flatMap((lane) => [
          cursors[lane]?.availableAt ?? null,
          cursors[lane]?.id ?? null,
        ]),
        candidatesPerLane,
      ],
    )
  ).rows;
}

async function refreshHealthReport(lock, db, sourceId, state, dataMode = "offline_fixture") {
  if (state === "source_inactive" || state === "source_clearance_unavailable") return "unavailable";
  const {
    rows: [row],
  } = await lock.query(
    `SELECT EXISTS(
       SELECT 1 FROM collector_health_snapshots h JOIN sources s ON s.id=h.source_id
       WHERE h.source_id=$1 AND h.captured_at>now()-interval '15 minutes' AND h.captured_at<=now()
         AND h.metrics->>'schema'='soldbench.collector-health.v1'
         AND h.metrics->>'mode'=$2 AND h.metrics->>'clock'='database'
         AND h.metrics->'onlineVerified'=$3::jsonb
         AND h.metrics->>'permissionEpoch'=s.permission_epoch::text
     ) recent`,
    [sourceId, dataMode, JSON.stringify(dataMode === "approved_network")],
  );
  if (row.recent) return "recent";
  await collectorHealth(db, sourceId, { persist: true, automatic: true, dataMode });
  return "recorded";
}

const envelope = (sourceId, dataMode = "offline_fixture") => ({
  kind: "collector_supervision_cycle",
  mode: dataMode,
  onlineVerified: dataMode === "approved_network",
  externalNetworkRequests: 0,
  sourceId,
});

function maintenanceStatus(maintenance) {
  if (!maintenance) return null;
  if (maintenance.error) return "failed";
  if (maintenance.expirationPending || maintenance.revocationPending) return "backlog_pending";
  if (!maintenance.mediaStoreMatched) return "store_unmatched";
  if (
    (maintenance.expired ?? 0) > 0 ||
    (maintenance.orphans ?? 0) > 0 ||
    (maintenance.cleanupProcessed ?? 0) > 0
  )
    return "processed";
  return "idle";
}

async function recordProgress(
  lock,
  sourceId,
  phase,
  {
    expectedMs = null,
    jobId = null,
    lane = null,
    summary = null,
    healthReport = null,
    mediaMaintenance = null,
  } = {},
) {
  await lock.query(
    `WITH clock AS (SELECT clock_timestamp() AS t)
     INSERT INTO collector_supervisor_state(source_id,phase,checked_at,expected_progress_at,last_cycle_at,job_id,lane,cycle_summary)
     SELECT $1,$2,t,t+$3::int*interval '1 millisecond',CASE WHEN $6::jsonb IS NOT NULL THEN t END,$4,$5,
       CASE WHEN $6::jsonb IS NOT NULL THEN
         $6::jsonb
         || CASE WHEN $7::text IS NOT NULL
              THEN jsonb_build_object('healthReport',jsonb_build_object('status',$7::text,'checkedAt',t))
              ELSE '{}'::jsonb END
         || CASE WHEN $8::text IS NOT NULL
              THEN jsonb_build_object('mediaMaintenance',jsonb_build_object('status',$8::text,'checkedAt',t))
              ELSE '{}'::jsonb END
       END
     FROM clock
     ON CONFLICT(source_id) DO UPDATE SET phase=excluded.phase,checked_at=excluded.checked_at,
       expected_progress_at=excluded.expected_progress_at,job_id=excluded.job_id,lane=excluded.lane,
       last_cycle_at=coalesce(excluded.last_cycle_at,collector_supervisor_state.last_cycle_at),
       cycle_summary=CASE WHEN excluded.cycle_summary IS NULL THEN collector_supervisor_state.cycle_summary
         ELSE jsonb_strip_nulls(jsonb_build_object(
                'healthReport',collector_supervisor_state.cycle_summary->'healthReport',
                'mediaMaintenance',collector_supervisor_state.cycle_summary->'mediaMaintenance'
              )) || excluded.cycle_summary END`,
    [
      sourceId,
      phase,
      expectedMs,
      jobId,
      lane,
      summary ? JSON.stringify(summary) : null,
      healthReport,
      mediaMaintenance,
    ],
  );
}

async function run(args) {
  const options = new Map();
  const profilePaths = [];
  for (const arg of args) {
    const entry =
      /^--(source|spool|watch|refresh|refresh-profile|refresh-include-json|interval-ms|max-ms)=(.+)$/.exec(
        arg,
      );
    if (!entry || options.has(entry[1])) throw new Error("invalid_collector_supervisor_argument");
    if (entry[1] === "refresh-profile") profilePaths.push(resolve(entry[2]));
    else options.set(entry[1], entry[2]);
  }
  const sourceId = options.get("source"),
    watch = options.get("watch"),
    refreshEnabled = options.get("refresh"),
    refreshJson = options.get("refresh-include-json"),
    interval = Number(options.get("interval-ms") ?? 2000),
    maxMs = Number(options.get("max-ms") ?? 60000);
  if (
    !fixtureJobId.test(sourceId ?? "") ||
    [watch, refreshEnabled, refreshJson].some((flag) => flag !== undefined && flag !== "true") ||
    ((profilePaths.length || refreshJson) && !refreshEnabled)
  )
    throw new Error("invalid_collector_supervisor_argument");
  if (
    !/^\d+$/.test(options.get("interval-ms") ?? "2000") ||
    interval < 250 ||
    interval > 60000 ||
    !/^\d+$/.test(options.get("max-ms") ?? "60000") ||
    maxMs < 100 ||
    maxMs > 60000
  )
    throw new Error("invalid_collector_supervisor_limit");
  const config = loadConfig(process.env),
    url = config.databaseUrl ?? localDatabaseUrl(),
    spool = resolve(options.get("spool") ?? process.env.COLLECTOR_DEMO_DIR ?? ".local");
  assertAllowedDatabaseUrl(config, url);
  if (profilePaths.length + Number(Boolean(refreshJson)) > 8)
    throw new Error("collector_supervisor_profile_limit");
  const profiles = await Promise.all(profilePaths.map(readRefreshProfile));
  const db = database(url),
    abort = new AbortController(),
    stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const wait = (milliseconds, signal = abort.signal) =>
    delay(milliseconds, undefined, { signal }).catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
  const env = { ...process.env, DATABASE_URL: url, COLLECTOR_DEMO_DIR: spool };
  const store = new CollectorStore(db, undefined, { dataMode: config.dataMode });
  const refresh = refreshEnabled ? new CollectorRefresh(store) : null;
  const profileStores = profiles.map(
    (htmlProfile) => new CollectorStore(db, undefined, { htmlProfile, dataMode: config.dataMode }),
  );
  if (new Set(profileStores.map(({ profileHash }) => profileHash)).size !== profiles.length)
    throw new Error("collector_supervisor_duplicate_profile");
  const profileRefreshers = profileStores.map((profileStore) => new CollectorRefresh(profileStore));
  if (refresh && (!profiles.length || refreshJson)) profileRefreshers.unshift(refresh);
  const maintenanceWorker = new OfflineCollectorWorker(
    store,
    new FixtureTransport(new Map()),
    new PrivateMediaStore(resolve(config.mediaRoot)),
  );
  let retryDelay = 0;
  async function supervise() {
    await prepareDatabase(db, config.databaseStartup);
    if (abort.signal.aborted) return;
    await sourceState(db, sourceId, config.dataMode);
    if (abort.signal.aborted) return;
    const lock = await db.connect();
    const ownership = new AbortController();
    const signal = AbortSignal.any([abort.signal, ownership.signal]);
    const onLockError = (error) => ownership.abort(error);
    const onLockEnd = () => ownership.abort(new Error("Connection terminated unexpectedly"));
    const intakeScanner = createFixtureIntakeScanner(db, spool, sourceId, 10000, config.dataMode);
    lock.on("error", onLockError);
    lock.on("end", onLockEnd);
    let owned = false;
    try {
      const bound = await lock.query("SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) locked", [
        lockNamespace,
        sourceId,
      ]);
      if (!bound.rows[0].locked) {
        console.log(JSON.stringify({ ...envelope(sourceId, config.dataMode), state: "already_supervised" }));
        return;
      }
      owned = true;
      if (retryDelay) {
        console.info("soldbench_collector_supervisor_database_recovered");
        retryDelay = 0;
      }
      const deferred = new Map();
      const cursors = {};
      let nextMaintenance = 0;
      let nextHealthCheck = 0;
      let nextProfile = 0;
      while (!signal.aborted) {
        await recordProgress(lock, sourceId, "scanning", { expectedMs: 30000 });
        const now = performance.now();
        const settled = await store.settleUnclaimable(sourceId);
        let maintenance = null;
        if (Date.now() >= nextMaintenance) {
          try {
            maintenance = await maintenanceWorker.runMaintenance(sourceId);
          } catch (error) {
            if (isDatabaseConnectionError(error)) throw error;
            maintenance = { error: "media_maintenance_failed" };
          }
          const maintenancePending = maintenance?.expirationPending || maintenance?.revocationPending;
          nextMaintenance = Date.now() + (maintenancePending ? 1000 : 60000);
        }
        let state = await sourceState(db, sourceId, config.dataMode);
        const scheduled = refresh
          ? {
              ...(await refresh.materialize(sourceId, 200)),
              missed: await refresh.settleOverdue(sourceId),
              enqueued: 0,
              recovered: 0,
              blocked: 0,
              prioritized: 0,
            }
          : null;
        if (scheduled && state === "ready") {
          const empty = new Set();
          let dispatched = 0;
          while (dispatched < 8 && empty.size < profileRefreshers.length && !signal.aborted) {
            const index = nextProfile;
            nextProfile = (nextProfile + 1) % profileRefreshers.length;
            if (empty.has(index)) continue;
            const current = profileRefreshers[index];
            if (scheduled.more) scheduled.prioritized += await current.materializeNextAvailable(sourceId);
            const slot = await current.dispatchNext(sourceId, { preferAvailable: true });
            if (!slot) {
              empty.add(index);
              continue;
            }
            dispatched++;
            if (slot.recovered) scheduled.recovered++;
            else if (slot.status === "enqueued") scheduled.enqueued++;
            else scheduled.blocked++;
          }
        }
        if (signal.aborted) break;
        let intake = null;
        let spoolState = "ready";
        const rows = await dueJobs(db, sourceId, cursors);
        for (const [id, until] of deferred) if (until <= now) deferred.delete(id);
        const lanes = new Map();
        try {
          if (!(await lstat(spool)).isDirectory()) throw new Error("fixture_spool_not_directory");
          if (state === "ready") intake = await intakeScanner.resume(signal);
          for (const row of rows) {
            let withArtifact = 0;
            let deferredCount = 0;
            const jobs = [];
            const paths = await Promise.all(
              row.candidates.map((candidate) => availableArtifact(spool, candidate.id)),
            );
            for (const [index, candidate] of row.candidates.entries()) {
              const path = paths[index];
              if (!path) continue;
              withArtifact++;
              if (deferred.has(candidate.id)) deferredCount++;
              else if (jobs.length < dispatchPerLane) jobs.push({ ...candidate, path });
            }
            const scanned = row.candidates.length;
            lanes.set(row.lane, {
              jobs,
              counts: {
                due: row.due,
                scanned,
                uninspected: row.due - scanned,
                withArtifact,
                artifactUnavailable: scanned - withArtifact,
                deferred: deferredCount,
              },
            });
          }
        } catch (error) {
          if (!watch || !spoolErrors.has(error.code ?? error.message)) throw error;
          spoolState = "unavailable";
          lanes.clear();
        }
        const cycles = [];
        for (const [lane, { jobs }] of lanes) {
          for (const { id: jobId, path } of jobs) {
            if (state !== "ready" || signal.aborted) break;
            await recordProgress(lock, sourceId, "dispatching", { expectedMs: maxMs + 5000, jobId, lane });
            const result = await launchCollector(
              [
                `--fixture=${path}`,
                `--expected-job=${jobId}`,
                `--max-ms=${maxMs}`,
                ...(lane === "images"
                  ? ["--media-only=true"]
                  : lane === "details"
                    ? ["--detail-only=true"]
                    : []),
              ],
              env,
              signal,
            );
            if (signal.aborted) {
              if (ownership.signal.aborted)
                console.error(
                  JSON.stringify({
                    kind: "collector_supervised_child_stopped",
                    sourceId,
                    jobId,
                    workerPid: result.report.workerPid,
                    workerExited: result.report.workerExited,
                  }),
                );
              break;
            }
            const cycle = result.report.cycle;
            if (!cycle?.claimed) deferred.set(jobId, performance.now() + (cycle ? 5000 : 30000));
            cycles.push({
              jobId,
              lane: lane,
              status: cycle?.status ?? null,
              claimed: cycle?.claimed ?? false,
              exitCode: result.exitCode,
              timedOut: result.report.timedOut,
              mediaResults: cycle?.mediaResults ?? [],
              detailResults: cycle?.detailResults ?? [],
            });
            state = await sourceState(db, sourceId, config.dataMode);
          }
        }
        if (signal.aborted) break;
        let healthReport = null;
        if (watch && performance.now() >= nextHealthCheck) {
          try {
            healthReport = await refreshHealthReport(lock, db, sourceId, state, config.dataMode);
          } catch (error) {
            if (isDatabaseConnectionError(error)) throw error;
            healthReport = "failed";
          }
          nextHealthCheck = performance.now() + healthPollMs;
        }
        if (signal.aborted) break;
        const queues = {};
        for (const { lane, due, candidates } of rows) {
          const inspected = lanes.get(lane);
          queues[lane] = inspected?.counts ?? {
            due,
            scanned: 0,
            uninspected: due,
            withArtifact: 0,
            artifactUnavailable: 0,
            deferred: 0,
          };
          if (inspected)
            cursors[lane] =
              inspected.jobs.length === dispatchPerLane ? inspected.jobs.at(-1) : candidates.at(-1);
        }
        const summary = {
          state: state === "ready" && spoolState !== "ready" ? "spool_unavailable" : state,
          spool: spoolState,
          settled,
          intake,
          ...(scheduled && { scheduled }),
          queues,
        };
        await recordProgress(lock, sourceId, "waiting", {
          expectedMs: interval + 5000,
          summary,
          healthReport,
          mediaMaintenance: maintenanceStatus(maintenance),
        });
        console.log(
          JSON.stringify({
            ...envelope(sourceId, config.dataMode),
            ...summary,
            maintenance,
            healthReport,
            cycles,
          }),
        );
        if (!watch) break;
        await wait(interval, signal);
      }
      if (!abort.signal.aborted) ownership.signal.throwIfAborted();
    } finally {
      if (owned && !ownership.signal.aborted && (abort.signal.aborted || !watch)) {
        try {
          await recordProgress(lock, sourceId, "stopped");
        } catch {
          console.error("soldbench_collector_supervisor_stop_state_unavailable");
        }
      }
      // End ownership with the dedicated connection, including on a broken session.
      lock.release(true);
      lock.removeListener("error", onLockError);
      lock.removeListener("end", onLockEnd);
      await intakeScanner.close();
    }
  }
  try {
    while (!abort.signal.aborted) {
      try {
        await supervise();
        break;
      } catch (error) {
        if (abort.signal.aborted) break;
        if (!watch || !isDatabaseConnectionError(error)) throw error;
        if (!retryDelay) console.error("soldbench_collector_supervisor_database_unavailable");
        retryDelay = retryDelay ? Math.min(10000, retryDelay * 2) : 1000;
        await wait(retryDelay);
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await db.end();
  }
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  const reason =
    error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "collector_supervisor_failed";
  const modeLabel =
    process.env.SOLDBENCH_LIVE_GATE_ACKNOWLEDGED === "true" && process.env.DATA_MODE === "approved_network"
      ? "approved_network"
      : "offline_fixture";
  console.error(
    JSON.stringify({ error: reason, mode: modeLabel, onlineVerified: modeLabel === "approved_network" }),
  );
  process.exitCode = 1;
}
