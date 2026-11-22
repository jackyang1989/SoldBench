import { lstat, mkdir, opendir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CollectorStore } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, isDatabaseConnectionError, prepareDatabase } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import {
  fixtureJobId,
  publishFixtureFile,
  readFixtureFile,
  syncDirectory,
} from "./collector-fixture-file.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const pendingName = /^([a-f0-9-]{36})\.([a-f0-9]{64})\.json$/;
const pendingDir = (spool, sourceId) => join(spool, "collector-incoming", sourceId);

async function ensureDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (!(await lstat(path)).isDirectory()) throw new Error("fixture_spool_not_directory");
}

async function publishOnce(path, loaded) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await publishFixtureFile(path, loaded.artifact);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    // An identical concurrent intake may have removed its pending copy after exposing the final file.
    const existing = await readFixtureFile(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!existing) continue;
    if (existing.hash !== loaded.hash) throw new Error("fixture_spool_file_conflict");
    return;
  }
  throw new Error("fixture_spool_publish_race");
}

async function assertArtifactFormat(spool, artifact) {
  const alternative = artifact.htmlProfile ? "collector-fixture" : "collector-html-fixture";
  const other = await lstat(join(spool, `${alternative}-${artifact.jobId}.json`)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (other) throw new Error("fixture_spool_file_conflict");
}

async function exposeFixture(db, spool, pending, loaded, clock = undefined) {
  const { artifact, hash, pageHashes } = loaded;
  const name = artifact.htmlProfile ? "collector-html-fixture" : "collector-fixture";
  const store = new CollectorStore(db, clock, { htmlProfile: artifact.htmlProfile });
  const path = join(spool, `${name}-${artifact.jobId}.json`);
  await store.bindFixtureArtifact({ ...artifact, hash, pageHashes }, async () => {
    await assertArtifactFormat(spool, artifact);
    await publishOnce(path, loaded);
    await syncDirectory(spool);
  });
  await rm(pending, { force: true });
  return path;
}

export async function intakeFixture(db, spool, sourceId, loaded, clock = undefined) {
  const { artifact, hash } = loaded;
  if (!fixtureJobId.test(sourceId) || artifact.sourceId !== sourceId)
    throw new Error("fixture_intake_source_mismatch");
  const { rowCount } = await db.query(
    `SELECT 1 FROM collector_jobs j JOIN sources s ON s.id=j.source_id
     JOIN source_clearances p ON p.id=s.source_clearance_id
     WHERE j.id=$1 AND j.source_id=$2 AND j.query_hash=$3 AND j.as_of=$4
       AND s.access_method='offline_fixture' AND p.provider='synthetic_fixture'`,
    [artifact.jobId, sourceId, artifact.queryHash, artifact.asOf],
  );
  if (!rowCount) throw new Error("fixture_artifact_job_mismatch");
  const incoming = join(spool, "collector-incoming");
  const directory = pendingDir(spool, sourceId);
  const pending = join(directory, `${artifact.jobId}.${hash}.json`);
  const store = new CollectorStore(db, clock, { htmlProfile: artifact.htmlProfile });
  await store.bindFixtureArtifact({ ...artifact, hash, pageHashes: loaded.pageHashes }, async () => {
    await ensureDirectory(spool);
    await ensureDirectory(incoming);
    await ensureDirectory(directory);
    await assertArtifactFormat(spool, artifact);
    await publishOnce(pending, loaded);
    await syncDirectory(directory);
  });
  return exposeFixture(db, spool, pending, loaded, clock);
}

export function createFixtureIntakeScanner(db, spool, sourceId, scanLimit = 10000) {
  const incoming = join(spool, "collector-incoming");
  const directory = pendingDir(spool, sourceId);
  const deferred = new Map();
  let handle;
  let identity;
  async function closeHandle() {
    const previous = handle;
    handle = undefined;
    await previous?.close();
  }
  async function close() {
    identity = undefined;
    deferred.clear();
    await closeHandle();
  }
  async function resume(signal) {
    const result = { published: 0, deferred: 0, scanned: 0, status: "ready" };
    let current;
    for (const candidate of [incoming, directory]) {
      const entry = await lstat(candidate, { bigint: true }).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (!entry) {
        await close();
        return result;
      }
      if (!entry.isDirectory()) {
        await close();
        throw new Error("fixture_spool_not_directory");
      }
      current = `${entry.dev}:${entry.ino}`;
    }
    if (identity !== undefined && identity !== current) {
      await close();
    }
    if (!handle) {
      handle = await opendir(directory);
      identity = current;
    }
    const time = performance.now();
    for (const [file, until] of deferred) if (until <= time) deferred.delete(file);
    let attempts = 0;
    while (!signal.aborted && attempts < 4 && result.scanned < scanLimit) {
      const entry = await handle.read();
      if (!entry) {
        await closeHandle();
        return result;
      }
      result.scanned++;
      const match = pendingName.exec(entry.name);
      if (!entry.isFile() || !match || !fixtureJobId.test(match[1]) || deferred.has(entry.name)) continue;
      attempts++;
      const path = join(directory, entry.name);
      try {
        const loaded = await readFixtureFile(path);
        if (
          loaded.artifact.sourceId !== sourceId ||
          loaded.artifact.jobId !== match[1] ||
          loaded.hash !== match[2]
        )
          throw new Error("fixture_intake_pending_mismatch");
        signal.throwIfAborted();
        await exposeFixture(db, spool, path, loaded);
        result.published++;
      } catch (error) {
        if (signal.aborted) break;
        if (isDatabaseConnectionError(error)) throw error;
        if (error.code !== "ENOENT") {
          result.deferred++;
          deferred.set(entry.name, performance.now() + 30000);
        }
      }
    }
    if (result.scanned === scanLimit) result.status = "scan_limit";
    return result;
  }
  return { resume, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const options = new Map();
    for (const argument of process.argv.slice(2)) {
      const match = /^--(source|spool|fixture)=(.+)$/.exec(argument);
      if (!match || options.has(match[1])) throw new Error("invalid_collector_intake_argument");
      options.set(match[1], match[2]);
    }
    if (!fixtureJobId.test(options.get("source") ?? "") || !options.get("fixture"))
      throw new Error("invalid_collector_intake_argument");
    const config = loadConfig(process.env);
    const url = config.databaseUrl ?? localDatabaseUrl();
    assertLocalDatabaseUrl(url, [
      resolve(".local/postgres/socket"),
      ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
    ]);
    const loaded = await readFixtureFile(resolve(options.get("fixture")));
    db = database(url);
    await prepareDatabase(db, config.databaseStartup);
    const path = await intakeFixture(
      db,
      resolve(options.get("spool") ?? process.env.COLLECTOR_DEMO_DIR ?? ".local"),
      options.get("source"),
      loaded,
    );
    console.log(
      JSON.stringify({
        kind: "collector_fixture_intake",
        mode: "offline_fixture",
        jobId: loaded.artifact.jobId,
        artifactHash: loaded.hash,
        artifactPath: path,
        externalNetworkRequests: 0,
        onlineVerified: false,
      }),
    );
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "collector_fixture_intake_failed";
    console.error(JSON.stringify({ error: reason, mode: "offline_fixture" }));
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
