import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApp } from "@soldbench/api";
import { database, migrate, transaction } from "@soldbench/db";
import { decryptImageSourceUrl, encryptImageSourceUrl } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";

test("PG16 empty migration, old-version upgrade, restart idempotency and original relational constraints", async () => {
  const db = database(process.env.DATABASE_URL);
  try {
    assert.match((await db.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.deepEqual(await migrate(db, "0001_baseline.sql"), ["0001_baseline.sql"]);
    await db.query(
      "INSERT INTO users(email,password_hash) VALUES('migration@example.test','fixture-not-a-real-password')",
    );
    assert.deepEqual(await migrate(db, "0002_primary_images.sql"), ["0002_primary_images.sql"]);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM users WHERE email='migration@example.test'")).rows[0].n,
      1,
    );
    await db.query(
      "INSERT INTO source_clearances(id,provider,dataset,revision,status) VALUES($1,'fixture','media-migration',1,'draft')",
      ["00000000-0000-0000-0000-000000000001"],
    );
    await db.query(
      "INSERT INTO sources(id,source_clearance_id,marketplace,access_method,collector_version,entrypoint_id,status) VALUES($1,$2,'ebay_us','offline_fixture','test','fixture','disabled')",
      ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000001"],
    );
    await db.query(
      "INSERT INTO collector_configs(id,source_id,collector_version,allowed_entrypoints,access_method,rate_cap,concurrency_cap,max_pages,max_bytes_per_job) VALUES($1,$2,'test','[]','offline_fixture',1,1,1,100)",
      ["00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000002"],
    );
    await db.query(
      "INSERT INTO collector_runs(id,source_id,config_id,query_hash,collector_version,parser_version,permission_snapshot_hash,started_at) VALUES($1,$2,$3,'h','test','test','fixture',now())",
      [
        "00000000-0000-0000-0000-000000000004",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000003",
      ],
    );
    await db.query(
      "INSERT INTO source_observations(id,source_id,collector_run_id,captured_at,raw_hash,parser_version,record_count,permitted_visibility) VALUES($1,$2,$3,now(),'h','test',0,'{}')",
      [
        "00000000-0000-0000-0000-000000000005",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000004",
      ],
    );
    await db.query(
      "INSERT INTO sold_listings(id,source_id,marketplace,external_listing_id,first_seen_at,last_seen_at) VALUES($1,$2,'ebay_us','fixture-item',now(),now())",
      ["00000000-0000-0000-0000-000000000006", "00000000-0000-0000-0000-000000000002"],
    );
    await db.query(
      "INSERT INTO sale_events(id,listing_id,source_id,observation_id,event_identity_status,sold_date_precision,sale_format,sale_price_status,observed_shipping_status,currency,first_seen_at) VALUES($1,$2,$3,$4,'uncertain','unknown','unknown','unknown','unknown','USD',now())",
      [
        "00000000-0000-0000-0000-000000000007",
        "00000000-0000-0000-0000-000000000006",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000005",
      ],
    );
    await db.query(
      "INSERT INTO listing_images(id,listing_id,source_id,observation_id,sale_event_id,source_url,state,permission_epoch) VALUES($1,$2,$3,$4,$5,'https://images.example.test/signed?token=fixture','missing',1)",
      [
        "00000000-0000-0000-0000-000000000008",
        "00000000-0000-0000-0000-000000000006",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000005",
        "00000000-0000-0000-0000-000000000007",
      ],
    );
    await assert.rejects(
      db.query(
        "INSERT INTO listing_images(listing_id,source_id,observation_id,sale_event_id,state,permission_epoch) VALUES($1,$2,$3,$4,'missing',1)",
        [
          "00000000-0000-0000-0000-000000000006",
          "00000000-0000-0000-0000-000000000002",
          "00000000-0000-0000-0000-000000000005",
          "00000000-0000-0000-0000-000000000004",
        ],
      ),
    );
    assert.deepEqual(await migrate(db, "0003_image_source_url_ciphertext.sql"), [
      "0003_image_source_url_ciphertext.sql",
    ]);
    await assert.rejects(migrate(db), /run npm run db:encrypt-image-urls/);
    assert.equal(
      (await db.query("SELECT source_url FROM listing_images")).rows[0].source_url,
      "https://images.example.test/signed?token=fixture",
    );
    const sourceUrl = "https://images.example.test/signed?token=fixture";
    const imageUrlKey = Buffer.alloc(32, 7).toString("base64");
    const ciphertext = encryptImageSourceUrl(sourceUrl, "00000000-0000-0000-0000-000000000008", imageUrlKey);
    await db.query("UPDATE listing_images SET source_url_ciphertext=$2, source_url=NULL WHERE id=$1", [
      "00000000-0000-0000-0000-000000000008",
      ciphertext,
    ]);
    assert.deepEqual(await migrate(db, "0004_image_rights_hardening.sql"), [
      "0004_image_rights_hardening.sql",
    ]);
    assert.deepEqual(await migrate(db, "0005_collector_pipeline.sql"), ["0005_collector_pipeline.sql"]);
    assert.deepEqual(await migrate(db, "0006_collector_fixture_artifact.sql"), [
      "0006_collector_fixture_artifact.sql",
    ]);
    assert.deepEqual(await migrate(db, "0007_collector_quarantine.sql"), ["0007_collector_quarantine.sql"]);
    assert.deepEqual(await migrate(db, "0008_collector_html_evidence.sql"), [
      "0008_collector_html_evidence.sql",
    ]);
    assert.deepEqual(await migrate(db, "0009_auth_access.sql"), ["0009_auth_access.sql"]);
    assert.deepEqual(await migrate(db, "0010_query_billing.sql"), ["0010_query_billing.sql"]);
    assert.deepEqual(await migrate(db, "0011_collector_image_retries.sql"), [
      "0011_collector_image_retries.sql",
    ]);
    assert.deepEqual(await migrate(db, "0012_collector_shared_backoff.sql"), [
      "0012_collector_shared_backoff.sql",
    ]);
    assert.deepEqual(await migrate(db, "0013_collector_refresh_plans.sql"), [
      "0013_collector_refresh_plans.sql",
    ]);
    assert.deepEqual(await migrate(db, "0014_collector_refresh_retirement.sql"), [
      "0014_collector_refresh_retirement.sql",
    ]);
    assert.deepEqual(await migrate(db, "0015_collector_daily_budget_policy.sql"), [
      "0015_collector_daily_budget_policy.sql",
    ]);
    assert.deepEqual(await migrate(db, "0016_collector_budget_binding.sql"), [
      "0016_collector_budget_binding.sql",
    ]);
    assert.deepEqual(await migrate(db, "0017_query_request_audit.sql"), ["0017_query_request_audit.sql"]);
    assert.deepEqual(await migrate(db, "0018_offline_payment_lifecycle.sql"), [
      "0018_offline_payment_lifecycle.sql",
    ]);
    assert.deepEqual(await migrate(db, "0019_offline_public_results.sql"), [
      "0019_offline_public_results.sql",
    ]);
    assert.deepEqual(await migrate(db, "0020_account_deletion_processing.sql"), [
      "0020_account_deletion_processing.sql",
    ]);
    assert.deepEqual(await migrate(db, "0021_offline_operations.sql"), ["0021_offline_operations.sql"]);
    assert.deepEqual(await migrate(db), ["0022_media_store_ownership.sql"]);
    assert.deepEqual(await migrate(db), []);
    const mediaColumns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='listing_images'",
    );
    const mediaColumnNames = mediaColumns.rows.map((row) => row.column_name);
    assert.equal(mediaColumnNames.includes("source_url"), false);
    assert.equal(mediaColumnNames.includes("source_url_ciphertext"), true);
    assert.equal(
      decryptImageSourceUrl(
        (
          await db.query("SELECT source_url_ciphertext FROM listing_images WHERE id=$1", [
            "00000000-0000-0000-0000-000000000008",
          ])
        ).rows[0].source_url_ciphertext,
        "00000000-0000-0000-0000-000000000008",
        imageUrlKey,
      ),
      sourceUrl,
    );
    const mediaStateConstraint = await db.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='listing_images'::regclass AND conname='listing_images_state_check'",
    );
    assert.match(mediaStateConstraint.rows[0].definition, /not_permitted/);
    const sql = readFileSync(new URL("../docs/contracts/verify.sql", import.meta.url), "utf8").replace(
      /^\\set[^\n]*\n/m,
      "",
    );
    await db.query(sql);
    assert.deepEqual(await migrate(db), []);
    const tables = await db.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
    );
    assert.equal(tables.rows[0].n, 70);
    await assert.rejects(
      transaction(db, async (c) => {
        await c.query("INSERT INTO users(email,password_hash) VALUES('rollback@example.test','fixture')");
        throw new Error("failure");
      }),
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM users WHERE email='rollback@example.test'")).rows[0].n,
      0,
    );
    const app = createApp(loadConfig({}), db);
    assert.equal((await app.request("/ready")).status, 200);
    const page = await app.request("/zh-CN");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /商品|成交/);
    const invalid = await app.request("/v1/sold?q=x&limit=201");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "invalid_parameter");
    assert.equal((await app.request("/v1/sold?q=x")).status, 401);
    assert.equal((await app.request("/missing")).status, 404);
  } finally {
    await db.end();
  }
});
