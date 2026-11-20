import { createHash } from "node:crypto";
import { link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { factSchema, fixtureEnvelopeBytes, fixtureReplayBatch, merchant } from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utc = (text) =>
  typeof text === "string" &&
  /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) &&
  Number.isFinite(Date.parse(text)) &&
  new Date(text).toISOString() === text;

async function selectEvents(db, from, until) {
  return transaction(db, async (c) => {
    await c.query("SET TRANSACTION READ ONLY");
    const { rows } = await c.query(
      `SELECT e.provider,e.provider_event_id,e.event_type,e.fixture_envelope,e.fixture_digest,f.fact,
              to_char(e.processed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') applied_at
         FROM payment_events e
         LEFT JOIN payment_fixture_facts f ON f.provider=e.provider
           AND f.merchant_id=e.fixture_envelope->>'merchant'
           AND f.object_id=e.fixture_envelope->>'object_id'
           AND f.revision::text=e.fixture_envelope->>'revision'
        WHERE e.status='applied' AND e.fixture_envelope IS NOT NULL AND e.processed_at >= $1 AND e.processed_at < $2
        ORDER BY e.processed_at,e.received_at,e.id LIMIT $3`,
      [from, until, fixtureReplayBatch.entries + 1],
    );
    if (rows.length > fixtureReplayBatch.entries) throw new Error("payment_replay_range_too_large");
    const applied = new Map();
    return rows.map((row) => {
      const envelope = row.fixture_envelope;
      if (
        row.provider_event_id !== envelope.id ||
        row.event_type !== envelope.type ||
        sha(fixtureEnvelopeBytes(envelope)) !== row.fixture_digest
      ) {
        throw new Error("original_fixture_notification_bytes_unavailable");
      }
      const fact = factSchema.parse(row.fact);
      if (
        fact.provider !== row.provider ||
        fact.environment !== envelope.environment ||
        fact.merchant !== envelope.merchant ||
        fact.merchant !== merchant(fact.provider) ||
        fact.object_id !== envelope.object_id ||
        fact.revision !== envelope.revision
      )
        throw new Error("payment_replay_confirmation_mismatch");
      const key = `${fact.checkout_id}:${row.applied_at}`;
      const business = `${fact.object_id}:${fact.revision}`;
      if (applied.has(key) && applied.get(key) !== business)
        throw new Error("payment_replay_order_ambiguous");
      applied.set(key, business);
      return { ...fact, event_id: envelope.id, event_type: envelope.type };
    });
  });
}

async function publish(path, data) {
  const temp = await mkdtemp(join(dirname(path), ".soldbench-payment-replay-"));
  try {
    const staging = join(temp, "payload");
    const file = await open(staging, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(staging, path);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function run() {
  const [file, from, until, ...extra] = process.argv.slice(2);
  if (!file || extra.length || !utc(from) || !utc(until) || from >= until)
    throw new Error("usage_payment_replay_export_file_from_until");
  const config = loadConfig(process.env);
  if (!config.paymentFixtures) throw new Error("enable_local_payment_fixtures_first");
  const url = config.databaseUrl ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  const db = database(url);
  try {
    const events = await selectEvents(db, from, until);
    const report = { mode: config.dataMode, exported: false, count: events.length };
    if (!events.length) {
      console.log(JSON.stringify(report));
      return;
    }
    const data = Buffer.from(JSON.stringify({ schema: fixtureReplayBatch.schema, events }));
    if (data.length > fixtureReplayBatch.bytes) throw new Error("payment_replay_range_too_large");
    await publish(resolve(file), data);
    console.log(JSON.stringify({ ...report, exported: true, sha256: sha(data) }));
  } finally {
    await db.end();
  }
}

await run();
