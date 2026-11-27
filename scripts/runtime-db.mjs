import { assertRuntimeDatabaseUrl } from "@soldbench/db";

/**
 * Enforces local loopback/socket PostgreSQL URLs while in offline development mode, and
 * validates explicit remote/managed PostgreSQL URLs only when `SOLDBENCH_LIVE_GATE_ACKNOWLEDGED=true`.
 */
export function assertAllowedDatabaseUrl(config, url) {
  assertRuntimeDatabaseUrl(url, config, process.env.SOLDBENCH_TEST_SOCKET);
}
