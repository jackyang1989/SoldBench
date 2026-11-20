import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { database, migrate } from "@soldbench/db";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];
const run = promisify(execFile);
const command = [process.execPath, ["--import", "./scripts/test-network.mjs", "scripts/billing-audit.mjs"]];
before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
});

test("recovery audit accepts real synthetic charges, refunds and deletion of retained results", async () => {
  const refunded = await createProductFixture(db, roots, { count: 8, extra: false });
  const paid = await createProductFixture(db, roots, { count: 8, extra: false });
  await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin')", [refunded.user]);
  assert.equal(
    await refunded.billing.refundCredit(refunded.user, refunded.queryId, refunded.user, "Synthetic refund"),
    true,
  );
  const baseline = JSON.parse((await run(...command)).stdout);
  assert.equal(baseline.outcome, "matched");
  assert.equal(baseline.counts.charges, "2");
  assert.equal(baseline.counts.ledger_entries, "5");
  await db.query("UPDATE queries SET result_state='forbidden' WHERE id=$1", [paid.queryId]);
  await db.query("DELETE FROM query_results WHERE query_id=$1", [paid.queryId]);
  assert.deepEqual(JSON.parse((await run(...command)).stdout), baseline);
});

test("recovery audit refuses a mismatched grant, charge state, debit or retained result without changing rows", async () => {
  const x = await createProductFixture(db, roots, { count: 8, extra: false, claimed: false });
  const committed = await createProductFixture(db, roots, { count: 8, extra: false });
  await db.query(
    "INSERT INTO billing_charges(query_id,user_id,charged_credits,policy_version,state,result_hash) VALUES($1,$2,1,'fixture','charged',$3)",
    [x.queryId, x.user, "missing-debit"],
  );
  await db.query("UPDATE credit_grants SET amount=amount+1 WHERE user_id=$1", [committed.user]);
  await db.query("UPDATE billing_charges SET result_hash=$2 WHERE query_id=$1", [
    committed.queryId,
    "changed-hash",
  ]);
  const data = async () => (await db.query("SELECT * FROM credit_ledger ORDER BY id")).rows;
  const prior = await data();
  await assert.rejects(run(...command), (error) => {
    assert.equal(error.code, 2);
    const report = JSON.parse(error.stdout);
    assert.equal(report.outcome, "differences_found");
    assert.deepEqual(report.differences, {
      wallet_balance: "0",
      grant_ledger: "1",
      query_charge: "1",
      charge_ledger: "1",
      retained_result_hash: "2",
    });
    assert.ok(!error.stdout.includes(committed.user));
    assert.ok(!error.stdout.includes(x.queryId));
    return true;
  });
  assert.deepEqual(await data(), prior);
});
