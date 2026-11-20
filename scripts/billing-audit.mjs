import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { assertLocalDatabaseUrl, database, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

// Every group reads the same database snapshot. Reports exclude customer IDs and amounts.
const checks = `
WITH wallet_balance AS (
  SELECT w.id FROM credit_wallets w LEFT JOIN credit_ledger l ON l.wallet_id=w.id
  GROUP BY w.id HAVING w.balance<>coalesce(sum(l.delta),0)
), grant_ledger AS (
  SELECT g.id FROM credit_grants g LEFT JOIN credit_ledger l ON l.grant_id=g.id AND l.kind='grant'
  GROUP BY g.id HAVING count(l.id)<>1 OR sum(l.delta) IS DISTINCT FROM g.amount::bigint
), query_charge AS (
  SELECT q.id FROM queries q LEFT JOIN billing_charges b ON b.query_id=q.id AND b.user_id=q.user_id
  WHERE (q.settlement_status IN ('charged','refunded') AND b.state IS DISTINCT FROM q.settlement_status)
    OR (q.settlement_status IN ('pending','not_required') AND b.id IS NOT NULL)
), charge_ledger AS (
  SELECT b.id FROM billing_charges b
  LEFT JOIN credit_ledger c ON c.charge_id=b.id AND c.kind='consume'
  LEFT JOIN credit_ledger f ON f.charge_id=b.id AND f.kind='refund'
  WHERE c.id IS NULL OR c.delta<>-b.charged_credits OR c.ref_type<>'query' OR c.ref_id<>b.query_id::text
    OR (b.state='charged' AND (f.id IS NOT NULL OR b.refunded_at IS NOT NULL))
    OR (b.state='refunded' AND (f.id IS NULL OR b.refunded_at IS NULL
      OR f.delta<>b.charged_credits OR f.refund_of IS DISTINCT FROM c.id
      OR f.ref_type<>'query' OR f.ref_id<>b.query_id::text))
), retained_result_hash AS (
  SELECT b.id FROM billing_charges b JOIN query_results r ON r.query_id=b.query_id
  WHERE b.result_hash IS DISTINCT FROM r.candidate_set_hash
)
SELECT
  (SELECT count(*) FROM credit_wallets) AS wallets,
  (SELECT count(*) FROM credit_grants) AS grants,
  (SELECT count(*) FROM billing_charges) AS charges,
  (SELECT count(*) FROM credit_ledger) AS ledger_entries,
  (SELECT count(*) FROM wallet_balance) AS wallet_balance,
  (SELECT count(*) FROM grant_ledger) AS grant_ledger,
  (SELECT count(*) FROM query_charge) AS query_charge,
  (SELECT count(*) FROM charge_ledger) AS charge_ledger,
  (SELECT count(*) FROM retained_result_hash) AS retained_result_hash
`;

const tables = [
  "credit_wallets",
  "credit_grants",
  "credit_ledger",
  "billing_charges",
  "payments",
  "credit_recoveries",
];

async function financialDigest(c) {
  const digest = createHash("sha256").update("soldbench.billing-audit.financial.v1\n");
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  for (const table of tables) {
    digest.update(`table:${table}\n`);
    await c.query(
      `DECLARE audit_rows NO SCROLL CURSOR FOR SELECT to_jsonb(r)::text AS body FROM ${table} r ORDER BY id`,
    );
    for (;;) {
      const { rows } = await c.query("FETCH FORWARD 512 FROM audit_rows");
      if (!rows.length) break;
      for (const { body } of rows) digest.update(`${Buffer.byteLength(body)}:`).update(body);
    }
    await c.query("CLOSE audit_rows");
    digest.update("\n");
  }
  return digest.digest("hex");
}

async function run() {
  const [anchor, ...extra] = process.argv.slice(2);
  const expected = /^--expect-sha256=([0-9a-f]{64})$/.exec(anchor ?? "")?.[1];
  if (extra.length || (anchor !== undefined && !expected)) throw new Error("usage_billing_audit");
  const config = loadConfig(process.env);
  const url = config.databaseUrl ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  const db = database(url);
  try {
    const { wallets, grants, charges, ledger_entries, financial_sha256, ...differences } = await transaction(
      db,
      async (c) => {
        await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const { rows } = await c.query(checks);
        return { ...rows[0], financial_sha256: await financialDigest(c) };
      },
    );
    const expected_snapshot_matches = expected ? expected === financial_sha256 : null;
    const matched =
      expected_snapshot_matches !== false && Object.values(differences).every((count) => count === "0");
    console.log(
      JSON.stringify({
        schema: "soldbench.billing-audit.v1",
        data_mode: config.dataMode,
        outcome: matched ? "matched" : "differences_found",
        counts: { wallets, grants, charges, ledger_entries },
        financial_sha256,
        expected_snapshot_matches,
        differences,
      }),
    );
    if (!matched) process.exitCode = 2;
  } finally {
    await db.end();
  }
}

try {
  await run();
} catch {
  console.error(JSON.stringify({ error: "billing_audit_failed" }));
  process.exitCode = 1;
}
