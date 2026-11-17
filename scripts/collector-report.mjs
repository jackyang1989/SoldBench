import { resolve } from "node:path";
import { collectorHealth } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--(source|from|clock)=(.+)$/.exec(raw);
  if (!m || args.has(m[1])) throw new Error("invalid_collector_report_argument");
  args.set(m[1], m[2]);
}
if (!/^[a-f0-9-]{36}$/.test(args.get("source") ?? "")) throw new Error("source_id_required");
loadConfig(process.env);
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url);
try {
  await migrate(db);
  console.log(
    JSON.stringify(
      await collectorHealth(db, args.get("source"), {
        from: args.get("from"),
        now: args.get("clock"),
        persist: true,
      }),
    ),
  );
} finally {
  await db.end();
}
