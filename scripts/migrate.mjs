import { resolve } from "node:path";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { localDatabaseUrl } from "./local-db.mjs";

const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url);
const through = process.argv[2];
try {
  console.log(JSON.stringify({ applied: await migrate(db, through) }));
} finally {
  await db.end();
}
