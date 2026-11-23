import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { provisionFixtureSource } from "@soldbench/collector";
import { convertMinorWithFx, mapRegionalCondition, parseRegionalSoldDate } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import {
  assertRegionalCatalogComplete,
  formatRegionalDate,
  formatRegionalMoney,
  loadConfig,
  regionalMessage,
} from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-072 10 regional locales complete, FR/IT/ES/CA/AU condition/date parsing & CAD/AUD/EUR formats", () => {
  assertRegionalCatalogComplete();

  assert.equal(mapRegionalCondition("ebay_fr", "Neuf"), "new_with_tags");
  assert.equal(mapRegionalCondition("ebay_fr", "D'occasion"), "good");
  assert.equal(mapRegionalCondition("ebay_fr", "Pour pièces détachées / ne fonctionne pas"), "defective");
  assert.equal(mapRegionalCondition("ebay_it", "Nuovo"), "new_with_tags");
  assert.equal(mapRegionalCondition("ebay_it", "Usato"), "good");
  assert.equal(mapRegionalCondition("ebay_it", "Per parti di ricambio / non funzionante"), "defective");
  assert.equal(mapRegionalCondition("ebay_es", "Nuevo"), "new_with_tags");
  assert.equal(mapRegionalCondition("ebay_es", "Usado"), "good");
  assert.equal(mapRegionalCondition("ebay_es", "Para piezas o no funciona"), "defective");
  assert.equal(mapRegionalCondition("ebay_ca", "Brand New"), "new_with_tags");
  assert.equal(mapRegionalCondition("ebay_ca", "Occasion"), "good");
  assert.equal(mapRegionalCondition("ebay_au", "Used"), "good");

  assert.deepEqual(parseRegionalSoldDate("ebay_fr", "Vendu le 15 mai 2026"), {
    precision: "day",
    value: "2026-05-15",
    timeZone: "Europe/Paris",
  });
  assert.deepEqual(parseRegionalSoldDate("ebay_it", "Venduto il 15 mag 2026"), {
    precision: "day",
    value: "2026-05-15",
    timeZone: "Europe/Rome",
  });
  assert.deepEqual(parseRegionalSoldDate("ebay_es", "Vendido el 15 de may de 2026"), {
    precision: "day",
    value: "2026-05-15",
    timeZone: "Europe/Madrid",
  });
  assert.deepEqual(parseRegionalSoldDate("ebay_ca", "15 mai 2026"), {
    precision: "day",
    value: "2026-05-15",
    timeZone: "America/Toronto",
  });
  assert.deepEqual(parseRegionalSoldDate("ebay_au", "Sold 15 May 2026"), {
    precision: "day",
    value: "2026-05-15",
    timeZone: "Australia/Sydney",
  });

  assert.match(formatRegionalMoney("fr", 14999, "EUR"), /149,99.*EUR/);
  assert.match(formatRegionalMoney("en-CA", 14999, "CAD"), /CAD.*149\.99/);
  assert.match(formatRegionalMoney("fr-CA", 14999, "CAD"), /149,99.*CAD/);
  assert.match(formatRegionalMoney("en-AU", 14999, "AUD"), /AUD.*149\.99/);
  assert.match(
    formatRegionalDate("fr-CA", "2026-11-21T00:00:00Z", "America/Toronto", "day"),
    /America\/Toronto/,
  );
  assert.match(
    formatRegionalDate("en-AU", "2026-11-21T00:00:00Z", "Australia/Sydney", "day"),
    /Australia\/Sydney/,
  );
  assert.match(
    regionalMessage("fr-CA", "email.verify_body", { url: "https://soldbench.com/v", expiresMinutes: 30 }),
    /30 minutes/,
  );
});

