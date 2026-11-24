import { resolve } from "node:path";
import { assertLocalDatabaseUrl } from "@soldbench/db";

/**
 * Enforces local loopback/socket PostgreSQL URLs while in offline development mode, and
 * validates explicit remote/managed PostgreSQL URLs only when `SOLDBENCH_LIVE_GATE_ACKNOWLEDGED=true`.
 */
export function assertAllowedDatabaseUrl(config, url) {
  if (!config.liveGateAcknowledged) {
    assertLocalDatabaseUrl(url, [
      resolve(".local/postgres/socket"),
      ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
    ]);
    return;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Invalid DATABASE_URL");
  }
}
