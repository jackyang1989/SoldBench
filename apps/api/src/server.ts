import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService, localPaymentKeys, PaymentLifecycle } from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, prepareRuntimeDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createApp } from "./index.ts";

const config = loadConfig(process.env);
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
assertLocalDatabaseUrl(config.databaseUrl, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(config.databaseUrl);
const signals = ["SIGINT", "SIGTERM"] as const;
const startup = new AbortController();
const stopStartup = () => startup.abort();

async function start() {
  for (const signal of signals) process.on(signal, stopStartup);
  let listening = false;
  try {
    await prepareRuntimeDatabase(db, config.databaseStartup, startup.signal, () =>
      console.error("soldbench_api_startup_database_unavailable"),
    );
    const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin);
    const billing = new BillingService(db);
    const payments = config.paymentFixtures
      ? new PaymentLifecycle(billing, config.origin, localPaymentKeys(resolve(config.localStateRoot)))
      : undefined;
    const query = new QueryService(db, auth, billing, new PrivateMediaStore(resolve(config.mediaRoot)));
    const server = serve(
      {
        fetch: createApp(config, db, { auth, query, payments }).fetch,
        port: config.port,
        hostname: config.host,
      },
      () => {
        console.log(`SoldBench local server listening at ${config.origin}`);
      },
    );
    let stopping = false;
    const stopServer = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        void db.end().then(() => process.exit(0));
      });
    };
    for (const signal of signals) process.on(signal, stopServer);
    listening = true;
  } catch (error) {
    if (!startup.signal.aborted) throw error;
  } finally {
    for (const signal of signals) process.removeListener(signal, stopStartup);
    if (!listening) await db.end();
  }
}

await start();
