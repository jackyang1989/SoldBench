import { resolve } from "node:path";
import { collectorRunEvidence } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { localDatabaseUrl } from "./local-db.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--(source|from|until)=(.+)$/.exec(arg);
  if (!match || args.has(match[1])) throw new Error("invalid_collector_evidence_argument");
  args.set(match[1], match[2]);
}
const sourceId = args.get("source");
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sourceId ?? ""))
  throw new Error("source_id_required");
if (!args.has("from") || !args.has("until")) throw new Error("collector_evidence_window_required");
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url);
try {
  await prepareDatabase(db, "verify");
  console.log(JSON.stringify(await collectorRunEvidence(db, sourceId, args.get("from"), args.get("until"))));
} finally {
  await db.end();
}
