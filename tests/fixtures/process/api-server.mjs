import { serve } from "@hono/node-server";
import { createApp } from "@soldbench/api";
import { database } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";

const db = database(process.env.DATABASE_URL),
  config = loadConfig(process.env);
const server = serve({ fetch: createApp(config, db).fetch, hostname: "127.0.0.1", port: 0 }, (address) => {
  console.log(JSON.stringify({ port: address.port, pid: process.pid }));
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () =>
    server.close(() => {
      void db.end().then(() => process.exit(0));
    }),
  );
