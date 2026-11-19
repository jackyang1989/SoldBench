import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService, localPaymentKeys, PaymentLifecycle } from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
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
await migrate(db);
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
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
  });
