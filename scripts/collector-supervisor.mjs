import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CollectorStore, FixtureTransport, OfflineCollectorWorker } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, isDatabaseConnectionError, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { fixtureJobId } from "./collector-fixture-file.mjs";
import { resumeFixtureIntake } from "./collector-intake.mjs";
import { launchCollector } from "./collector-launcher.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const lockNamespace = "soldbench.offline-collector-supervisor";
const maxArtifactEntries = 10000;

async function availableArtifacts(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error("fixture_spool_not_directory");
  const paths = new Map();
  let inspected = 0;
  for await (const file of await opendir(directory)) {
    if (++inspected > maxArtifactEntries) throw new Error("fixture_spool_entry_limit_exceeded");
    const id = /^collector-(?:html-)?fixture-(.+)\.json$/.exec(file.name)?.[1];
    if (!fixtureJobId.test(id ?? "")) continue;
    // A second name or a symlink is ambiguous. Leave the affected job unclaimed.
    paths.set(id, !paths.has(id) && file.isFile() ? join(directory, file.name) : null);
  }
  return new Map([...paths].filter(([, file]) => file !== null));
}

async function sourceState(db, sourceId) {
  const { rows } = await db.query(
    `SELECT s.status,s.access_method,p.provider,
       CASE WHEN s.status<>'active' THEN 'source_inactive'
        WHEN p.status NOT IN ('draft','reviewed','active') OR p.effective_at>now() OR p.expires_at<=now()
          THEN 'source_clearance_unavailable'
        WHEN EXISTS(SELECT 1 FROM collector_circuits k WHERE k.source_id=s.id AND k.category_key='*' AND k.status<>'closed')
          THEN 'source_circuit_open'
        WHEN s.retry_after_until>now() THEN 'source_backoff'
        WHEN s.daily_budget_policy_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collector_daily_budget_policies b
          WHERE b.source_id=s.id AND b.policy_hash=s.daily_budget_policy_hash AND b.valid_from<=now() AND b.valid_until>now())
          THEN 'source_budget_policy_unavailable'
        ELSE 'ready' END dispatch_state
     FROM sources s JOIN source_clearances p ON p.id=s.source_clearance_id WHERE s.id=$1`,
    [sourceId],
  );
  const source = rows[0];
  if (source?.access_method !== "offline_fixture" || source.provider !== "synthetic_fixture")
    throw new Error("network_collector_not_enabled");
  return source.dispatch_state;
}

async function dueJobs(db, sourceId, paths, deferred) {
  return (
    await db.query(
      `WITH ready AS (
        SELECT 'pages' AS lane,j.id,j.available_at FROM collector_jobs j WHERE j.source_id=$1
         AND (j.status IN ('queued','retry') OR (j.status='running' AND j.lease_until<=now()))
         AND j.available_at<=now()
        UNION ALL
        SELECT 'images',t.parent_job_id,min(t.available_at) FROM collector_image_jobs t
         JOIN collector_jobs j ON j.id=t.parent_job_id WHERE t.source_id=$1
          AND ((t.status='retry' AND (t.available_at<=now() OR t.expires_at<=now())) OR (t.status='running' AND t.lease_until<=now()))
          AND (t.expires_at<=now() OR j.status IN ('completed','failed','cancelled','expired'))
         GROUP BY t.parent_job_id
      ) SELECT lane,count(*)::int AS due,count(*) FILTER(WHERE id=ANY($2::uuid[]))::int AS backed,
         count(*) FILTER(WHERE id=ANY($2::uuid[]) AND id=ANY($3::uuid[]))::int AS deferred,
         coalesce((array_agg(id ORDER BY available_at,id) FILTER(WHERE id=ANY($2::uuid[]) AND NOT id=ANY($3::uuid[])))[1:4],'{}'::uuid[]) AS jobs
       FROM ready GROUP BY lane ORDER BY lane DESC`,
      [sourceId, [...paths.keys()], [...deferred.keys()]],
    )
  ).rows;
}

const envelope = (sourceId) => ({
  kind: "collector_supervision_cycle",
  mode: "offline_fixture",
  onlineVerified: false,
  externalNetworkRequests: 0,
  sourceId,
});

