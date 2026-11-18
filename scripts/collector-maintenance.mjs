import { resolve } from "node:path";
import { CollectorStore, FixtureTransport, OfflineCollectorWorker } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const config = loadConfig(process.env);
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url);
try {
  await migrate(db);
  const store = new CollectorStore(db),
    worker = new OfflineCollectorWorker(
      store,
      new FixtureTransport(new Map()),
      new PrivateMediaStore(resolve(config.mediaRoot)),
    );
  const sources = await db.query(
    "SELECT s.id FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.access_method='offline_fixture' AND x.provider='synthetic_fixture' ORDER BY s.id",
  );
  const totals = {
    sources: 0,
    expired: 0,
    orphans: 0,
    cleanupProcessed: 0,
    unmatchedMediaStores: 0,
    failedSources: 0,
  };
  for (const source of sources.rows) {
    totals.sources++;
    try {
      const result = await worker.runMaintenance(source.id);
      totals.expired += result.expired;
      totals.orphans += result.orphans;
      totals.cleanupProcessed += result.cleanupProcessed;
      if (!result.mediaStoreMatched) totals.unmatchedMediaStores++;
    } catch {
      totals.failedSources++;
      console.error(JSON.stringify({ sourceId: source.id, error: "media_maintenance_failed" }));
    }
  }
  const pending = await db.query(
    "SELECT count(*)::int AS n FROM outbox WHERE kind='collector.media_cleanup' AND processed_at IS NULL",
  );
  console.log(
    JSON.stringify({
      mode: "offline_fixture",
      networkRequests: 0,
      ...totals,
      cleanupPending: pending.rows[0].n,
    }),
  );
  if (totals.failedSources) process.exitCode = 1;
} finally {
  await db.end();
}
