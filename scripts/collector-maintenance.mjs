import { resolve } from "node:path";
import { CollectorStore, FixtureTransport, OfflineCollectorWorker } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

let requireClear = false;
let sourceId;
for (const argument of process.argv.slice(2)) {
  const source = /^--source=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(argument);
  if (argument === "--require-clear" && !requireClear) requireClear = true;
  else if (source && !sourceId) sourceId = source[1];
  else throw new Error("invalid_collector_maintenance_argument");
}
const config = loadConfig(process.env);
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url);
try {
  await prepareDatabase(db, config.databaseStartup);
  const store = new CollectorStore(db),
    worker = new OfflineCollectorWorker(
      store,
      new FixtureTransport(new Map()),
      new PrivateMediaStore(resolve(config.mediaRoot)),
    );
  const sources = await db.query(
    `SELECT s.id FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id
     WHERE s.access_method='offline_fixture' AND x.provider='synthetic_fixture'
       AND ($1::uuid IS NULL OR s.id=$1) ORDER BY s.id`,
    [sourceId ?? null],
  );
  if (sourceId && !sources.rowCount) throw new Error("collector_source_unavailable");
  const totals = {
    sources: 0,
    expired: 0,
    expirationPendingSources: 0,
    orphans: 0,
    cleanupProcessed: 0,
    unmatchedMediaStores: 0,
    failedSources: 0,
    pagesClosed: 0,
    imageRetriesClosed: 0,
  };
  for (const source of sources.rows) {
    totals.sources++;
    try {
      const settled = await store.settleUnclaimable(source.id);
      totals.pagesClosed += settled.pagesClosed;
      totals.imageRetriesClosed += settled.imageRetriesClosed;
      const result = await worker.runMaintenance(source.id);
      totals.expired += result.expired;
      if (result.expirationPending) totals.expirationPendingSources++;
      totals.orphans += result.orphans;
      totals.cleanupProcessed += result.cleanupProcessed;
      if (!result.mediaStoreMatched) totals.unmatchedMediaStores++;
    } catch {
      totals.failedSources++;
      console.error(JSON.stringify({ sourceId: source.id, error: "media_maintenance_failed" }));
    }
  }
  const pending = await db.query(
    `SELECT count(*)::int AS n FROM outbox WHERE kind='collector.media_cleanup' AND processed_at IS NULL
       AND ($1::text IS NULL OR payload->>'sourceId'=$1)`,
    [sourceId ?? null],
  );
  const cleanupPending = pending.rows[0].n;
  console.log(
    JSON.stringify({
      mode: "offline_fixture",
      networkRequests: 0,
      ...totals,
      ...(sourceId && { sourceId }),
      cleanupPending,
    }),
  );
  if (totals.failedSources) process.exitCode = 1;
  else if (requireClear && (cleanupPending !== 0 || totals.expirationPendingSources !== 0))
    process.exitCode = 2;
} finally {
  await db.end();
}
