import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("an internally consistent restored backup is rejected against the later financial checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soldbench-finance-backup-"));
  roots.push(dir);
  const file = join(dir, "before.dump");
  const { stdout } = await run("pg_config", ["--bindir"]);
  const bin = stdout.trim();
  const older = JSON.parse((await run(...command)).stdout);
  await run(join(bin, "pg_dump"), ["--format=custom", "--file", file, process.env.DATABASE_URL]);
  await createProductFixture(db, roots, { count: 8, extra: false });
  const current = JSON.parse((await run(...command)).stdout);
  assert.equal(current.outcome, "matched");
  assert.notEqual(current.financial_sha256, older.financial_sha256);
  await db.query("CREATE DATABASE soldbench_recovery_audit_restore");
  try {
    await db.query("ALTER DATABASE soldbench_recovery_audit_restore SET timezone TO 'Pacific/Auckland'");
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = "/soldbench_recovery_audit_restore";
    await run(join(bin, "pg_restore"), ["--exit-on-error", "--dbname", url.href, file]);
    const env = { ...process.env, DATABASE_URL: url.href };
    const [node, args] = command;
    const restored = JSON.parse(
      (await run(node, [...args, `--expect-sha256=${older.financial_sha256}`], { env })).stdout,
    );
    assert.deepEqual(restored, { ...older, expected_snapshot_matches: true });
    await assert.rejects(
      run(node, [...args, `--expect-sha256=${current.financial_sha256}`], { env }),
      (error) => {
        assert.equal(error.code, 2);
        assert.deepEqual(JSON.parse(error.stdout), {
          ...older,
          outcome: "differences_found",
          expected_snapshot_matches: false,
        });
        return true;
      },
    );
  } finally {
    await db.query("DROP DATABASE soldbench_recovery_audit_restore");
  }
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
