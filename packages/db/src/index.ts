import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Database = pg.Pool;
export type Transaction = pg.PoolClient;
export function database(url: string): Database {
  return new pg.Pool({
    connectionString: url,
    max: 20,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: "soldbench",
  });
}
export async function transaction<T>(db: Database, work: (client: Transaction) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(db: Database, through?: string): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS soldbench_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    // Compiled index is in dist while migrations remain beside src.
    const migrationNames = readdirSync(directory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    if (through && !migrationNames.includes(through))
      throw new Error(`Unknown migration boundary: ${through}`);
    for (const name of migrationNames) {
      if (through && name > through) break;
      const raw = readFileSync(directory + name, "utf8");
      const hash = createHash("sha256").update(raw).digest("hex");
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM soldbench_migrations WHERE name=$1",
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== hash) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      const sql = raw.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO soldbench_migrations(name,sha256) VALUES($1,$2)", [name, hash]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(name);
    }
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('soldbench:migrations'))");
    } finally {
      client.release();
    }
  }
}
