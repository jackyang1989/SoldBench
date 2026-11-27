import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Database = pg.Pool;
export type Transaction = pg.PoolClient;
export type DatabaseStartupMode = "migrate" | "verify";
type DeploymentRuntimeRole = "soldbench_runtime" | "soldbench_collector";
const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

function migrationNames() {
  return readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

function migrationContent(name: string) {
  const raw = readFileSync(migrationDirectory + name, "utf8");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}
const connectionCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "08000",
  "08001",
  "08003",
  "08006",
  "08007",
]);
const driverConnectionMessages = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error and is not queryable",
]);

export function isDatabaseConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && typeof error.code === "string" && connectionCodes.has(error.code)) ||
      ("code" in error && error.code === "ENOENT" && "syscall" in error && error.syscall === "connect") ||
      driverConnectionMessages.has(error.message))
  );
}

export function database(url: string): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 20,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: "soldbench",
  });
  // pg removes the failed idle client before emitting this event.
  pool.on("error", () => console.error("soldbench_database_idle_client_error"));
  return pool;
}
export async function transaction<T>(db: Database, work: (client: Transaction) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
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
    const names = migrationNames();
    if (through && !names.includes(through)) throw new Error(`Unknown migration boundary: ${through}`);
    for (const name of names) {
      if (through && name > through) break;
      const { raw, hash } = migrationContent(name);
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

/** Runtime startup can verify the pre-migrated schema without DDL, locks, or migration privileges. */
export async function prepareDatabase(
  db: Database,
  mode: DatabaseStartupMode,
  role?: DeploymentRuntimeRole,
): Promise<void> {
  if (role && mode !== "verify") throw new Error("deployment_runtime_requires_verify_mode");
  if (mode === "migrate") {
    await migrate(db);
    return;
  }
  if (mode !== "verify") throw new Error("invalid_database_startup_mode");
  const { rows } = await db
    .query<{ name: string; sha256: string }>("SELECT name,sha256 FROM soldbench_migrations ORDER BY name")
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "42P01")
        throw new Error("database_schema_not_initialized");
      throw error;
    });
  const installed = new Map(rows.map(({ name, sha256 }) => [name, sha256]));
  for (const name of migrationNames()) {
    if (!installed.has(name)) throw new Error(`Missing database migration: ${name}`);
    if (installed.get(name) !== migrationContent(name).hash)
      throw new Error(`Applied migration changed: ${name}`);
    installed.delete(name);
  }
  if (installed.size) throw new Error("database_schema_newer_or_unknown");
  if (role) {
    const {
      rows: [identity],
    } = await db.query<{ allowed: boolean }>(
      `SELECT current_user=$1 AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls
        OR r.rolreplication) AND NOT has_schema_privilege(current_user,'public','CREATE')
        AND NOT has_database_privilege(current_user,current_database(),'CREATE')
        AND NOT has_table_privilege(current_user,'public.soldbench_migrations','INSERT, UPDATE, DELETE, TRUNCATE')
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid) AS allowed
        FROM pg_roles r WHERE r.rolname=current_user`,
      [role],
    );
    if (!identity?.allowed) throw new Error("deployment_runtime_role_invalid");
  }
}

/** Retry transient database connections for long-running processes during startup. */
export async function prepareRuntimeDatabase(
  db: Database,
  mode: DatabaseStartupMode,
  signal: AbortSignal,
  onUnavailable: () => void,
  role?: DeploymentRuntimeRole,
): Promise<void> {
  const delays = [1000, 2000, 4000, 8000, 10000];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      await prepareDatabase(db, mode, role);
      signal.throwIfAborted();
      return;
    } catch (error) {
      if (!isDatabaseConnectionError(error) || attempt === delays.length) throw error;
      signal.throwIfAborted();
      if (attempt === 0) onUnavailable();
    }
    await delay(delays[attempt], undefined, { signal });
  }
}

/** Parse exactly as the PG client will, before any connect/DNS call. Used only
 * by offline local tooling; product database() retains its deployment contract. */
export function assertLocalDatabaseUrl(url: string, allowedSocketDirectories: readonly string[] = []): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid_local_database_url");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("invalid_local_database_url");
  for (const key of parsed.searchParams.keys()) {
    if (!["host", "port"].includes(key) || parsed.searchParams.getAll(key).length !== 1)
      throw new Error("database_connection_override_not_allowed");
  }
  let client: pg.Client;
  try {
    client = new pg.Client({ connectionString: url });
  } catch {
    throw new Error("invalid_local_database_url");
  }
  const host = client.host;
  const localTcp = ["localhost", "127.0.0.1", "::1"].includes(host);
  const localSocket =
    isAbsolute(host) &&
    allowedSocketDirectories.some((directory) => isAbsolute(directory) && resolve(directory) === host);
  if (!localTcp && !localSocket) throw new Error("database_target_must_be_local");
  if (!Number.isSafeInteger(client.port) || client.port < 1 || client.port > 65535)
    throw new Error("invalid_local_database_port");
}

export function assertRuntimeDatabaseUrl(
  url: string,
  config: { liveGateAcknowledged: boolean; isolatedDeployment: boolean },
  testSocketDirectory?: string,
): void {
  if (config.liveGateAcknowledged) {
    if (!["postgres:", "postgresql:"].includes(new URL(url).protocol))
      throw new Error("Invalid DATABASE_URL");
    return;
  }
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(config.isolatedDeployment ? ["/run/soldbench/postgres"] : []),
    ...(testSocketDirectory ? [testSocketDirectory] : []),
  ]);
}
