import { database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

const config = loadConfig(process.env);
const url = config.databaseUrl ?? localDatabaseUrl();
assertAllowedDatabaseUrl(config, url);
const db = database(url);
const through = process.argv[2];
try {
  console.log(JSON.stringify({ applied: await migrate(db, through) }));
} finally {
  await db.end();
}
