import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BillingService,
  factSchema,
  fixtureEnvelopeBytes,
  fixtureReplayBatch,
  fixtureSignature,
  localPaymentKeys,
  merchant,
  PaymentLifecycle,
  providers,
  verifyFixture,
} from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, migrate, prepareDatabase } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const [action, file, ...extra] = process.argv.slice(2);
const config = loadConfig(process.env);
const root = resolve(config.localStateRoot);
const batch = action === "replay-batch";
const replay = action === "replay" || batch;
const mode = "offline_fixture";

async function readFixture(path) {
  const expected = process.env.PAYMENT_REPLAY_SHA256;
  if (replay && (process.env.PRIVACY_RESTORE_ISOLATED !== "true" || !/^[a-f0-9]{64}$/.test(expected ?? "")))
    throw new Error("require_isolated_restore_and_trusted_payment_digest");
  const source = await open(
    path,
    replay ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : "r",
  );
  try {
    const limit = batch ? fixtureReplayBatch.bytes : 8192;
    const stat = await source.stat();
    if (!stat.isFile() || stat.size > limit || (replay && stat.mode & 0o077))
      throw new Error("invalid_fixture_input");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await source.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error("invalid_fixture_input");
    const bytes = buffer.subarray(0, size);
    if (replay && createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("payment_replay_digest_mismatch");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await source.close();
  }
}

function notification(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid_fixture_notification");
  const { event_type: eventType, event_id: eventId, ...body } = input;
  if (
    !providers.includes(body.provider) ||
    typeof eventType !== "string" ||
    ((replay || eventId !== undefined) && typeof eventId !== "string") ||
    (replay && (body.environment !== mode || body.merchant !== merchant(body.provider)))
  )
    throw new Error("invalid_fixture_notification");
  const fact = factSchema.parse({ ...body, environment: mode, merchant: merchant(body.provider) });
  const id = eventId ?? randomUUID();
  const raw = fixtureEnvelopeBytes({
    id,
    type: eventType,
    environment: fact.environment,
    merchant: fact.merchant,
    object_id: fact.object_id,
    revision: fact.revision,
  });
  return { fact, id, raw };
}

const sign = (keys, entry, now) => ({
  "Content-Type": "application/json",
  ...fixtureSignature(entry.fact.provider, keys[entry.fact.provider], entry.raw, now),
});

async function replayOne(db, lifecycle, keys, entry) {
  const { id, fact, raw } = entry;
  await lifecycle.stageFixture(fact);
  await lifecycle.receive(fact.provider, new Headers(sign(keys, entry, new Date())), raw);
  const processed = await lifecycle.workOnce({ provider: fact.provider, eventId: id });
  if (processed) return processed.status;
  const { rows } = await db.query(
    "SELECT status FROM payment_events WHERE provider=$1 AND provider_event_id=$2",
    [fact.provider, id],
  );
  return rows[0]?.status === "applied" ? "already_applied" : (rows[0]?.status ?? "missing");
}

async function replayBatch(db, lifecycle, keys, entries) {
  const totals = { mode, total: entries.length, applied: 0, already_applied: 0 };
  for (const [index, entry] of entries.entries()) {
    let outcome;
    try {
      outcome = await replayOne(db, lifecycle, keys, entry);
    } catch {
      outcome = "replay_error";
    }
    if (outcome !== "applied" && outcome !== "already_applied") {
      console.log(JSON.stringify({ ...totals, outcome, blocking_entry: index + 1 }));
      process.exitCode = 2;
      return;
    }
    totals[outcome]++;
  }
  console.log(JSON.stringify({ ...totals, outcome: "completed", blocking_entry: null }));
}

if (!config.paymentFixtures || extra.length) throw new Error("enable_local_payment_fixtures_first");
if (action === "init" && !file) {
  localPaymentKeys(root, true);
  console.log(JSON.stringify({ mode, ready: true }));
} else if ((action === "deliver" || replay) && file) {
  const input = await readFixture(file);
  if (
    batch &&
    (input?.schema !== fixtureReplayBatch.schema ||
      Object.keys(input).length !== 2 ||
      !Array.isArray(input.events) ||
      input.events.length < 1 ||
      input.events.length > fixtureReplayBatch.entries)
  )
    throw new Error("invalid_payment_replay_batch");
  const entries = (batch ? input.events : [input]).map(notification);
  if (batch && new Set(entries.map(({ fact, id }) => `${fact.provider}:${id}`)).size !== entries.length)
    throw new Error("duplicate_payment_replay_notification");
  const keys = localPaymentKeys(root);
  if (replay) {
    const now = new Date();
    for (const entry of entries)
      verifyFixture(
        entry.fact.provider,
        keys[entry.fact.provider],
        new Headers(sign(keys, entry, now)),
        entry.raw,
        now,
      );
  }

  const url = config.databaseUrl ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  const db = database(url);
  try {
    if (replay) await prepareDatabase(db, "verify");
    else await migrate(db);
    const lifecycle = new PaymentLifecycle(new BillingService(db), config.origin, keys);
    const [entry] = entries;
    if (batch) {
      await replayBatch(db, lifecycle, keys, entries);
    } else if (replay) {
      const outcome = await replayOne(db, lifecycle, keys, entry);
      console.log(JSON.stringify({ mode, provider: entry.fact.provider, outcome }));
      if (outcome !== "applied" && outcome !== "already_applied") process.exitCode = 2;
    } else {
      await lifecycle.stageFixture(entry.fact);
      const response = await fetch(`${config.origin}/webhooks/${entry.fact.provider}`, {
        method: "POST",
        redirect: "error",
        headers: sign(keys, entry, new Date()),
        body: entry.raw,
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      console.log(JSON.stringify({ mode, provider: entry.fact.provider, receipt_status: response.status }));
      if (!response.ok) process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
} else throw new Error("usage_payment_fixture_init_deliver_replay_or_replay_batch");
