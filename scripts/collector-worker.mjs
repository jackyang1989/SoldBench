import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CollectorStore, loadFixtureArtifact, OfflineCollectorWorker } from "@soldbench/collector";
import { instant } from "@soldbench/core";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--(fixture|max-pages|clock|status)=(.+)$/.exec(raw);
  if (!match || args.has(match[1])) throw new Error("invalid_collector_worker_argument");
  args.set(match[1], match[2]);
}
if (!args.get("fixture")) throw new Error("fixture_artifact_path_required");
if (args.has("status") && args.get("status") !== "true") throw new Error("invalid_worker_status_option");
const maxPages = args.has("max-pages") ? Number(args.get("max-pages")) : undefined;
if (
  maxPages !== undefined &&
  (!/^\d+$/.test(args.get("max-pages")) || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000)
)
  throw new Error("invalid_worker_page_limit");
loadConfig(process.env);
if (args.has("clock")) instant(args.get("clock"));
const path = resolve(args.get("fixture"));
if (!lstatSync(path).isFile() || lstatSync(path).size > 16 * 1024 * 1024)
  throw new Error("fixture_artifact_file_invalid");
const loaded = loadFixtureArtifact(readFileSync(path)),
  artifact = loaded.artifact;
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url),
  controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const directory = resolve(process.env.COLLECTOR_DEMO_DIR ?? ".local");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const heartbeat = join(
  directory,
  `${args.has("status") ? "collector-status" : "collector-worker"}-${artifact.jobId}${args.has("status") ? "" : `-${process.pid}`}.json`,
);
const clock = args.has("clock") ? () => args.get("clock") : undefined;
const writeHeartbeat = (value) => {
  const temporary = `${heartbeat}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, heartbeat);
};
try {
  await migrate(db);
  const store = new CollectorStore(db, clock),
    job = await store.view(artifact.jobId);
  const source = (
    await db.query("SELECT access_method,status,permission_epoch FROM sources WHERE id=$1", [
      artifact.sourceId,
    ])
  ).rows[0];
  if (
    source?.access_method !== "offline_fixture" ||
    job.source_id !== artifact.sourceId ||
    job.query_hash !== artifact.queryHash ||
    job.as_of.toISOString() !== new Date(artifact.asOf).toISOString()
  )
    throw new Error("fixture_artifact_job_mismatch");
  const run = (
    await db.query("SELECT fixture_artifact_hash FROM collector_runs WHERE id=$1", [job.collector_run_id])
  ).rows[0];
  if (run.fixture_artifact_hash && run.fixture_artifact_hash !== loaded.hash)
    throw new Error("fixture_artifact_changed");
  writeHeartbeat({
    state: "starting",
    mode: "offline_fixture",
    pid: process.pid,
    jobId: job.id,
    time: new Date().toISOString(),
  });
  let claimed = false;
  if (!args.has("status") && !["completed", "failed", "cancelled", "expired"].includes(job.status)) {
    await store.bindFixtureArtifact({
      jobId: job.id,
      sourceId: artifact.sourceId,
      queryHash: artifact.queryHash,
      asOf: artifact.asOf,
      hash: loaded.hash,
      pageHashes: loaded.pageHashes,
    });
    const runner = new OfflineCollectorWorker(
      store,
      loaded.transport,
      new PrivateMediaStore(join(directory, "collector-media")),
    );
    claimed =
      (await runner.runOne(artifact.sourceId, { jobId: job.id, maxPages, signal: controller.signal })) !==
      null;
  }
  const current = await store.view(job.id),
    captured = clock ? new Date(clock()) : (await db.query("SELECT clock_timestamp() t")).rows[0].t;
  const circuit = (
    await db.query("SELECT status FROM collector_circuits WHERE source_id=$1 AND category_key='*'", [
      artifact.sourceId,
    ])
  ).rows[0];
  const success = (
    await db.query("SELECT outcome,completed_at FROM collector_runs WHERE id=$1", [job.collector_run_id])
  ).rows[0];
  const lastSuccess = success.outcome === "completed" ? success.completed_at : null;
  const report = {
    kind: args.has("status") ? "inspection" : "worker_cycle",
    claimed,
    heartbeatPath: heartbeat,
    lastSuccessAt: lastSuccess?.toISOString() ?? null,
    mode: "offline_fixture",
    onlineVerified: false,
    networkRequests: 0,
    pid: process.pid,
    jobId: job.id,
    status: current.status,
    pageCount: current.page_count,
    requestsReserved: current.request_count,
    bytesUsedForBudget: current.bytes_used,
    bytesReserved: current.bytes_reserved,
    leaseCount: current.lease_count,
    failureAttempts: current.attempts,
    errorCode: current.error_code,
    cursor: current.cursor,
    circuit: circuit?.status ?? "closed",
    fixtureArtifactHash: loaded.hash,
    fixtureResponses: loaded.transport.calls.length,
    clock: clock ? "explicit_simulation" : "database",
    capturedAt: captured.toISOString(),
  };
  await db.query(
    "INSERT INTO collector_health_snapshots(source_id,captured_at,last_success_at,metrics) VALUES($1,$2,$3,$4)",
    [artifact.sourceId, captured, lastSuccess, JSON.stringify(report)],
  );
  writeHeartbeat({
    ...report,
    state: args.has("status")
      ? "inspection"
      : !claimed
        ? "not_claimed"
        : controller.signal.aborted
          ? "stopped"
          : "cycle_finished",
  });
  console.log(JSON.stringify(report));
  if (["failed", "cancelled", "expired"].includes(current.status)) process.exitCode = 1;
} catch (error) {
  writeHeartbeat({
    state: "failed",
    mode: "offline_fixture",
    pid: process.pid,
    jobId: artifact.jobId,
    time: new Date().toISOString(),
  });
  const reason =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "local_collector_worker_failed";
  console.error(JSON.stringify({ error: reason, mode: "offline_fixture", onlineVerified: false }));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  await db.end();
}
