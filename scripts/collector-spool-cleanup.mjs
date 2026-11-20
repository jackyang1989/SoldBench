import { lstat, opendir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalDatabaseUrl, database, prepareDatabase, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { fixtureJobId, readFixtureFile, syncDirectory } from "./collector-fixture-file.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const pendingName = /^([a-f0-9-]{36})\.([a-f0-9]{64})\.json(?:\.[a-f0-9-]{36}\.tmp)?$/;
const optionalStat = (path) =>
  lstat(path, { bigint: true }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });

async function privateDirectory(path) {
  const info = await optionalStat(path);
  if (info && (!info.isDirectory() || (info.mode & 0o077n) !== 0n))
    throw new Error("collector_spool_requires_private_directory");
  return Boolean(info);
}

async function pendingFiles(spool, sourceId) {
  const root = join(spool, "collector-incoming");
  const directory = join(root, sourceId);
  const files = new Map();
  if (!(await privateDirectory(root)) || !(await privateDirectory(directory))) return files;
  const entries = await opendir(directory);
  let examined = 0;
  for await (const entry of entries) {
    if (++examined > 10000) throw new Error("collector_spool_cleanup_scan_limit");
    const match = pendingName.exec(entry.name);
    if (!match || !fixtureJobId.test(match[1])) continue;
    const group = files.get(match[1]) ?? [];
    group.push({ path: join(directory, entry.name), pendingHash: match[2] });
    files.set(match[1], group);
  }
  return files;
}

async function clearFile({ path, pendingHash }, sourceId, job) {
  try {
    const before = await optionalStat(path);
    if (!before) return "absent";
    if (!before.isFile() || before.nlink !== 1n) return "unverified";
    const { artifact, hash } = await readFixtureFile(path);
    if (
      artifact.sourceId !== sourceId ||
      artifact.jobId !== job.id ||
      artifact.queryHash !== job.query_hash ||
      new Date(artifact.asOf).getTime() !== job.as_of.getTime() ||
      (job.fixture_artifact_hash !== null && job.fixture_artifact_hash !== hash) ||
      (pendingHash !== undefined && pendingHash !== hash)
    )
      return "unverified";
    const after = await optionalStat(path);
    if (!after) return "absent";
    if (after.ino !== before.ino || after.dev !== before.dev || after.ctimeNs !== before.ctimeNs)
      return "unverified";
    await unlink(path);
    await syncDirectory(dirname(path));
    return "removed";
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : "unverified";
  }
}

export async function clearRevokedSpool(db, spool, sourceId) {
  if (!fixtureJobId.test(sourceId)) throw new Error("invalid_collector_cleanup_source");
  return transaction(db, async (c) => {
    const source = await c.query(
      `SELECT s.id FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id
       WHERE s.id=$1 AND s.status='revoked' AND s.access_method='offline_fixture'
         AND x.provider='synthetic_fixture' FOR SHARE OF s,x`,
      [sourceId],
    );
    if (!source.rowCount) throw new Error("collector_spool_source_not_revoked");
    if (!(await privateDirectory(spool))) throw new Error("collector_spool_directory_unavailable");
    const staged = await pendingFiles(spool, sourceId);
    const counts = { removed: 0, unverified: 0, absent: 0 };
    let after = null;
    for (;;) {
      const { rows } = await c.query(
        `SELECT j.id,j.query_hash,j.as_of,r.fixture_artifact_hash FROM collector_jobs j
           JOIN collector_runs r ON r.id=j.collector_run_id
          WHERE j.source_id=$1 AND ($2::uuid IS NULL OR j.id>$2) ORDER BY j.id LIMIT 100`,
        [sourceId, after],
      );
      if (!rows.length) break;
      for (const job of rows) {
        const files = [
          { path: join(spool, `collector-fixture-${job.id}.json`) },
          { path: join(spool, `collector-html-fixture-${job.id}.json`) },
          ...(staged.get(job.id) ?? []),
        ];
        for (const file of files) counts[await clearFile(file, sourceId, job)]++;
        staged.delete(job.id);
      }
      after = rows.at(-1).id;
    }
    for (const remaining of staged.values()) counts.unverified += remaining.length;
    return { mode: "offline_fixture", sourceId, scope: "configured_spool_only", ...counts };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const args = new Map();
    for (const arg of process.argv.slice(2)) {
      const match = /^--(source|spool)=(.+)$/.exec(arg);
      if (!match || args.has(match[1])) throw new Error("invalid_collector_cleanup_argument");
      args.set(match[1], match[2]);
    }
    if (!fixtureJobId.test(args.get("source") ?? "") || !args.has("spool"))
      throw new Error("invalid_collector_cleanup_argument");
    const config = loadConfig(process.env);
    const url = config.databaseUrl ?? localDatabaseUrl();
    assertLocalDatabaseUrl(url, [
      resolve(".local/postgres/socket"),
      ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
    ]);
    db = database(url);
    await prepareDatabase(db, config.databaseStartup);
    const report = await clearRevokedSpool(db, resolve(args.get("spool")), args.get("source"));
    console.log(JSON.stringify(report));
    if (report.unverified) process.exitCode = 2;
  } catch (error) {
    const reason =
      typeof error?.message === "string" && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "collector_spool_cleanup_failed";
    console.error(JSON.stringify({ error: reason, mode: "offline_fixture" }));
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