test("AT-072 global sites keep V1.5 backward-compatible, block inherited US clearance, isolate CAD/AUD/EUR & revocation, and serve 6 new HTML locale routes", async () => {
  const x = await createProductFixture(db, roots, { count: 10, limit: 10, claimed: false });
  const app = createApp(loadConfig({}), db, { auth: x.auth, query: x.query });

  // V1.5 `/v1/sites` keeps exactly 3 sites for backward compatibility
  const v15Res = await app.request("/v1/sites");
  assert.equal(v15Res.status, 200);
  assert.deepEqual(
    (await v15Res.json()).data.map((s) => s.site_id),
    ["ebay_us", "ebay_uk", "ebay_de"],
  );
  assert.equal((await app.request("/v1/sites/ebay_fr/localization")).status, 400);

  // V2 `/v1/global-sites` lists all 8 sites with FR/IT/ES/CA/AU offline preview & 4 false gates
  const v2Res = await app.request("/v1/global-sites");
  assert.equal(v2Res.status, 200);
  const globalSites = (await v2Res.json()).data;
  assert.deepEqual(
    globalSites.map((s) => s.site_id),
    ["ebay_us", "ebay_uk", "ebay_de", "ebay_fr", "ebay_it", "ebay_es", "ebay_ca", "ebay_au"],
  );
  for (const newId of ["ebay_fr", "ebay_it", "ebay_es", "ebay_ca", "ebay_au"]) {
    const entry = globalSites.find((s) => s.site_id === newId);
    assert.equal(entry.status, "preview_offline");
    assert.deepEqual(entry.gates, {
      source_gate_passed: false,
      translation_gate_passed: false,
      legal_gate_passed: false,
      economics_gate_passed: false,
    });
  }

  // Non-inheritance rule: existing US/fixture source clearance does NOT authorize ebay_fr
  assert.equal(
    (await app.request("/v1/global-sites/ebay_fr/sold-preview?q=Nintendo+Switch", { headers: x.headers }))
      .status,
    403,
  );

  // Provision independent FR, CA, and AU sources
  const frSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  const caSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  const auSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  await db.query("UPDATE sources SET marketplace='ebay_fr' WHERE id=$1", [frSource.sourceId]);
  await db.query("UPDATE sources SET marketplace='ebay_ca' WHERE id=$1", [caSource.sourceId]);
  await db.query("UPDATE sources SET marketplace='ebay_au' WHERE id=$1", [auSource.sourceId]);

  for (let i = 0; i < 8; i++) {
    await db.query(
      `INSERT INTO regional_site_records(
         site_id,source_id,permission_epoch,query_keyword,event_key,title,currency,
         item_minor,shipping_minor,shipping_status,sale_price_status,sale_format,
         condition_raw,condition_std,sold_at,sold_date_precision,comparable,retention_until
       ) VALUES('ebay_fr',$1,1,'Nintendo Switch OLED',$2,$3,'EUR',$4,0,'verified_free_shipping','verified_actual','fixed_price','Neuf','new_with_tags',$5,'day',true,$6)`,
      [
        frSource.sourceId,
        `fr-switch-${i}`,
        `Switch FR #${i}`,
        24000 + i * 500,
        "2026-11-15T12:00:00Z",
        "2026-11-30T00:00:00Z",
      ],
    );
    await db.query(
      `INSERT INTO regional_site_records(
         site_id,source_id,permission_epoch,query_keyword,event_key,title,currency,
         item_minor,shipping_minor,shipping_status,sale_price_status,sale_format,
         condition_raw,condition_std,sold_at,sold_date_precision,comparable,retention_until
       ) VALUES('ebay_ca',$1,1,'Nintendo Switch OLED',$2,$3,'CAD',$4,0,'verified_free_shipping','verified_actual','fixed_price','Used','good',$5,'day',true,$6)`,
      [
        caSource.sourceId,
        `ca-switch-${i}`,
        `Switch CA #${i}`,
        33000 + i * 500,
        "2026-11-15T12:00:00Z",
        "2026-11-30T00:00:00Z",
      ],
    );
    await db.query(
      `INSERT INTO regional_site_records(
         site_id,source_id,permission_epoch,query_keyword,event_key,title,currency,
         item_minor,shipping_minor,shipping_status,sale_price_status,sale_format,
         condition_raw,condition_std,sold_at,sold_date_precision,comparable,retention_until
       ) VALUES('ebay_au',$1,1,'Nintendo Switch OLED',$2,$3,'AUD',$4,0,'verified_free_shipping','verified_actual','fixed_price','Used','good',$5,'day',true,$6)`,
      [
        auSource.sourceId,
        `au-switch-${i}`,
        `Switch AU #${i}`,
        37000 + i * 500,
        "2026-11-15T12:00:00Z",
        "2026-11-30T00:00:00Z",
      ],
    );
  }

  await db.query(
    `INSERT INTO fx_rate_snapshots(base_currency,quote_currency,rate_micros,evidence_ref,provider,captured_at,expires_at)
     VALUES('CAD','USD',725000,'boc-fx-2026-11-17','boc_fixture','2026-11-17T08:00:00Z','2026-11-18T12:00:00Z'),
           ('AUD','USD',655000,'rba-fx-2026-11-17','rba_fixture','2026-11-17T08:00:00Z','2026-11-18T12:00:00Z')`,
  );

  const fxRes = await app.request("/v1/global-fx-rates?base=CAD&quote=USD");
  assert.equal(fxRes.status, 200);
  const fxList = (await fxRes.json()).data;
  assert.equal(fxList.length >= 1, true);
  assert.equal(fxList[0].evidence_ref, "boc-fx-2026-11-17");

  // Canadian preview in CAD with FX evidence to USD (en-CA vs fr-CA preserves canonical_query_hash)
  const caEn = (
    await (
      await app.request("/v1/global-sites/ebay_ca/sold-preview?q=Nintendo+Switch+OLED&compare_currency=USD", {
        headers: { ...x.headers, "Accept-Language": "en-CA" },
      })
    ).json()
  ).data;
  const caFr = (
    await (
      await app.request("/v1/global-sites/ebay_ca/sold-preview?q=Nintendo+Switch+OLED&compare_currency=USD", {
        headers: { ...x.headers, "Accept-Language": "fr-CA" },
      })
    ).json()
  ).data;
  assert.equal(caEn.native_currency, "CAD");
  assert.equal(caEn.canonical_query_hash, caFr.canonical_query_hash);
  assert.equal(caEn.native_stats.median_minor, 34750);
  assert.equal(caEn.fx_status, "converted_with_evidence");
  assert.equal(caEn.comparable_view.median_minor, convertMinorWithFx(34750, 725000));

  // Australian preview in AUD with FX evidence to USD
  const auRes = (
    await (
      await app.request("/v1/global-sites/ebay_au/sold-preview?q=Nintendo+Switch+OLED&compare_currency=USD", {
        headers: x.headers,
      })
    ).json()
  ).data;
  assert.equal(auRes.native_currency, "AUD");
  assert.equal(auRes.native_stats.median_minor, 38750);
  assert.equal(auRes.comparable_view.median_minor, convertMinorWithFx(38750, 655000));

  // Revoking ebay_fr fails closed (403) while ebay_ca & ebay_au stay readable (200)
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    frSource.sourceId,
  ]);
  assert.equal(
    (
      await app.request("/v1/global-sites/ebay_fr/sold-preview?q=Nintendo+Switch+OLED", {
        headers: x.headers,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request("/v1/global-sites/ebay_ca/sold-preview?q=Nintendo+Switch+OLED", {
        headers: x.headers,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/v1/global-sites/ebay_au/sold-preview?q=Nintendo+Switch+OLED", {
        headers: x.headers,
      })
    ).status,
    200,
  );

  // All 6 new HTML localization preview pages render 200 with localized copy
  for (const [loc, expectedTitle, expectedCurrency] of [
    ["fr", "SoldBench France (eBay FR · EUR)", "EUR"],
    ["it", "SoldBench Italia (eBay IT · EUR)", "EUR"],
    ["es", "SoldBench España (eBay ES · EUR)", "EUR"],
    ["en-CA", "SoldBench Canada English (eBay CA · CAD)", "CAD"],
    ["fr-CA", "SoldBench Canada Français (eBay CA · CAD)", "CAD"],
    ["en-AU", "SoldBench Australia (eBay AU · AUD)", "AUD"],
  ]) {
    const res = await app.request(`/${loc}/sites`);
    assert.equal(res.status, 200, loc);
    const html = await res.text();
    assert.ok(html.includes(`<html lang="${loc}">`), loc);
    assert.ok(html.includes(expectedTitle), loc);
    assert.ok(html.includes(expectedCurrency), loc);
  }

  assert.deepEqual(await x.billing.reconcile(x.user), []);
});
