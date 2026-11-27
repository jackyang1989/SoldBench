import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { database } from "@soldbench/db";
import { decryptImageSourceUrl, encryptImageSourceUrl } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL is required; refusing to guess a database");
assertAllowedDatabaseUrl(loadConfig(process.env), dbUrl);
const file = process.env.SOURCE_URL_ENCRYPTION_KEY_FILE;
let key = process.env.SOURCE_URL_ENCRYPTION_KEY;
if (file !== undefined) {
  if (key !== undefined || !isAbsolute(file)) throw new Error("invalid_source_url_key_reference");
  try {
    key = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Error("source_url_key_file_unavailable");
  }
}
if (!key || (process.env.NODE_ENV === "production" && !file))
  throw new Error("source_url_key_reference_required");
// Uses the exact media codec validation before opening a connection.
encryptImageSourceUrl("", "key-validation", key);
const batchSize = 100;
const db = database(dbUrl);
const client = await db.connect();
let encrypted = 0;
async function verifyCiphertexts() {
  const result = await client.query(
    "SELECT id, source_url_ciphertext FROM listing_images WHERE source_url_ciphertext IS NOT NULL ORDER BY id",
  );
  for (const row of result.rows) decryptImageSourceUrl(row.source_url_ciphertext, row.id, key);
  return result.rowCount;
}
try {
  await client.query("SELECT pg_advisory_lock(hashtext('soldbench:image-url-encryption-backfill'))");
  // Resume only if the configured key can authenticate all previously migrated rows.
  await verifyCiphertexts();
  const initial = Number(
    (await client.query("SELECT count(*)::bigint AS n FROM listing_images WHERE source_url IS NOT NULL"))
      .rows[0].n,
  );
  while (true) {
    await client.query("BEGIN");
    let count = 0;
    try {
      const rows = await client.query(
        "SELECT id, source_url FROM listing_images WHERE source_url IS NOT NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED",
        [batchSize],
      );
      for (const row of rows.rows) {
        const ciphertext = encryptImageSourceUrl(row.source_url, row.id, key);
        if (decryptImageSourceUrl(ciphertext, row.id, key) !== row.source_url)
          throw new Error(`Image URL encryption verification failed for row ${row.id}`);
        await client.query(
          "UPDATE listing_images SET source_url_ciphertext=$2, source_url=NULL WHERE id=$1",
          [row.id, ciphertext],
        );
      }
      count = rows.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    encrypted += count;
    if (count === 0) break;
  }

  const verified = await verifyCiphertexts();
  const remaining = Number(
    (await client.query("SELECT count(*)::bigint AS n FROM listing_images WHERE source_url IS NOT NULL"))
      .rows[0].n,
  );
  if (remaining !== 0) throw new Error(`Backfill incomplete: ${remaining} cleartext image URLs remain`);
  console.log(
    JSON.stringify({
      initialCleartextRows: initial,
      encryptedThisRun: encrypted,
      authenticatedCiphertextsVerified: verified,
      cleartextRowsRemaining: remaining,
    }),
  );
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext('soldbench:image-url-encryption-backfill'))");
  } finally {
    client.release();
    await db.end();
  }
}
