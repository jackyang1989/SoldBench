import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BillingService,
  fixtureSignature,
  localPaymentKeys,
  merchant,
  PaymentLifecycle,
  providers,
} from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const [action, file, ...extra] = process.argv.slice(2);
const config = loadConfig(process.env),
  root = resolve(config.localStateRoot);
if (!config.paymentFixtures || extra.length) throw new Error("enable_local_payment_fixtures_first");
if (action === "init" && !file) {
  localPaymentKeys(root, true);
  console.log(JSON.stringify({ mode: "offline_fixture", ready: true }));
} else if (action === "deliver" && file) {
  const source = await open(file, "r");
  let input;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error("invalid_fixture_input");
    input = JSON.parse(await readFile(source, "utf8"));
  } finally {
    await source.close();
  }
  const { event_type: eventType, event_id: eventId, ...fact } = input;
  if (
    !providers.includes(fact.provider) ||
    typeof eventType !== "string" ||
    (eventId !== undefined && typeof eventId !== "string")
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
    await migrate(db);
    const lifecycle = new PaymentLifecycle(new BillingService(db), config.origin, keys);
    const fixed = { ...fact, environment: "offline_fixture", merchant: merchant(fact.provider) };
    await lifecycle.stageFixture(fixed);
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
    const response = await fetch(`${config.origin}/webhooks/${fact.provider}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...fixtureSignature(fact.provider, keys[fact.provider], body, new Date()),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    console.log(
      JSON.stringify({ mode: "offline_fixture", provider: fact.provider, receipt_status: response.status }),
    );
    if (!response.ok) process.exitCode = 1;
  } finally {
    await db.end();
  }
} else throw new Error("usage_payment_fixture_init_or_deliver_file");
