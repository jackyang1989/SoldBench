import { resolve } from "node:path";
import { CollectorStore, FixtureTransport, OfflineCollectorWorker } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

loadConfig(process.env);
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
      new PrivateMediaStore(resolve(process.env.COLLECTOR_DEMO_DIR ?? ".local", "collector-media")),
    );
  const sources = await db.query("SELECT id FROM sources WHERE access_method='offline_fixture'");
  const totals = { sources: 0, expired: 0, orphans: 0 };
  for (const source of sources.rows) {
    const result = await worker.runMaintenance(source.id);
    totals.sources++;
    totals.expired += result.expired;
    totals.orphans += result.orphans;
  }
  console.log(JSON.stringify({ mode: "offline_fixture", networkRequests: 0, ...totals }));
} finally {
  await db.end();
}
