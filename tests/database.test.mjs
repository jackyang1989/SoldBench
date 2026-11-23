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
    assert.deepEqual(await migrate(db, "0022_media_store_ownership.sql"), ["0022_media_store_ownership.sql"]);
    assert.deepEqual(await migrate(db, "0023_offline_site_content.sql"), ["0023_offline_site_content.sql"]);
    assert.deepEqual(await migrate(db, "0024_query_worker_heartbeat.sql"), [
      "0024_query_worker_heartbeat.sql",
    ]);
    assert.deepEqual(await migrate(db, "0025_site_content_schedule.sql"), ["0025_site_content_schedule.sql"]);
    assert.deepEqual(await migrate(db, "0026_support_case_workflow.sql"), ["0026_support_case_workflow.sql"]);
    const legacyContent = await db.query(
      "INSERT INTO site_content_entries(kind,slug,updated_at) VALUES('guide','legacy-guide',now()) RETURNING id",
    );
    const entry = legacyContent.rows[0].id;
    const content = {
      en: { title: "Legacy guide", body: "Retained" },
      "zh-CN": { title: "旧指南", body: "保留" },
    };
    await db.query(
      "INSERT INTO site_content_revisions(entry_id,revision,body,state,created_at) VALUES($1,1,$2,'approved',now())",
      [entry, content],
    );
    await db.query(
      "UPDATE site_content_entries SET latest_revision=1,published_revision=1,published_at=now(),version=1 WHERE id=$1",
      [entry],
    );
    assert.deepEqual(await migrate(db, "0027_site_content_types.sql"), ["0027_site_content_types.sql"]);
    assert.deepEqual(
      (await db.query("SELECT body,metadata FROM site_content_revisions WHERE entry_id=$1", [entry])).rows,
      [{ body: content, metadata: {} }],
    );
    assert.equal(
      (await db.query("SELECT published_revision FROM site_content_entries WHERE id=$1", [entry])).rows[0]
        .published_revision,
      1,
    );
    assert.deepEqual(await migrate(db, "0028_saved_research.sql"), ["0028_saved_research.sql"]);
    assert.deepEqual(await migrate(db, "0029_operations_workbench.sql"), ["0029_operations_workbench.sql"]);
    assert.deepEqual(await migrate(db, "0030_operator_alert_settings.sql"), [
      "0030_operator_alert_settings.sql",
    ]);
    assert.deepEqual(await migrate(db, "0031_offline_auth_mail_delivery.sql"), [
      "0031_offline_auth_mail_delivery.sql",
    ]);
    assert.deepEqual(await migrate(db, "0032_collector_supervisor_state.sql"), [
      "0032_collector_supervisor_state.sql",
    ]);
    assert.deepEqual(await migrate(db, "0033_collector_detail_jobs.sql"), ["0033_collector_detail_jobs.sql"]);
    assert.deepEqual(await migrate(db, "0034_batch_queries.sql"), ["0034_batch_queries.sql"]);
    assert.deepEqual(await migrate(db, "0035_archive_history.sql"), ["0035_archive_history.sql"]);
    assert.deepEqual(await migrate(db, "0036_best_offer_verifications.sql"), [
      "0036_best_offer_verifications.sql",
    ]);
    assert.deepEqual(await migrate(db, "0037_oauth_passkeys.sql"), ["0037_oauth_passkeys.sql"]);
    assert.deepEqual(await migrate(db, "0038_alerts_webhooks.sql"), ["0038_alerts_webhooks.sql"]);
    assert.deepEqual(await migrate(db, "0039_lookup_inputs.sql"), ["0039_lookup_inputs.sql"]);
    assert.deepEqual(await migrate(db, "0040_inventory_valuations.sql"), ["0040_inventory_valuations.sql"]);
    assert.deepEqual(await migrate(db, "0041_regional_sites.sql"), ["0041_regional_sites.sql"]);
    assert.deepEqual(await migrate(db, "0042_second_marketplace.sql"), ["0042_second_marketplace.sql"]);
    assert.deepEqual(await migrate(db, "0043_cards_grading_vertical.sql"), [
      "0043_cards_grading_vertical.sql",
    ]);
    assert.deepEqual(await migrate(db, "0044_auction_sales_vertical.sql"), [
      "0044_auction_sales_vertical.sql",
    ]);
    assert.deepEqual(await migrate(db, "0045_global_ebay_sites.sql"), ["0045_global_ebay_sites.sql"]);
    assert.deepEqual(await migrate(db), ["0046_promo_offers.sql"]);
    assert.deepEqual(await migrate(db), []);
    const detailConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid='collector_detail_jobs'::regclass ORDER BY conname",
    );
    assert.ok(detailConstraints.rows.some((r) => r.conname === "collector_detail_jobs_status_check"));
    assert.ok(detailConstraints.rows.some((r) => r.conname === "collector_detail_jobs_check1"));
    const batchConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('batch_queries'::regclass, 'batch_query_items'::regclass) ORDER BY conname",
    );
    assert.ok(batchConstraints.rows.some((r) => r.conname === "batch_queries_status_check"));
    assert.ok(batchConstraints.rows.some((r) => r.conname === "batch_query_items_submit_status_check"));
    const archiveConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('archive_coverage_spans'::regclass, 'sale_events'::regclass) ORDER BY conname",
    );
    assert.ok(archiveConstraints.rows.some((r) => r.conname === "archive_coverage_spans_completeness_check"));
    assert.ok(
      archiveConstraints.rows.some((r) => r.conname === "sale_events_listing_aggregation_kind_check"),
    );
    const bestOfferConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('best_offer_verifications'::regclass, 'query_evidence_revisions'::regclass) ORDER BY conname",
    );
    assert.ok(bestOfferConstraints.rows.some((r) => r.conname === "best_offer_verifications_status_check"));
    assert.ok(
      bestOfferConstraints.rows.some((r) => r.conname === "best_offer_verifications_credit_policy_check"),
    );
    assert.ok(
      bestOfferConstraints.rows.some((r) => r.conname === "query_evidence_revisions_trigger_kind_check"),
    );
    assert.ok(
      bestOfferConstraints.rows.some((r) => r.conname === "query_evidence_revisions_credits_charged_check"),
    );
    const oauthPasskeyConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('oauth_clients'::regclass, 'oauth_authorization_codes'::regclass, 'oauth_tokens'::regclass, 'user_passkeys'::regclass) ORDER BY conname",
    );
    assert.ok(oauthPasskeyConstraints.rows.some((r) => r.conname === "oauth_clients_client_type_check"));
    assert.ok(
      oauthPasskeyConstraints.rows.some(
        (r) => r.conname === "oauth_authorization_codes_code_challenge_method_check",
      ),
    );
    assert.ok(oauthPasskeyConstraints.rows.some((r) => r.conname === "oauth_tokens_scopes_check"));
    assert.ok(oauthPasskeyConstraints.rows.some((r) => r.conname === "user_passkeys_algorithm_check"));
    const alertConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('watchlists'::regclass, 'webhook_endpoints'::regclass, 'webhook_deliveries'::regclass) ORDER BY conname",
    );
    assert.ok(alertConstraints.rows.some((r) => r.conname === "watchlists_schedule_mode_check"));
    assert.ok(alertConstraints.rows.some((r) => r.conname === "watchlists_trigger_kind_check"));
    assert.ok(alertConstraints.rows.some((r) => r.conname === "webhook_endpoints_event_types_check"));
    assert.ok(alertConstraints.rows.some((r) => r.conname === "webhook_deliveries_status_check"));
    const lookupConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('lookup_sessions'::regclass, 'lookup_candidates'::regclass) ORDER BY conname",
    );
    assert.ok(lookupConstraints.rows.some((r) => r.conname === "lookup_sessions_input_kind_check"));
    assert.ok(lookupConstraints.rows.some((r) => r.conname === "lookup_sessions_status_check"));
    assert.ok(lookupConstraints.rows.some((r) => r.conname === "lookup_candidates_confidence_check"));
    const inventoryConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('inventory_valuations'::regclass, 'inventory_valuation_items'::regclass) ORDER BY conname",
    );
    assert.ok(inventoryConstraints.rows.some((r) => r.conname === "inventory_valuations_status_check"));
    assert.ok(
      inventoryConstraints.rows.some((r) => r.conname === "inventory_valuation_items_mapping_status_check"),
    );
    const regionalConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('marketplace_sites'::regclass, 'fx_rate_snapshots'::regclass, 'regional_site_records'::regclass, 'sources'::regclass) ORDER BY conname",
    );
    assert.ok(regionalConstraints.rows.some((r) => r.conname === "sources_marketplace_check"));
    assert.ok(regionalConstraints.rows.some((r) => r.conname === "marketplace_sites_status_check"));
    assert.ok(regionalConstraints.rows.some((r) => r.conname === "fx_rate_snapshots_rate_micros_check"));
    assert.ok(
      regionalConstraints.rows.some((r) => r.conname === "regional_site_records_shipping_status_check"),
    );
    const secondMarketplaceConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('second_marketplace_catalog'::regclass, 'second_marketplace_records'::regclass) ORDER BY conname",
    );
    assert.ok(
      secondMarketplaceConstraints.rows.some(
        (r) => r.conname === "second_marketplace_catalog_selection_status_check",
      ),
    );
    assert.ok(
      secondMarketplaceConstraints.rows.some(
        (r) => r.conname === "second_marketplace_records_listing_state_check",
      ),
    );
    const cardsConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('card_products'::regclass, 'card_sale_records'::regclass, 'card_grading_populations'::regclass) ORDER BY conname",
    );
    assert.ok(cardsConstraints.rows.some((r) => r.conname === "card_products_edition_check"));
    assert.ok(cardsConstraints.rows.some((r) => r.conname === "card_sale_records_grading_state_check"));
    assert.ok(cardsConstraints.rows.some((r) => r.conname === "card_grading_populations_pop_count_check"));
    const auctionConstraints = await db.query(
      "SELECT conname FROM pg_constraint WHERE conrelid IN ('auction_house_catalog'::regclass, 'auction_sessions'::regclass, 'auction_lot_records'::regclass) ORDER BY conname",
    );
    assert.ok(
      auctionConstraints.rows.some((r) => r.conname === "auction_house_catalog_selection_status_check"),
    );
    assert.ok(
      auctionConstraints.rows.some((r) => r.conname === "auction_lot_records_buyers_premium_status_check"),
    );
    assert.ok(auctionConstraints.rows.some((r) => r.conname === "auction_lot_records_sale_status_check"));
    const globalSites = await db.query(
      "SELECT site_id, default_currency, status, source_gate_passed, translation_gate_passed, legal_gate_passed, economics_gate_passed FROM marketplace_sites ORDER BY site_id",
    );
    assert.equal(globalSites.rowCount, 8);
    for (const siteId of ["ebay_fr", "ebay_it", "ebay_es", "ebay_ca", "ebay_au"]) {
      const row = globalSites.rows.find((r) => r.site_id === siteId);
      assert.equal(row?.status, "preview_offline");
      assert.equal(row?.source_gate_passed, false);
      assert.equal(row?.translation_gate_passed, false);
      assert.equal(row?.legal_gate_passed, false);
      assert.equal(row?.economics_gate_passed, false);
    }
    const promoCampaigns = await db.query(
      "SELECT code, credits, status, commercial_approved FROM promo_campaigns ORDER BY code",
    );
    assert.equal(promoCampaigns.rowCount, 2);
    assert.equal(promoCampaigns.rows[0].code, "EXPIRED10_PREVIEW");
    assert.equal(promoCampaigns.rows[1].code, "LAUNCH50_PREVIEW");
    assert.equal(promoCampaigns.rows[1].commercial_approved, false);
    const offerVersions = await db.query(
      "SELECT offer_version, status, commercial_approved FROM pricing_offer_versions ORDER BY offer_version",
    );
    assert.equal(offerVersions.rowCount, 6);
    assert.equal(
      offerVersions.rows.every((r) => r.commercial_approved === false),
      true,
    );
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
    assert.equal(tables.rows[0].n, 114);
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
