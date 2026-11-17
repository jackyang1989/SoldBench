import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createApp } from "./index.ts";

const config = loadConfig(process.env);
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
const db = database(config.databaseUrl);
await migrate(db);
const auth = new AuthService(db, localAuthSecrets(), config.origin);
const query = new QueryService(
  db,
  auth,
  new BillingService(db),
  new PrivateMediaStore(resolve(config.mediaRoot)),
);
const server = serve(
  {
    fetch: createApp(config, db, { auth, query }).fetch,
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
