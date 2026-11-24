import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CollectorStore, OfflineCollectorWorker } from "@soldbench/collector";
import { instant } from "@soldbench/core";
import { database, prepareDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { isSourceKindAllowedForMode, loadConfig } from "@soldbench/shared";
import { readFixtureFile } from "./collector-fixture-file.mjs";
import { localDatabaseUrl } from "./local-db.mjs";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--(fixture|max-pages|clock|status|media-only|detail-only|expected-job)=(.+)$/.exec(raw);
  if (!match || args.has(match[1])) throw new Error("invalid_collector_worker_argument");
  args.set(match[1], match[2]);
}
if (!args.get("fixture")) throw new Error("fixture_artifact_path_required");
if (args.has("status") && args.get("status") !== "true") throw new Error("invalid_worker_status_option");
if (args.has("media-only") && args.get("media-only") !== "true")
  throw new Error("invalid_worker_media_option");
if (args.has("detail-only") && args.get("detail-only") !== "true")
  throw new Error("invalid_worker_detail_option");
if (args.has("media-only") && (args.has("status") || args.has("max-pages") || args.has("detail-only")))
  throw new Error("conflicting_worker_options");
if (args.has("detail-only") && (args.has("status") || args.has("max-pages")))
  throw new Error("conflicting_worker_options");
const maxPages = args.has("max-pages") ? Number(args.get("max-pages")) : undefined;
if (
  maxPages !== undefined &&
  (!/^\d+$/.test(args.get("max-pages")) || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000)
)
  throw new Error("invalid_worker_page_limit");
const config = loadConfig(process.env);
if (args.has("clock")) instant(args.get("clock"));
const path = resolve(args.get("fixture"));
const loaded = await readFixtureFile(path);
const artifact = loaded.artifact;
if (args.has("expected-job") && args.get("expected-job") !== artifact.jobId)
  throw new Error("fixture_artifact_expected_job_mismatch");
const url = config.databaseUrl ?? localDatabaseUrl();
assertAllowedDatabaseUrl(config, url);
const db = database(url),
  controller = new AbortController();
const stop = () => controller.abort();
let parentDeadline;
const onParentLost = () => {
  stop();
  // The launcher cannot enforce its deadline after an abrupt exit.
  parentDeadline ??= setTimeout(() => process.exit(1), 2000);
  parentDeadline.unref();
};
if (typeof process.send === "function") {
  process.once("disconnect", onParentLost);
  if (!process.connected) onParentLost();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const root = resolve(process.env.COLLECTOR_DEMO_DIR ?? ".local");
const supervised = args.has("expected-job");
const directory = supervised ? join(root, "collector-supervised-status") : root;
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (supervised && !lstatSync(directory).isDirectory()) throw new Error("collector_status_not_directory");
const heartbeat = join(
  directory,
  supervised
    ? `${artifact.jobId}-${args.has("media-only") ? "images" : args.has("detail-only") ? "details" : "pages"}.json`
    : `${args.has("status") ? "collector-status" : "collector-worker"}-${artifact.jobId}${args.has("status") ? "" : `-${process.pid}`}.json`,
);
const clock = args.has("clock") ? () => args.get("clock") : undefined;
const writeHeartbeat = (value) => {
  const temporary = `${heartbeat}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, heartbeat);
};
try {
  await prepareDatabase(db, config.databaseStartup);
  const store = new CollectorStore(db, clock, {
      htmlProfile: artifact.htmlProfile,
      dataMode: config.dataMode,
    }),
    job = await store.view(artifact.jobId);
  const source = (
    await db.query(
      "SELECT s.access_method,s.status,s.permission_epoch,x.provider FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1",
      [artifact.sourceId],
    )
  ).rows[0];
  if (
    !source ||
    !isSourceKindAllowedForMode(config.dataMode, source) ||
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
    mode: config.dataMode,
    pid: process.pid,
    jobId: job.id,
    time: new Date().toISOString(),
  });
  let claimed = false,
    mediaResults = [],
    detailResults = [];
  if (
    !controller.signal.aborted &&
    !args.has("status") &&
    (args.has("media-only") ||
      args.has("detail-only") ||
      !["completed", "failed", "cancelled", "expired"].includes(job.status))
  ) {
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
      new PrivateMediaStore(resolve(config.mediaRoot)),
    );
    if (args.has("media-only")) {
      mediaResults = await runner.retryImages(artifact.sourceId, {
        parentJobId: job.id,
        signal: controller.signal,
      });
      claimed = mediaResults.length > 0;
    } else if (args.has("detail-only")) {
      detailResults = await runner.runDetails(artifact.sourceId, {
        parentJobId: job.id,
        signal: controller.signal,
      });
      claimed = detailResults.length > 0;
    } else
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
    mediaResults,
    detailResults,
    cycleMode: args.has("media-only")
      ? "primary_image_retry"
      : args.has("detail-only")
        ? "detail_enrichment"
        : "pages",
    heartbeatPath: heartbeat,
    lastSuccessAt: lastSuccess?.toISOString() ?? null,
    mode: config.dataMode,
    onlineVerified: config.dataMode === "approved_network",
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
  if (
    ["failed", "cancelled", "expired"].includes(current.status) ||
    mediaResults.some((r) => ["failed", "expired"].includes(r.status)) ||
    detailResults.some((r) => ["failed", "expired"].includes(r.status))
  )
    process.exitCode = 1;
} catch (error) {
  writeHeartbeat({
    state: "failed",
    mode: config.dataMode,
    pid: process.pid,
    jobId: artifact.jobId,
    time: new Date().toISOString(),
  });
  const reason =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "local_collector_worker_failed";
  console.error(
    JSON.stringify({
      error: reason,
      mode: config.dataMode,
      onlineVerified: config.dataMode === "approved_network",
    }),
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  try {
    await db.end();
  } finally {
    clearTimeout(parentDeadline);
    process.removeListener("disconnect", onParentLost);
    if (process.connected) process.disconnect();
  }
}
