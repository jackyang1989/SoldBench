import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { merchant, providers } from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const schema = "soldbench.payment-statement.fixture.v1";
const settledStates = ["confirmed", "refunded", "disputed"];
const maxBytes = 4 * 1024 * 1024;
const maxRows = 20_000;
const fields = ["created_at", "state", "amount_cents", "refunded_cents"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const utc = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const cents = (value) => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;

async function statementBytes(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = await file.stat();
    if (!state.isFile() || state.size === 0 || state.size > maxBytes)
      throw new Error("invalid_statement_file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes || size !== state.size) throw new Error("invalid_statement_file");
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

function parseStatement(bytes) {
  let input;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid_statement_json");
  }
  if (
    input?.schema !== schema ||
    !providers.includes(input.provider) ||
    input.environment !== "offline_fixture" ||
    input.merchant !== merchant(input.provider) ||
    input.currency !== "USD" ||
    !utc(input.from) ||
    !utc(input.until) ||
    input.from >= input.until ||
    !Array.isArray(input.payments) ||
    input.payments.length > maxRows
  )
    throw new Error("invalid_statement_scope");
  const expected = new Map();
  for (const row of input.payments) {
    if (
      typeof row?.provider_payment_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(row.provider_payment_id) ||
      !utc(row.created_at) ||
      row.created_at < input.from ||
      row.created_at >= input.until ||
      !settledStates.includes(row.state) ||
      !cents(row.amount_cents) ||
      row.amount_cents === 0 ||
      !cents(row.refunded_cents) ||
      row.refunded_cents > row.amount_cents ||
      (row.state === "refunded" && row.refunded_cents !== row.amount_cents)
    )
      throw new Error("invalid_statement_payment");
    if (expected.has(row.provider_payment_id)) throw new Error("duplicate_statement_payment");
    expected.set(row.provider_payment_id, row);
  }
  return { input, expected };
}

async function localPayments(db, input) {
  return transaction(db, async (client) => {
    await client.query("SET TRANSACTION READ ONLY");
    const { rows } = await client.query(
      `SELECT p.provider_payment_id, p.state, p.created_at, p.amount_cents, p.refunded_cents
       FROM payments p
       JOIN payment_checkout_intents i ON i.id=p.checkout_intent_id AND i.user_id=p.user_id
       WHERE i.environment=$1 AND i.merchant_id=$2 AND i.provider=$3 AND p.provider=i.provider
         AND p.currency=$4 AND p.created_at >= $5 AND p.created_at < $6 AND p.state=ANY($7::text[])
       LIMIT $8`,
      [
        input.environment,
        input.merchant,
        input.provider,
        input.currency,
        input.from,
        input.until,
        settledStates,
        maxRows + 1,
      ],
    );
    if (rows.length > maxRows) throw new Error("statement_range_too_large");
    const actual = new Map();
    for (const row of rows) {
      const amount = Number(row.amount_cents);
      const refund = Number(row.refunded_cents);
      if (!cents(amount) || !cents(refund)) throw new Error("unsupported_local_amount");
      actual.set(row.provider_payment_id, {
        state: row.state,
        created_at: row.created_at.toISOString(),
        amount_cents: amount,
        refunded_cents: refund,
      });
    }
    return actual;
  });
}

function totals(payments) {
  let gross = 0;
  let refunds = 0;
  for (const row of payments.values()) {
    gross += row.amount_cents;
    refunds += row.refunded_cents;
  }
  return { payment_count: payments.size, gross_cents: gross, refunded_cents: refunds };
}

async function run() {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error("usage_payment_reconcile_statement_file");
  const config = loadConfig(process.env);
  if (!config.paymentFixtures) throw new Error("enable_local_payment_fixtures_first");
  const bytes = await statementBytes(file);
  const { input, expected } = parseStatement(bytes);
  const url = config.databaseUrl ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  const db = database(url);
  try {
    const actual = await localPayments(db, input);
    const differences = [];
    for (const id of [...new Set([...actual.keys(), ...expected.keys()])].sort()) {
      const statement = expected.get(id);
      const local = actual.get(id);
      const differingFields =
        statement && local ? fields.filter((field) => statement[field] !== local[field]) : [];
      if (statement && local && !differingFields.length) continue;
      differences.push({
        reference_sha256: digest(id),
        reason: !local ? "missing_locally" : !statement ? "missing_in_statement" : "payment_fields_differ",
        fields: differingFields,
      });
    }
    const outcome = differences.length ? "differences_found" : "matched";
    console.log(
      JSON.stringify({
        outcome,
        scope: "fixture_payment_projection",
        environment: input.environment,
        provider: input.provider,
        currency: input.currency,
        cohort_from: input.from,
        cohort_until: input.until,
        statement_sha256: digest(bytes),
        statement: totals(expected),
        local: totals(actual),
        differences,
        bank_settlement_verified: false,
      }),
    );
    if (differences.length) process.exitCode = 2;
  } finally {
    await db.end();
  }
}

try {
  await run();
} catch (error) {
  const name =
    typeof error?.message === "string" && /^[a-z_]+$/.test(error.message) ? error.message : undefined;
  console.error(JSON.stringify({ error: name ?? "payment_reconciliation_failed" }));
  process.exitCode = 1;
}