async function run(args) {
  const options = new Map();
  for (const arg of args) {
    const entry = /^--(source|spool|watch|interval-ms|max-ms)=(.+)$/.exec(arg);
    if (!entry || options.has(entry[1])) throw new Error("invalid_collector_supervisor_argument");
    options.set(entry[1], entry[2]);
  }
  const sourceId = options.get("source"),
    watch = options.get("watch"),
    interval = Number(options.get("interval-ms") ?? 2000),
    maxMs = Number(options.get("max-ms") ?? 60000);
  if (!fixtureJobId.test(sourceId ?? "") || (watch !== undefined && watch !== "true"))
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
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
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
  const maintenanceWorker = new OfflineCollectorWorker(
    new CollectorStore(db),
    new FixtureTransport(new Map()),
    new PrivateMediaStore(resolve(config.mediaRoot)),
  );
  let retryDelay = 0;
  async function supervise() {
    await migrate(db);
    if (abort.signal.aborted) return;
    await sourceState(db, sourceId);
    if (abort.signal.aborted) return;
    const lock = await db.connect();
    const ownership = new AbortController();
    const signal = AbortSignal.any([abort.signal, ownership.signal]);
    const onLockError = (error) => ownership.abort(error);
    const onLockEnd = () => ownership.abort(new Error("Connection terminated unexpectedly"));
    lock.on("error", onLockError);
    lock.on("end", onLockEnd);
    try {
      const bound = await lock.query("SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) locked", [
        lockNamespace,
        sourceId,
      ]);
      if (!bound.rows[0].locked) {
        console.log(JSON.stringify({ ...envelope(sourceId), state: "already_supervised" }));
        return;
      }
      if (retryDelay) {
        console.info("soldbench_collector_supervisor_database_recovered");
        retryDelay = 0;
      }
      const deferred = new Map(),
        pendingDeferred = new Map();
      let nextMaintenance = 0;
      while (!signal.aborted) {
        const now = performance.now();
        let maintenance = null;
        if (Date.now() >= nextMaintenance) {
          try {
            maintenance = await maintenanceWorker.runMaintenance(sourceId);
          } catch (error) {
            if (isDatabaseConnectionError(error)) throw error;
            maintenance = { error: "media_maintenance_failed" };
          }
          nextMaintenance = Date.now() + 60000;
        }
        let state = await sourceState(db, sourceId);
        const intake =
          state === "ready" ? await resumeFixtureIntake(db, spool, sourceId, pendingDeferred, signal) : null;
        const paths = await availableArtifacts(spool);
        for (const [id, until] of deferred) if (until <= now || !paths.has(id)) deferred.delete(id);
        const rows = await dueJobs(db, sourceId, paths, deferred);
        const cycles = [];
        for (const lane of rows) {
          for (const jobId of lane.jobs) {
            if (state !== "ready" || signal.aborted) break;
            const result = await launchCollector(
              [
                `--fixture=${paths.get(jobId)}`,
                `--expected-job=${jobId}`,
                `--max-ms=${maxMs}`,
                ...(lane.lane === "images" ? ["--media-only=true"] : []),
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
              lane: lane.lane,
              status: cycle?.status ?? null,
              claimed: cycle?.claimed ?? false,
              exitCode: result.exitCode,
              timedOut: result.report.timedOut,
              mediaResults: cycle?.mediaResults ?? [],
            });
            state = await sourceState(db, sourceId);
          }
        }
        if (signal.aborted) break;
        const queues = {};
        for (const lane of ["pages", "images"]) {
          const counts = rows.find((row) => row.lane === lane);
          const due = counts?.due ?? 0,
            withArtifact = counts?.backed ?? 0;
          queues[lane] = {
            due,
            withArtifact,
            artifactUnavailable: due - withArtifact,
            deferred: counts?.deferred ?? 0,
          };
        }
        console.log(
          JSON.stringify({
            ...envelope(sourceId),
            state,
            maintenance,
            intake,
            cycles,
            queues,
          }),
        );
        if (!watch) break;
        await wait(interval, signal);
      }
      if (!abort.signal.aborted) ownership.signal.throwIfAborted();
    } finally {
      // End ownership with the dedicated connection, including on a broken session.
      lock.release(true);
      lock.removeListener("error", onLockError);
      lock.removeListener("end", onLockEnd);
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
  console.error(JSON.stringify({ error: reason, mode: "offline_fixture", onlineVerified: false }));
  process.exitCode = 1;
}
