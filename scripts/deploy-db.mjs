import { readFile } from "node:fs/promises";
import { database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

const config = loadConfig(process.env);
if (!config.databaseUrl || config.databaseStartup !== "migrate")
  throw new Error("deployment_migration_configuration_required");
assertAllowedDatabaseUrl(config, config.databaseUrl);
const db = database(config.databaseUrl);
try {
  const identity = await db.query("SELECT current_user AS role");
  if (identity.rows[0].role !== "soldbench_migrator") throw new Error("deployment_migrator_role_required");
  const applied = await migrate(db);
  await db.query(await readFile(new URL("../infra/db/runtime-grants.sql", import.meta.url), "utf8"));
  console.log(JSON.stringify({ applied, runtimeGrants: "applied" }));
} finally {
  await db.end();
}
