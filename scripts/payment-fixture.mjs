import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BillingService,
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
const config = loadConfig(process.env),
  root = resolve(config.localStateRoot);
if (!config.paymentFixtures || extra.length) throw new Error("enable_local_payment_fixtures_first");
if (action === "init" && !file) {
  localPaymentKeys(root, true);
  console.log(JSON.stringify({ mode: "offline_fixture", ready: true }));
} else if (["deliver", "replay"].includes(action) && file) {
  const replay = action === "replay";
  const expected = process.env.PAYMENT_REPLAY_SHA256;
  if (replay && (process.env.PRIVACY_RESTORE_ISOLATED !== "true" || !/^[a-f0-9]{64}$/.test(expected ?? "")))
    throw new Error("require_isolated_restore_and_trusted_payment_digest");
  const source = await open(
    file,
    replay ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : "r",
  );
  let input;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size > 8192 || (replay && stat.mode & 0o077))
      throw new Error("invalid_fixture_input");
    const buffer = Buffer.alloc(8193);
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
    input = JSON.parse(bytes.toString("utf8"));
  } finally {
    await source.close();
  }
  const { event_type: eventType, event_id: eventId, ...fact } = input;
  if (
    !providers.includes(fact.provider) ||
    typeof eventType !== "string" ||
    ((replay || eventId !== undefined) && typeof eventId !== "string") ||
    (replay && (fact.environment !== "offline_fixture" || fact.merchant !== merchant(fact.provider)))
  )
    throw new Error("invalid_fixture_notification");
  const url = config.databaseUrl ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  const db = database(url),
    keys = localPaymentKeys(root);
  try {
    if (replay) await prepareDatabase(db, "verify");
    else await migrate(db);
    const lifecycle = new PaymentLifecycle(new BillingService(db), config.origin, keys);
    const fixed = { ...fact, environment: "offline_fixture", merchant: merchant(fact.provider) };
    const body = Buffer.from(
      JSON.stringify({
        id: eventId ?? randomUUID(),
        type: eventType,
        environment: fixed.environment,
        merchant: fixed.merchant,
        object_id: fact.object_id,
        revision: fact.revision,
      }),
    );
    const now = new Date();
    const headers = {
      "Content-Type": "application/json",
      ...fixtureSignature(fact.provider, keys[fact.provider], body, now),
    };
    if (replay) verifyFixture(fact.provider, keys[fact.provider], new Headers(headers), body, now);
    await lifecycle.stageFixture(fixed);
    if (replay) {
      await lifecycle.receive(fact.provider, new Headers(headers), body);
      const processed = await lifecycle.workOnce({ provider: fact.provider, eventId });
      const status =
        processed?.status ??
        (
          await db.query("SELECT status FROM payment_events WHERE provider=$1 AND provider_event_id=$2", [
            fact.provider,
            eventId,
          ])
        ).rows[0]?.status;
      const outcome = status === "applied" && !processed ? "already_applied" : status;
      console.log(JSON.stringify({ mode: "offline_fixture", provider: fact.provider, outcome }));
      if (status !== "applied") process.exitCode = 2;
    } else {
      const response = await fetch(`${config.origin}/webhooks/${fact.provider}`, {
        method: "POST",
        redirect: "error",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      console.log(
        JSON.stringify({ mode: "offline_fixture", provider: fact.provider, receipt_status: response.status }),
      );
      if (!response.ok) process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
} else throw new Error("usage_payment_fixture_init_deliver_or_replay");
