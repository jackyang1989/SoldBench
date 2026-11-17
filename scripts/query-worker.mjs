import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => !["--once", "--watch"].includes(a)))
  throw new Error("invalid_query_worker_argument");
const config = loadConfig(process.env),
  url = config.databaseUrl ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url),
  abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => abort.abort());
try {
  await migrate(db);
  const auth = new AuthService(db, localAuthSecrets(), config.origin),
    query = new QueryService(
      db,
      auth,
      new BillingService(db),
      new PrivateMediaStore(resolve(config.mediaRoot)),
    ),
    worker = `query-${randomUUID()}`;
  do {
    const result = await query.workOnce(worker);
    if (result) console.log(JSON.stringify({ data_mode: "offline_fixture", ...result }));
    if (args[0] !== "--watch" || abort.signal.aborted) break;
    if (!result) await setTimeout(1000, undefined, { signal: abort.signal }).catch(() => {});
  } while (!abort.signal.aborted);
} finally {
  await db.end();
}
