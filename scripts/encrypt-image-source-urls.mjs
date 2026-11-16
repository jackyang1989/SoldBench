import { database } from "@soldbench/db";
import { decryptImageSourceUrl, encryptImageSourceUrl } from "@soldbench/media";

const dbUrl = process.env.DATABASE_URL;
const key = process.env.SOURCE_URL_ENCRYPTION_KEY;
if (!dbUrl) throw new Error("DATABASE_URL is required; refusing to guess a database");
if (!key)
  throw new Error("SOURCE_URL_ENCRYPTION_KEY is required; provide a KMS-managed 32-byte key as base64");
const batchSize = 100;
const db = database(dbUrl);
const client = await db.connect();
let encrypted = 0;
try {
  await client.query("SELECT pg_advisory_lock(hashtext('soldbench:image-url-encryption-backfill'))");
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

  const cipherRows = await client.query(
    "SELECT id, source_url_ciphertext FROM listing_images WHERE source_url_ciphertext IS NOT NULL ORDER BY id",
  );
  for (const row of cipherRows.rows) decryptImageSourceUrl(row.source_url_ciphertext, row.id, key);
  const remaining = Number(
    (await client.query("SELECT count(*)::bigint AS n FROM listing_images WHERE source_url IS NOT NULL"))
      .rows[0].n,
  );
  if (remaining !== 0) throw new Error(`Backfill incomplete: ${remaining} cleartext image URLs remain`);
  console.log(
    JSON.stringify({
      initialCleartextRows: initial,
      encryptedThisRun: encrypted,
      authenticatedCiphertextsVerified: cipherRows.rowCount,
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
