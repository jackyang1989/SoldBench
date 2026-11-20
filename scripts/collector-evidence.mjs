import { resolve } from "node:path";
import { collectorRunEvidence } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { exportEvidence, verifyEvidence } from "./collector-evidence-file.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--(source|from|until|output|verify|expect-sha256)=(.+)$/.exec(arg);
  if (!match || args.has(match[1])) throw new Error("invalid_collector_evidence_argument");
  args.set(match[1], match[2]);
}
const sourceId = args.get("source")?.toLowerCase();
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sourceId ?? ""))
  throw new Error("source_id_required");
const from = args.get("from");
const until = args.get("until");
if (!from || !until) throw new Error("collector_evidence_window_required");
const output = args.get("output");
const verify = args.get("verify");
const expected = args.get("expect-sha256");

if (verify) {
  if (output || !/^[a-f0-9]{64}$/.test(expected ?? ""))
    throw new Error("collector_evidence_verification_requires_digest");
  console.log(JSON.stringify(await verifyEvidence(resolve(verify), expected, { sourceId, from, until })));
} else {
  if (expected) throw new Error("collector_evidence_digest_requires_verify");
  const url = process.env.DATABASE_URL ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  const db = database(url);
  try {
    await prepareDatabase(db, "verify");
    const document = await collectorRunEvidence(db, sourceId, from, until);
    console.log(JSON.stringify(output ? await exportEvidence(resolve(output), document) : document));
  } finally {
    await db.end();
  }
}
