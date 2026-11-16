import { serve } from "@hono/node-server";
import { database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { createApp } from "./index.ts";

const config = loadConfig(process.env);
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
const db = database(config.databaseUrl);
await migrate(db);
const server = serve({ fetch: createApp(config, db).fetch, port: config.port, hostname: config.host }, () => {
  console.log(`SoldBench local server listening at ${config.origin}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
  });
