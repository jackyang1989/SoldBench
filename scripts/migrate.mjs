import { database, migrate } from "@soldbench/db";
import { localDatabaseUrl } from "./local-db.mjs";

const db = database(process.env.DATABASE_URL ?? localDatabaseUrl());
const through = process.argv[2];
try {
  console.log(JSON.stringify({ applied: await migrate(db, through) }));
} finally {
  await db.end();
}
