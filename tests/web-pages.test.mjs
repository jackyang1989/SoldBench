import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { createApp, publishNextScheduledContent } from "@soldbench/api";
import { fixtureSignature, merchant, PaymentLifecycle } from "@soldbench/billing";
import { provisionFixtureSource } from "@soldbench/collector";
import { database, migrate } from "@soldbench/db";
import {
  AuctionsVerticalService,
  CardsVerticalService,
  PublicResults,
  SecondMarketplaceService,
} from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { generate } from "otplib";
import { measureMobileWeb } from "./helpers/mobile-web.mjs";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [];
before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
});

test("prototype-based pages serve both languages, valid private deep links and same-origin assets", async () => {
  const x = await createProductFixture(db, roots);
  for (const prefix of ["", "/zh-CN"]) {
    for (const path of [
      "/",
      "/search",
      "/login",
      "/register",
      "/verify-email",
      "/forgot-password",
      "/reset-password",
      "/account",
      "/account/queries",
      "/account/lookup",
      "/account/saved",
      "/account/batches",
      "/account/inventory",
      "/account/sites",
      "/account/marketplaces",
      "/account/cards",
      "/account/auctions",
      "/account/history",
      "/account/alerts",
      "/account/usage",
      "/account/logs",
      "/account/keys",
      "/account/security",
      "/account/billing",
      "/pricing",
      "/deletion-receipt",
      "/playground",
      "/methodology",
      "/agents",
      "/operations",
      "/support",
      "/categories",
      "/data-availability",
      "/blog",
      "/guides",
      "/alternatives",
      "/compare",
      "/worth",
      "/about",
      "/terms",
      "/privacy",
      "/help",
      `/results/${x.queryId}`,
    ]) {
      const response = await x.app.request(
        `${prefix && path === "/" ? prefix : prefix + path}?return_to=%2F%2Fexample.test`,
      );
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, new RegExp(`<html lang="${prefix ? "zh-CN" : "en"}"`));
      assert.ok(!html.includes("example.test"));
      assert.ok(html.includes("/assets/soldbench.css"));
      assert.ok(html.includes("/assets/soldbench.js"));
    }
  }
  assert.equal((await x.app.request("/results/not-a-uuid")).status, 404);
  const missing = await x.app.request("/zh-CN/blog/not-published", { headers: { Accept: "text/html" } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /找不到此页面/);
  const apiMissing = await x.app.request("/v1/not-a-route", { headers: { Accept: "text/html" } });
  assert.equal(apiMissing.status, 404);
  assert.match(apiMissing.headers.get("content-type"), /json/);
  const markdown = await x.app.request("/changelog", { headers: { Accept: "text/markdown" } });
  assert.match(markdown.headers.get("content-type"), /markdown/);
  const htmlChangelog = await x.app.request("/changelog", { headers: { Accept: "text/html" } });
  assert.match(htmlChangelog.headers.get("content-type"), /html/);
  const sitemap = await x.app.request("/sitemap.xml");
  assert.match(sitemap.headers.get("content-type"), /xml/);
  assert.doesNotMatch(await sitemap.text(), /<loc>/);
  for (const [extension, mime] of [
    ["css", "text/css"],
    ["js", "text/javascript"],
  ]) {
    const response = await x.app.request(`/assets/soldbench.${extension}`);
    assert.match(response.headers.get("content-type"), new RegExp(mime));
    assert.match(response.headers.get("vary"), /Accept-Encoding/i);
    const path = `/assets/soldbench.${extension}`;
    const compressed = await x.app.request(path, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    const raw = Buffer.from(await response.arrayBuffer());
    const zipped = Buffer.from(await compressed.arrayBuffer());
    assert.ok(zipped.length < raw.length);
    assert.deepEqual(gunzipSync(zipped), raw);
    const identity = await x.app.request(path, { headers: { "Accept-Encoding": "identity, gzip;q=0" } });
    assert.equal(identity.headers.get("content-encoding"), null);
  }
});

test("Chrome walks an empty account from cache miss and registration to explicit claim and free reuse", {
  skip: !process.env.SOLDBENCH_BROWSER_BINARY,
}, async () => {
  const { chromium } = await import(process.env.SOLDBENCH_BROWSER_MODULE ?? "playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.SOLDBENCH_BROWSER_BINARY,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"],
  });
  let app;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => app.fetch(r) });
  try {
    await new Promise((done) => (server.listening ? done() : server.once("listening", done)));
    const port = server.address().port,
      origin = `http://127.0.0.1:${port}`,
      x = await createProductFixture(db, roots, { keyword: "Nintendo Switch", port, limit: 50, count: 8 });
    const paymentKeys = { stripe: randomBytes(32).toString("hex"), paypal: randomBytes(32).toString("hex") };
    const payments = new PaymentLifecycle(x.billing, origin, paymentKeys);
    app = createApp(loadConfig({ PORT: String(port), PAYMENT_FIXTURES: "true" }), db, {
      auth: x.auth,
      query: x.query,
      payments,
    });
    if (process.env.SOLDBENCH_MEASURE_MOBILE === "true") {
      console.log(JSON.stringify(await measureMobileWeb(browser, origin)));
    }
    await db.query(
      `UPDATE source_clearances SET permitted_fields=permitted_fields || '{"public_cache":["aggregate"],"public_share":["aggregate"]}'::jsonb WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)`,
      [x.source.sourceId],
    );
    await new PublicResults(x.query).publishFixture(x.queryId);
    const context = await browser.newContext();
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage(),
      mistakes = [],
      requests = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => mistakes.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "POST") requests.push(new URL(request.url()).pathname);
    });
    const captures =
      process.env.SOLDBENCH_BROWSER_EVIDENCE ?? (await mkdtemp(join(tmpdir(), "soldbench-browser-")));
    await mkdir(captures, { recursive: true });
    for (const [locale, path] of [
      ["en", "/"],
      ["zh-CN", "/zh-CN"],
    ]) {
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(origin + path);
        const horizontal = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          overflow: [...document.querySelectorAll("body *")]
            .filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth)
            .map((node) => [node.tagName, node.className, node.getBoundingClientRect().right]),
        }));
        assert.equal(
          horizontal.width,
          width,
          JSON.stringify({ locale, width, ...horizontal, target: width }),
        );
        await page.screenshot({ path: join(captures, `home-${locale}-${width}.png`), fullPage: true });
      }
    }
    await page.goto(`${origin}/docs/en/quickstart`);
    await page.getByRole("textbox", { name: "Search documentation" }).fill("claim");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.locator("[data-docs-results] a").first().waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("textbox", { name: "搜索文档" }).fill("领取");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.locator("[data-docs-results] a").first().waitFor();
    await page.goto(`${origin}/categories`);
    await page.getByText("No categories have a public availability record yet.").waitFor();
    await page.goto(`${origin}/pricing`);
    await page.getByRole("heading", { name: "Pricing and credits", exact: true }).waitFor();
    await page.getByText("Commercial pricing is pending approval.").waitFor();
    assert.equal(await page.locator("[data-pricing-offers] article").count(), 0);
    await page.goto(`${origin}/support`);
    await page.getByRole("textbox", { name: "What happened?" }).fill("Synthetic request to verify the form.");
    const intake = () => page.waitForResponse((response) => response.url().endsWith("/support/requests"));
    const firstIntake = intake();
    await page.getByRole("button", { name: "Submit request" }).click();
    const firstReceipt = (await (await firstIntake).json()).data.request_id;
    await page.getByText(`Request received · ${firstReceipt}`).waitFor();
    const supportReceipt = await page.getByLabel("Save this private receipt", { exact: true }).inputValue();
    assert.match(supportReceipt, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!page.url().includes(supportReceipt));
    const secondIntake = intake();
    await page.getByRole("button", { name: "Submit request" }).click();
    assert.equal((await (await secondIntake).json()).data.request_id, firstReceipt);
    await page.goto(`${origin}/worth`);
    await page.getByRole("textbox", { name: "Product" }).fill("Nintendo Switch");
    await page.getByRole("button", { name: "Check sold prices", exact: true }).click();
    await page.getByText("Cached result · 4 lookups left today").waitFor();
    assert.equal(new URL(page.url()).pathname, "/worth");
    await page.goto(`${origin}/search`);
    const countJobs = async () => (await db.query("SELECT count(*)::int AS n FROM query_jobs")).rows[0].n;
    const beforeMiss = await countJobs();
    const search = page.getByRole("textbox", { name: "Search sold prices" });
    await search.fill("unknown fixture");
    await search.press("Enter");
    await page.getByText(/No result is cached/).waitFor();
    assert.equal(await search.inputValue(), "unknown fixture");
    assert.equal(await countJobs(), beforeMiss);
    const beforeSwitch = requests.length;
    await page.getByRole("link", { name: "简体中文" }).click();
    assert.equal(await page.getByRole("textbox", { name: "查询成交价" }).inputValue(), "unknown fixture");
    assert.equal(requests.length, beforeSwitch);
    const cnSearch = page.getByRole("textbox", { name: "查询成交价" });
    await cnSearch.fill("unsubmitted local draft");
    await page.getByRole("link", { name: "English" }).click();
    assert.equal(await search.inputValue(), "unsubmitted local draft");
    assert.equal(requests.length, beforeSwitch);
    await page.goto(`${origin}/register?q=Nintendo+Switch`);
    const email = `browser-${randomUUID()}@example.test`,
      password = "Local-bench-browser-only-456!";
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.waitForURL("**/verify-email?*");
    const mailbox = (
      await db.query(
        "SELECT m.id,m.encrypted_payload FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.purpose='verify_email'",
        [email],
      )
    ).rows[0];
    const mail = x.auth.crypto.open(mailbox.encrypted_payload, `auth.mail:${mailbox.id}`);
    const code = new URLSearchParams(new URL(mail.link).hash.slice(1)).get("token");
    await page.getByLabel("One-time code").fill(code);
    await page.getByRole("button", { name: "Verify your email" }).click();
    await page.waitForURL("**/login?*");
    const verifiedUser = (await db.query("SELECT id FROM users WHERE email=$1", [email])).rows[0].id;
    const grants = () =>
      db.query("SELECT id FROM credit_grants WHERE user_id=$1 AND grant_kind='free'", [verifiedUser]);
    assert.ok((await grants()).rowCount <= 1);
    await page.goto(`${origin}/verify-email?q=Nintendo+Switch`);
    await page.getByLabel("One-time code").fill(code);
    await page.getByRole("button", { name: "Verify your email" }).click();
    await page.getByText(/already used/).waitFor();
    assert.ok((await grants()).rowCount <= 1);
    await page.getByRole("link", { name: "Sign in", exact: true }).first().click();
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/search?*");
    assert.equal(await search.inputValue(), "Nintendo Switch");
    await page.goto(`${origin}/account`);
    await page.getByText("Your research history is empty.").waitFor();
    assert.equal((await grants()).rowCount, 1);
    await page.goBack();
    const rateBucket = x.auth.crypto.hash("query.rate", verifiedUser);
    await page.route("**/v1/jobs/*", async (route) => {
      await db.query("UPDATE auth_rate_windows SET used=30 WHERE bucket_hash=$1", [rateBucket]);
      await route.continue();
    });
    await search.press("Enter");
    await page.waitForURL((url) => url.searchParams.has("job"));
    await page.getByText(/Rate limit reached.*Retry in [0-9]+ seconds/).waitFor();
    const id = new URL(page.url()).searchParams.get("result");
    await page.unroute("**/v1/jobs/*");
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    assert.equal((await x.query.workOnce("browser-query")).status, "completed");
    await page.getByRole("button", { name: "Check progress" }).click();
    await db.query("UPDATE credit_wallets SET expires_at=$2 WHERE user_id=$1", [verifiedUser, x.now()]);
    await page.getByRole("button", { name: "Claim result" }).click();
    await page.getByText(/Not enough credits/).waitFor();
    const charges = () => db.query("SELECT id FROM billing_charges WHERE query_id=$1", [id]);
    assert.equal((await charges()).rowCount, 0);
    await x.billing.grant(verifiedUser, {
      kind: "promo",
      provider: "fixture",
      reference: randomUUID(),
      amount: 1,
      expiresAt: new Date(Date.parse(x.now()) + 3600000),
    });
    const claimRequests = [];
    page.on("request", (request) => {
      if (request.url().endsWith(`/${id}/claim`)) claimRequests.push(request.headers()["idempotency-key"]);
    });
    const lostClaim = `**/v1/sold/${id}/claim`;
    await page.route(
      lostClaim,
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        assert.equal((await response.json()).meta.credits_charged, 1);
        await route.abort();
      },
      { times: 1 },
    );
    let interruptedPhoto;
    await page.route(
      "**/v1/media/*",
      async (route) => {
        interruptedPhoto = route.request().url();
        await route.abort();
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Claim result" }).click();
    await page.getByText(/This research originally used 1 credit/).waitFor();
    const methodology = page.getByRole("link", { name: "How these prices are calculated" });
    assert.equal(await methodology.getAttribute("href"), "/methodology");
    assert.equal(claimRequests.length, 1);
    assert.equal(claimRequests[0], `web-claim-${id}`);
    const retryPhoto = page.getByRole("button", { name: "Retry photo", exact: true });
    await retryPhoto.waitFor();
    const photoCell = await retryPhoto.locator("..").elementHandle();
    const postCount = requests.length;
    const response = page.waitForResponse((response) => response.url() === interruptedPhoto);
    await retryPhoto.press("Enter");
    assert.equal((await response).status(), 200);
    await page.waitForFunction((cell) => cell.querySelector("img")?.naturalWidth > 0, photoCell);
    await retryPhoto.waitFor({ state: "hidden" });
    assert.equal(requests.length, postCount);
    assert.equal((await charges()).rowCount, 1);
    await page.getByRole("img", { name: "Sale photo" }).first().waitFor();
    await page.getByText(/Recent 30 days · 8 verified observations, coverage unknown/).waitFor();
    const beforeSummary = requests.length;
    const breakdown = page.getByText("Sale formats, shipping and sellers", { exact: true });
    await breakdown.click();
    const fixedPrice = page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "Fixed price", exact: true }) });
    assert.deepEqual((await fixedPrice.getByRole("cell").allTextContents()).slice(0, 2), [
      "Fixed price",
      "8",
    ]);
    const offer = page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "Best Offer", exact: true }) });
    assert.deepEqual(await offer.getByRole("cell").allTextContents(), ["Best Offer", "0", "—"]);
    await page.getByText("Shipping unavailable for 8 of 8 verified prices.").waitFor();
    await page.getByText(/Seller count unavailable for this sample/).waitFor();
    assert.equal(requests.length, beforeSummary);
    await breakdown.click();
    await page.getByText("Price distribution and trends", { exact: true }).click();
    await page.getByText("8 prices from the complete permitted snapshot").waitFor();
    await page.locator('svg[data-chart="price-histogram"]').waitFor();
    assert.equal((await page.locator('svg[data-chart="price-histogram"] rect.chart-bar').count()) >= 1, true);
    assert.equal(await page.locator('svg[data-chart="price-trend"]').count(), 1);
    const displayedBars = await page
      .locator(".distribution-bars meter")
      .evaluateAll((meters) => meters.reduce((count, meter) => count + meter.value, 0));
    assert.equal(displayedBars, 8);
    await page.getByText("Price distribution and trends", { exact: true }).click();
    await page.getByText("Why sales were included or excluded", { exact: true }).click();
    await page.getByRole("cell", { name: "Actual sale price unverified", exact: true }).waitFor();
    await page.getByText("Why sales were included or excluded", { exact: true }).click();
    await page.getByText("View evidence").first().click();
    await page
      .getByText(/Description ·/)
      .first()
      .waitFor();
    const beforeSort = requests.length;
    const highest = page.waitForResponse((response) => response.url().endsWith(`/${id}?sort=price_desc`));
    await page.getByRole("combobox", { name: "Sort results" }).selectOption("price_desc");
    assert.equal((await highest).status(), 200);
    await page
      .getByRole("cell", { name: /99\.99/ })
      .first()
      .waitFor();
    assert.equal(requests.length, beforeSort);
    await page.getByRole("checkbox", { name: "Exclude", exact: true }).first().check();
    await page.getByRole("button", { name: "Recalculate" }).click();
    await page.getByText(/Adjusted median.*7 verified.*1 excluded/).waitFor();
    const file = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON" }).click();
    const exported = JSON.parse(await readFile(await (await file).path(), "utf8"));
    assert.equal(exported.user_modified, true);
    assert.equal(exported.items.length, 7);
    await page.getByRole("button", { name: "Exclude complete sample" }).click();
    await page.getByText("8 marked for exclusion").waitFor();
    await page.getByRole("button", { name: "Recalculate" }).click();
    await page.getByText(/Adjusted median.*0 verified.*8 excluded/).waitFor();
    await page.getByRole("button", { name: "Restore all" }).click();
    assert.equal(
      await page.getByRole("checkbox", { name: "Exclude", exact: true }).first().isChecked(),
      false,
    );
    await page.getByText("Share price summary", { exact: true }).click();
    await page.getByRole("button", { name: "Create 24-hour link" }).click();
    const shareUrl = await page.getByRole("textbox", { name: "Share link" }).inputValue();
    const visitor = await browser.newContext();
    await visitor.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const shared = await visitor.newPage();
    const share = await shared.goto(shareUrl);
    assert.equal(share.status(), 200);
    assert.equal(share.headers()["referrer-policy"], "no-referrer");
    assert.match(share.headers()["cache-control"], /no-store/);
    await shared.getByRole("heading", { name: "Shared price research" }).waitFor();
    assert.equal(await shared.locator("table").count(), 0);
    assert.equal((await shared.content()).includes(id), false);
    await shared.getByRole("link", { name: "简体中文" }).click();
    await shared.getByRole("heading", { name: "分享的成交研究" }).waitFor();
    await page.getByRole("button", { name: "Revoke link" }).click();
    await page.getByText("Link revoked.").waitFor();
    assert.equal((await shared.reload()).status(), 410);
    await shared.getByText("此分享已不可用。").waitFor();
    await visitor.close();
    await page.getByText("Best Offer price verification", { exact: true }).click();
    await page.getByRole("button", { name: "Request Best Offer verification" }).waitFor();
    const verifyResp = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/sold/${id}/best-offers/verify`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Request Best Offer verification" }).click();
    assert.equal((await verifyResp).status(), 202);
    await page.getByText("Best Offer verification queued (0 credits).").waitFor();
    await page.getByText(/Pending: 1/).waitFor();
    assert.equal((await charges()).rowCount, 1);
    const beforeLanguage = requests.length;
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByText(/本次扣费 0 个额度/).waitFor();
    await page.getByText("成交形式、运费与卖家", { exact: true }).click();
    await page.getByRole("cell", { name: "一口价", exact: true }).waitFor();
    await page.getByText("8 条核验价格中，8 条暂无可用运费口径。").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("result"), id);
    assert.equal(requests.length, beforeLanguage);
    await page.goto(`${origin}/account`);
    await page.getByRole("heading", { name: "Recent research" }).waitFor();
    await page.locator(`a[href="/results/${id}"]`).click();
    await page.getByText(/0 credits charged for this request/).waitFor();
    assert.equal(new URL(page.url()).pathname, `/results/${id}`);
    assert.equal(await search.inputValue(), "Nintendo Switch");
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    const savedName = page.getByRole("textbox", { name: "Name this research" });
    await savedName.fill("Original browser study");
    await page.getByRole("button", { name: "Save research", exact: true }).click();
    await page.getByText("Research saved.", { exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "Exclude", exact: true }).first().check();
    await savedName.fill("Adjusted browser study");
    const adjustedReceipt = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/saved-research" && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save research", exact: true }).click();
    assert.equal((await adjustedReceipt).status(), 200);
    await page.getByRole("link", { name: "Saved research", exact: true }).click();
    await page.getByRole("heading", { name: "Original browser study" }).waitFor();
    const adjusted = page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "Adjusted browser study" }) });
    await adjusted.getByRole("link", { name: "Open saved view", exact: true }).click();
    await page.getByText("1 saved exclusions restored", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Saved research", exact: true }).click();
    await page.getByRole("button", { name: "Compare saved research" }).click();
    await page.getByText("Median difference unavailable · sample size", { exact: true }).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "已保存的研究", exact: true }).waitFor();
    const original = page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "Original browser study" }) });
    await original.getByRole("textbox", { name: "新的保存名称" }).fill("重新命名的研究");
    const renameReceipt = page.waitForResponse(
      (response) => response.request().method() === "PATCH" && response.url().includes("/v1/saved-research/"),
    );
    await original.getByRole("button", { name: "重命名" }).click();
    const renamedResponse = await renameReceipt;
    assert.equal(renamedResponse.status(), 200, await renamedResponse.text());
    const renamed = page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "重新命名的研究" }) });
    await renamed.getByRole("button", { name: "移除保存" }).click();
    await page.getByText("保存引用已移除。", { exact: true }).waitFor();
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    for (const [locale, target] of [
      ["en", "/results/"],
      ["zh-CN", "/zh-CN/results/"],
    ]) {
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(origin + target + id);
        await page
          .getByRole("heading", { name: locale === "en" ? "Sold-price summary" : "成交价格摘要" })
          .waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await page.screenshot({ path: join(captures, `result-${locale}-${width}.png`), fullPage: true });
      }
    }
    assert.equal((await charges()).rowCount, 1);
    await page.setViewportSize({ width: 390, height: 900 });
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/usage`);
    await page.getByRole("heading", { name: "Latest credit entries" }).waitFor();
    await page.getByRole("cell", { name: "Search charge", exact: true }).waitFor();
    await page.getByRole("link", { name: "Request logs", exact: true }).click();
    await page.getByRole("heading", { name: "Requests", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.getByRole("link", { name: "API keys", exact: true }).click();
    await page.getByRole("textbox", { name: "Key name" }).fill("Browser-only fixture key");
    await page.getByRole("button", { name: "Create key", exact: true }).click();
    const oneTime = page.getByRole("textbox", { name: "New key shown once" });
    const key = await oneTime.inputValue();
    assert.match(key, /^sb_k_/);
    assert.ok(!page.url().includes(key));
    await page.getByRole("button", { name: "Hide key" }).click();
    assert.equal(await oneTime.count(), 0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Rotate", exact: true }).click();
    const rotated = await oneTime.inputValue();
    assert.notEqual(rotated, key);
    await page.getByText("Revoked", { exact: true }).waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Rotate", exact: true }).waitFor({ state: "detached" });
    assert.equal(await oneTime.count(), 0);
    await page.goto(`${origin}/playground?q=Nintendo+Switch`);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "202 /web/search" }).waitFor();
    await page.locator("[data-trace-body]").getByText(new RegExp(id)).waitFor();
    await page.getByText(/0 credits charged for this request/).waitFor();
    await page.getByText("Headers", { exact: true }).click();
    assert.match(await page.locator("[data-trace-headers]").textContent(), /X-Request-ID:/);
    await page.getByText("Server-side cURL example", { exact: true }).click();
    const snippet = await page.locator("[data-trace-code]").textContent();
    assert.match(snippet, /\$SOLDBENCH_API_KEY/);
    assert.ok(!snippet.includes(rotated));
    assert.equal((await charges()).rowCount, 1);
    const operatorPage = async () => {
      const operator = (
        await db.query(
          "INSERT INTO users(email,password_hash,status,email_verified_at) VALUES($1,'fixture','active',$2) RETURNING id",
          [`operator-${randomUUID()}@example.test`, x.now()],
        )
      ).rows[0].id;
      await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin')", [operator]);
      await db.query(
        "INSERT INTO user_mfa(user_id,encrypted_secret,state,enabled_at,updated_at) VALUES($1,$2,'enabled',$3,$3)",
        [operator, x.auth.crypto.seal("TEST_ONLY", operator), x.now()],
      );
      const token = x.auth.crypto.token("sb_s_"),
        csrf = x.auth.crypto.hash("auth.csrf", token);
      await db.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at,authenticated_at,mfa_at,created_at) VALUES($1,$2,$3,$4,$5,$5,$5)",
        [
          operator,
          x.auth.crypto.hash("auth.session", token),
          x.auth.crypto.hash("auth.csrf-store", csrf),
          new Date(Date.parse(x.now()) + 86400000),
          x.now(),
        ],
      );
      const context = await browser.newContext();
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await context.addCookies([
        { name: "soldbench_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
      ]);
      const editor = await context.newPage();
      editor.setDefaultTimeout(10000);
      editor.on("pageerror", (error) => mistakes.push(error.message));
      await editor.goto(`${origin}/admin/content`);
      return { editor, context };
    };
    const author = await operatorPage();
    const editor = author.editor;
    await editor.getByLabel("Content type").selectOption("faq");
    await editor.getByLabel("Slug", { exact: true }).fill("browser-workflow");
    await editor.getByLabel("English", { exact: true }).fill("Browser publication question");
    await editor.getByLabel("English body").fill("Published only after review.");
    await editor.getByLabel("简体中文", { exact: true }).fill("浏览器发布验证");
    await editor.getByLabel("Chinese body").fill("经审核后发布。");
    await editor.getByLabel("Change reason").fill("Offline draft and review test");
    await editor.getByRole("button", { name: "Save draft" }).click();
    await editor.getByRole("heading", { name: "Browser publication question" }).waitFor();
    await page.goto(`${origin}/faq`);
    await page.getByText("Nothing has been published here yet.").waitFor();
    await editor.getByLabel("Change reason").fill("Submit the approved evidence for review");
    await editor.getByRole("button", { name: "Submit for review" }).click();
    await editor.getByRole("button", { name: "Approve", exact: true }).waitFor();
    const reviewer = await operatorPage();
    await reviewer.editor.getByLabel("Change reason").fill("Independently verify and publish fixture text");
    await reviewer.editor.getByRole("button", { name: "Approve", exact: true }).click();
    await reviewer.editor.getByRole("button", { name: "Publish", exact: true }).click();
    await reviewer.editor.getByText(/Active revision 1/).waitFor();
    await page.goto(`${origin}/zh-CN/faq`);
    await page.getByRole("heading", { name: "浏览器发布验证" }).waitFor();
    await reviewer.editor.getByRole("button", { name: "Unpublish" }).click();
    await reviewer.editor.getByRole("button", { name: "Publish", exact: true }).waitFor();
    await page.reload();
    await page.getByText("此处暂未发布内容。").waitFor();
    const due = new Date(Math.ceil(Date.parse(x.now()) / 60000) * 60000 + 60000).toISOString();
    await reviewer.editor.getByLabel("Publication time (UTC)", { exact: true }).fill(due.slice(0, 16));
    await reviewer.editor.getByRole("button", { name: "Schedule publication", exact: true }).click();
    await reviewer.editor.getByText(/^Scheduled · /).waitFor();
    await reviewer.editor.getByRole("button", { name: "Cancel schedule", exact: true }).click();
    await reviewer.editor.getByText(/^Schedule cancelled · /).waitFor();
    await reviewer.editor.getByLabel("Publication time (UTC)", { exact: true }).fill(due.slice(0, 16));
    await reviewer.editor.getByRole("button", { name: "Schedule publication", exact: true }).click();
    await reviewer.editor.getByText(/^Scheduled · /).waitFor();
    assert.equal(await publishNextScheduledContent(db, x.now), null);
    x.clock.value = due;
    assert.equal((await publishNextScheduledContent(db, x.now)).status, "published");
    await page.reload();
    await page.getByRole("heading", { name: "浏览器发布验证" }).waitFor();
    await reviewer.editor.reload();
    await reviewer.editor.getByText(/^Published on schedule · /).waitFor();
    await editor.getByLabel("Content type").selectOption("navigation");
    await editor.getByLabel("Slug", { exact: true }).fill("browser-navigation");
    await editor.getByLabel("Site destination").selectOption("/guides");
    await editor.getByLabel("Display order").fill("3");
    await editor.getByLabel("English", { exact: true }).fill("Owned guide link");
    await editor.getByLabel("English body").fill("Approved local navigation");
    await editor.getByLabel("简体中文", { exact: true }).fill("站内指南链接");
    await editor.getByLabel("Chinese body").fill("审核后的站内导航。");
    await editor.getByLabel("Change reason").fill("Create a local navigation item");
    await editor.getByRole("button", { name: "Save draft" }).click();
    const newEntry = editor
      .locator("article")
      .filter({ has: editor.getByRole("heading", { name: "Owned guide link" }) });
    await newEntry.getByRole("button", { name: "Edit latest" }).click();
    assert.equal(await editor.getByLabel("Site destination").inputValue(), "/guides");
    await newEntry.getByText("Preview both languages").click();
    await newEntry.getByText("站内指南链接", { exact: true }).waitFor();
    await editor.getByLabel("Change reason").fill("Submit navigation for review");
    await newEntry.getByRole("button", { name: "Submit for review" }).click();
    await newEntry.getByRole("button", { name: "Approve", exact: true }).waitFor();
    await reviewer.editor.reload();
    await reviewer.editor.getByLabel("Change reason").fill("Verify the local destination");
    const approval = reviewer.editor
      .locator("article")
      .filter({ has: reviewer.editor.getByRole("heading", { name: "Owned guide link" }) });
    await approval.getByRole("button", { name: "Approve", exact: true }).click();
    await approval.getByRole("button", { name: "Publish", exact: true }).click();
    await approval.getByText(/Active revision 1/).waitFor();
    await page.goto(`${origin}/zh-CN`);
    await page.getByText("菜单", { exact: true }).click();
    const localLink = page.locator("details.mobile").getByRole("link", { name: "站内指南链接" });
    assert.equal(await localLink.getAttribute("href"), "/zh-CN/guides");
    await editor.getByRole("link", { name: "Operations", exact: true }).click();
    await editor.getByRole("button", { name: "Sources", exact: true }).click();
    const sourceLine = editor.getByRole("row").filter({ hasText: x.source.sourceId });
    await sourceLine.getByText("Source controls", { exact: true }).click();
    await sourceLine.getByLabel("Reason", { exact: true }).fill("Verify the synthetic source");
    await sourceLine.getByLabel("Evidence reference", { exact: true }).fill("offline-test-source");
    await sourceLine.getByRole("button", { name: "Run command" }).click();
    await editor.getByText(/Local readiness ready_for_offline_probe/).waitFor();
    await editor.getByRole("button", { name: "Audit log", exact: true }).click();
    await editor.getByRole("cell", { name: "ops.source", exact: true }).waitFor();
    const failed = await x.query.submit(x.identity, { ...x.q, limit: 3 });
    await db.query("UPDATE queries SET compute_status='failed' WHERE id=$1", [failed.queryId]);
    await db.query(
      "UPDATE query_jobs SET status='failed',attempt_count=1,error_code='service_unavailable',version=2 WHERE id=$1",
      [failed.jobId],
    );
    const beforeCollection = (await db.query("SELECT count(*)::int count FROM collector_jobs")).rows[0].count;
    await editor.getByRole("button", { name: "Jobs", exact: true }).click();
    const failedRow = editor.getByRole("row").filter({ hasText: failed.jobId });
    await failedRow.getByText("Retry query job", { exact: true }).click();
    await failedRow.getByLabel("Reason", { exact: true }).fill("Retry from the retained fixture snapshot");
    const routePath = `**/admin/jobs/${failed.jobId}/retry`;
    const commandKeys = [];
    await editor.route(routePath, async (route) => {
      commandKeys.push((await route.request().allHeaders())["idempotency-key"]);
      if (commandKeys.length > 1) return route.continue();
      const result = await route.fetch();
      assert.equal(result.status(), 202);
      await route.abort();
    });
    editor.once("dialog", (dialog) => dialog.accept());
    await failedRow.getByRole("button", { name: "Run command" }).click();
    await editor.getByText("The request failed. Check your inputs or try again.").waitFor();
    editor.once("dialog", (dialog) => dialog.accept());
    await failedRow.getByRole("button", { name: "Run command" }).click();
    await editor.getByText(/Query requeued · Audit ID/).waitFor();
    assert.equal(commandKeys.length, 2);
    assert.equal(commandKeys[0], commandKeys[1]);
    await editor.unroute(routePath);
    assert.equal((await x.query.workOnce("browser-recovery")).status, "completed");
    assert.equal((await x.query.job(x.identity, failed.jobId)).settlement_status, "pending");
    assert.equal(
      (await db.query("SELECT count(*)::int count FROM collector_jobs")).rows[0].count,
      beforeCollection,
    );
    await editor.getByRole("button", { name: "Reconciliation", exact: true }).click();
    const chargeId = (await charges()).rows[0].id;
    const chargeRow = editor.getByRole("row").filter({ hasText: chargeId });
    await chargeRow.getByText("Return search credit", { exact: true }).click();
    await chargeRow.getByLabel("Reason", { exact: true }).fill("Correct the synthetic query charge");
    editor.once("dialog", (dialog) => dialog.accept());
    await chargeRow.getByRole("button", { name: "Run command" }).click();
    await editor.getByText(/Credit compensation recorded · Audit ID/).waitFor();
    await chargeRow.getByRole("cell", { name: "refunded", exact: true }).waitFor();
    await chargeRow.getByRole("cell", { name: "balanced", exact: true }).waitFor();
    await editor.getByRole("button", { name: "Support queue", exact: true }).click();
    const supportRow = editor.getByRole("row").filter({ hasText: firstReceipt });
    await supportRow.locator("summary").filter({ hasText: "Claim request" }).click();
    await supportRow.getByLabel("Reason", { exact: true }).fill("Assign browser support fixture");
    await supportRow
      .getByLabel("Deadline (UTC)", { exact: true })
      .fill(new Date(Date.parse(x.now()) + 86400000).toISOString().slice(0, 16));
    await supportRow.getByRole("button", { name: "Claim request", exact: true }).click();
    await editor.getByText(/Support request updated · Audit ID/).waitFor();
    await supportRow.locator("summary").filter({ hasText: "Manage request" }).click();
    await supportRow.getByText("Synthetic request to verify the form.").waitFor();
    await supportRow.getByLabel("Reason", { exact: true }).fill("Confirm the case is ready to resolve");
    await supportRow
      .getByLabel("Reply for the requester", { exact: true })
      .fill("The fixture review is complete.");
    await supportRow.getByRole("button", { name: "Record reply and resolve", exact: true }).click();
    await supportRow.getByRole("cell", { name: "Resolved", exact: true }).waitFor();
    await page.goto(`${origin}/zh-CN/support`);
    await page.getByLabel("私密工单回执", { exact: true }).fill(supportReceipt);
    await page.getByRole("button", { name: "查询工单状态", exact: true }).click();
    await page.getByText(`已处置 · ${firstReceipt}`).waitFor();
    await page.getByText("The fixture review is complete.", { exact: true }).waitFor();
    assert.ok(!page.url().includes(supportReceipt));
    const onlineApp = app;
    app = createApp(loadConfig({ PORT: String(port) }), db, { auth: x.auth, query: x.query });
    try {
      const disabledOffers = page.waitForResponse((response) => response.url().endsWith("/billing/offers"));
      await page.goto(`${origin}/zh-CN/pricing`);
      assert.equal((await disabledOffers).status(), 503);
      await page.getByText("正式定价有待审批。", { exact: true }).waitFor();
      assert.equal(await page.locator("[data-pricing-offers] article").count(), 0);
    } finally {
      app = onlineApp;
    }
    const beforePreview = requests.length;
    const previewResponse = page.waitForResponse((response) => response.url().endsWith("/billing/offers"));
    await page.goto(`${origin}/pricing`);
    const preview = (await (await previewResponse).json()).data;
    await page.getByText("Sandbox preview. Amounts are for testing.").waitFor();
    const cards = page.locator("[data-pricing-offers] article");
    assert.equal(await cards.count(), preview.offers.length);
    const currency = new Intl.NumberFormat("en", {
      style: "currency",
      currency: "USD",
      currencyDisplay: "code",
    });
    for (const offer of preview.offers) {
      const card = page.locator(`[data-pricing-offers] [data-plan=${offer.plan_code}]`);
      assert.equal(
        await card.locator(".price-amount").textContent(),
        currency.format(offer.amount_cents / 100),
      );
    }
    const pack = page.locator("[data-pricing-offers] [data-plan=purchased_1500]");
    await pack.getByRole("link", { name: "Open test checkout", exact: true }).click();
    await page.getByRole("heading", { name: "Test checkout" }).waitFor();
    await page.getByText(/Selected test offer · Credit pack/).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("plan"), "purchased_1500");
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByText(/选中的测试报价 · 额度包/).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    await page.getByText(/Selected test offer · Credit pack/).waitFor();
    assert.equal(requests.length, beforePreview);
    const provider = page.getByRole("combobox", { name: "Payment provider" });
    assert.equal(await provider.inputValue(), "stripe");
    await provider.selectOption("paypal");
    let lostCheckout;
    await page.route(
      "**/billing/checkout",
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        lostCheckout = new URL((await response.json()).data.checkout_url, origin).pathname.split("/").at(-1);
        await route.abort();
      },
      { times: 1 },
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Credit pack.*1,?500/ }).click();
    await page.getByText("The request failed. Check your inputs or try again.", { exact: true }).waitFor();
    assert.equal(await provider.inputValue(), "paypal");
    assert.equal(new URL(page.url()).searchParams.get("plan"), "purchased_1500");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Credit pack.*1,?500/ }).click();
    await page.getByText(/paypal.*Awaiting confirmation/).waitFor();
    const checkoutId = new URL(page.url()).searchParams.get("checkout");
    assert.equal(checkoutId, lostCheckout);
    const fact = {
      provider: "paypal",
      merchant: merchant("paypal"),
      environment: "offline_fixture",
      checkout_id: checkoutId,
      object_id: randomUUID(),
      revision: 1,
      kind: "transaction",
      status: "confirmed",
      amount_cents: 1000,
      currency: "USD",
      paid_at: x.now(),
      subscription_id: null,
      period_start: null,
      period_end: null,
    };
    const notification = Buffer.from(
      JSON.stringify({
        id: randomUUID(),
        type: "capture_completed",
        merchant: fact.merchant,
        environment: fact.environment,
        object_id: fact.object_id,
        revision: fact.revision,
      }),
    );
    const webhook = await app.request("/webhooks/paypal", {
      method: "POST",
      headers: {
        Host: new URL(origin).host,
        "Content-Type": "application/json",
        ...fixtureSignature("paypal", paymentKeys.paypal, notification, new Date(x.now())),
      },
      body: notification,
    });
    assert.equal(webhook.status, 200);
    let late;
    for (let attempt = 1; attempt <= 12; attempt++) {
      late = await payments.workOnce();
      assert.equal(late.status, attempt === 12 ? "failed" : "retryable");
      if (attempt < 12)
        await db.query("UPDATE payment_events SET fixture_retry_at=$2 WHERE id=$1", [late.eventId, x.now()]);
    }
    await editor.getByRole("button", { name: "Payment recovery", exact: true }).click();
    const receiptRow = editor.getByRole("row").filter({ hasText: late.eventId });
    await receiptRow.getByText("Replay confirmation", { exact: true }).click();
    await receiptRow
      .getByLabel("Reason", { exact: true })
      .fill("Apply the verified late sandbox confirmation");
    await receiptRow.getByLabel("Case reference", { exact: true }).fill("browser-recovery-case");
    editor.once("dialog", (dialog) => dialog.accept());
    await receiptRow.getByRole("button", { name: "Run command" }).click();
    await editor.getByText(/Current state or evidence does not allow this command/).waitFor();
    await payments.stageFixture(fact);
    editor.once("dialog", (dialog) => dialog.accept());
    await receiptRow.getByRole("button", { name: "Run command" }).click();
    await editor.getByText(/Confirmation applied · Audit ID/).waitFor();
    await receiptRow.waitFor({ state: "detached" });
    await editor.getByRole("button", { name: "Audit log", exact: true }).click();
    for (const action of [
      "ops.query_retry",
      "ops.credit_refund",
      "ops.payment_replay",
      "ops.support.claim",
      "ops.support.read",
      "ops.support.resolve",
    ])
      await editor.getByRole("cell", { name: action, exact: true }).waitFor();
    await editor.goto(`${origin}/operations/users?account=${x.user}`);
    await editor.getByRole("heading", { name: "User 360", exact: true }).waitFor();
    await editor
      .getByRole("textbox", { name: "Internal note", exact: true })
      .fill("Synthetic browser account note");
    await editor.getByRole("button", { name: "Save account note", exact: true }).click();
    await editor.getByRole("cell", { name: "Synthetic browser account note" }).waitFor();
    const requestApproval = editor
      .locator("details")
      .filter({ has: editor.getByText("Suspend account", { exact: true }) });
    await requestApproval.getByText("Suspend account", { exact: true }).click();
    await requestApproval
      .getByRole("textbox", { name: "Reason", exact: true })
      .fill("Synthetic case approval");
    editor.once("dialog", (dialog) => dialog.accept());
    await requestApproval.getByRole("button", { name: "Run command", exact: true }).click();
    await editor.getByText(/Approval requested · Audit ID/).waitFor();
    await reviewer.editor.goto(`${origin}/operations/approvals`);
    const caseRow = reviewer.editor.getByRole("row").filter({ hasText: x.user });
    for (const label of ["Approve request", "Execute approved action"]) {
      const control = caseRow
        .locator("details")
        .filter({ has: reviewer.editor.getByText(label, { exact: true }) });
      await control.getByText(label, { exact: true }).click();
      await control.getByRole("textbox", { name: "Reason", exact: true }).fill("Independent browser review");
      reviewer.editor.once("dialog", (dialog) => dialog.accept());
      await control.getByRole("button", { name: "Run command", exact: true }).click();
    }
    await caseRow.getByRole("cell", { name: "Executed", exact: true }).waitFor();
    await editor.goto(`${origin}/zh-CN/operations/users?account=${x.user}`);
    await editor.getByRole("heading", { name: "用户 360", exact: true }).waitFor();
    await editor.getByText(/已暂停/).waitFor();
    await editor.getByRole("button", { name: "系统设置", exact: true }).click();
    await editor.getByRole("cell", { name: "真实采集", exact: true }).waitFor();
    assert.equal(new URL(editor.url()).pathname, "/zh-CN/operations/settings");
    await editor.getByRole("button", { name: "监控", exact: true }).click();
    await editor.getByRole("heading", { name: "本机告警", exact: true }).waitFor();
    await editor.getByRole("cell", { name: "到期主图清理任务", exact: true }).waitFor();
    await editor.getByRole("spinbutton", { name: "心跳告警秒数", exact: true }).fill("45");
    await editor.getByRole("textbox", { name: "原因", exact: true }).fill("本机告警界面验收");
    await editor.getByRole("button", { name: "保存告警阈值", exact: true }).click();
    await editor.getByText(/告警阈值已记录/).waitFor();
    await editor.getByRole("button", { name: "采集运行", exact: true }).click();
    await editor.getByRole("columnheader", { name: "解析器版本", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "健康报告状态", exact: true }).waitFor();
    await editor.getByRole("heading", { name: "刷新计划", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "待派发时段", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "上轮优先登记的有效时段", exact: true }).waitFor();
    await editor.getByRole("heading", { name: "响应包入站", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "已检查目录项", exact: true }).waitFor();
    await editor.getByRole("heading", { name: "主图清理", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "最早待清理时间", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "最近主图维护状态", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "主图维护最近检查", exact: true }).waitFor();
    await editor.getByRole("heading", { name: "采集证据快照", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "准时派发页面的作业", exact: true }).waitFor();
    await editor.getByRole("link", { name: x.source.sourceId, exact: true }).first().click();
    await editor.getByRole("columnheader", { name: "商品主图", exact: true }).waitFor();
    await editor.goto(`${origin}/operations/collector`);
    await editor.getByRole("heading", { name: "Primary image cleanup", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "Oldest cleanup due", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "Last media maintenance", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "Last media maintenance check", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "Health report status", exact: true }).waitFor();
    await editor.getByRole("heading", { name: "Collection evidence at capture", exact: true }).waitFor();
    await editor.getByRole("columnheader", { name: "Sale observations", exact: true }).waitFor();
    await reviewer.context.close();
    await author.context.close();
    await page.getByRole("button", { name: "Refresh order" }).click();
    await page.getByText(/paypal.*Confirmed/).waitFor();
    await page.getByRole("cell", { name: "Succeeded", exact: true }).waitFor();
    await page.goto(`${origin}/account/batches`);
    await page.getByRole("heading", { name: "Batch lookup & CSV", exact: true }).waitFor();
    const batchCsv = page.locator("[data-batch-csv]");
    await batchCsv.fill(`q,limit,window_days\n${x.q.q},12,90\n${x.q.q},12,90\nUncovered Batch Row,50,90\n`);
    await page.getByRole("button", { name: "Preview dedupe & cost", exact: true }).click();
    await page.getByText(/Duplicates: 1/).waitFor();
    await page.getByRole("button", { name: "Submit batch", exact: true }).click();
    await page.getByText(/Batch submitted without upfront credit charge/).waitFor();
    await page.getByRole("button", { name: "Cancel remaining", exact: true }).click();
    await page.getByText(/Remaining queued items cancelled/).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "批量查价与 CSV", exact: true }).waitFor();
    await page.getByRole("cell", { name: "已取消", exact: true }).first().waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    await page.getByRole("heading", { name: "Batch lookup & CSV", exact: true }).waitFor();
    await batchCsv.fill(`q,limit,window_days\n${x.q.q},15,90\n${x.q.q},15,90\n`);
    await page.getByRole("button", { name: "Submit batch", exact: true }).click();
    await page.getByText(/Batch submitted without upfront credit charge/).waitFor();
    while (await x.query.workOnce("batch-browser-worker")) {
      // finish queued item
    }
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await page.getByRole("button", { name: /Claim ready/ }).click();
    await page.getByText(/Claimed 1 queries \(1 credits charged now\)/).waitFor();
    const batchDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV", exact: true }).click();
    const batchCsvExport = await readFile(await (await batchDownload).path(), "utf8");
    assert.match(batchCsvExport, new RegExp(x.q.q));
    await page.goto(`${origin}/account/history?q=${encodeURIComponent(x.q.q)}`);
    await page.getByRole("heading", { name: "Archive history", exact: true }).waitFor();
    await page.getByText(/Supported complete windows: None/).waitFor();
    await page.getByRole("button", { name: "Load historical trend", exact: true }).click();
    await page.getByText(/exceeds continuous approved historical coverage/).waitFor();
    await page.getByRole("checkbox", { name: /Allow partial coverage/ }).check();
    await page.getByRole("button", { name: "Load historical trend", exact: true }).click();
    await page.getByRole("heading", { name: /Coverage: Partial/ }).waitFor();
    await page.getByRole("cell", { name: "Missing gap", exact: true }).first().waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "历史档案研究", exact: true }).waitFor();
    await page.getByRole("checkbox", { name: /允许部分覆盖/ }).check();
    await page.getByRole("button", { name: "加载历史研究", exact: true }).click();
    await page.getByRole("cell", { name: "数据缺口", exact: true }).first().waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/alerts`);
    await page.getByRole("heading", { name: "Create watchlist alert" }).waitFor();
    await page.getByRole("button", { name: "Create watchlist" }).click();
    await page.getByText("Watchlist created (0 credits).").waitFor();
    await page.getByLabel("Public HTTPS URL").fill("https://hooks.example.test/ui-webhook");
    await page.getByRole("button", { name: "Add webhook" }).click();
    await page.getByText("Webhook endpoint registered.").waitFor();
    await page.getByText("Copy signing secret now").waitFor();
    await page.getByRole("button", { name: "Switch language" }).first().click();
    await page.getByText("Watchlist language updated (0 credits).").waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "创建监控与价格提醒" }).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/lookup`);
    await page.getByRole("heading", { name: "Upload & barcode recognition" }).waitFor();
    await page.getByRole("button", { name: "Identify barcode" }).click();
    await page.getByText(/multiple_versions/).waitFor();
    await page.getByLabel(/Confirmed search keyword/).fill(x.q.q);
    await page.getByRole("button", { name: "Confirm & Run Sold Lookup" }).click();
    await page.getByText("Confirmed sold lookup submitted.").waitFor();
    await page.getByRole("link", { name: "Open confirmed sold lookup" }).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "图片上传与条码识别" }).waitFor();
    await page.getByRole("link", { name: "查看已提交的成交查询" }).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/inventory`);
    await page.getByRole("heading", { name: "Import inventory & preview mapping" }).waitFor();
    const invCsv = page.locator("[data-inventory-csv]");
    await invCsv.fill(
      [
        "sku,title,quantity,currency,q",
        `SKU-MATCH,Matched Stock Lot,2,USD,${x.q.q}`,
        "SKU-NOMODEL,Missing Model Box,1,USD,",
        `SKU-EUR,Non USD Item,1,EUR,${x.q.q}`,
      ].join("\n"),
    );
    await page.getByRole("button", { name: "Preview mapping & cost", exact: true }).click();
    await page.getByText(/Mapped: 1 · Missing model: 1 · Non-USD: 1/).waitFor();
    await page.getByRole("checkbox", { name: /I agree to submit mapped comparable queries/ }).check();
    await page.getByRole("button", { name: "Create valuation", exact: true }).click();
    await page.getByText("Inventory valuation created (0 upfront credits charged).").waitFor();
    while (await x.query.workOnce("inventory-browser-worker")) {
      // process mapped SKU query
    }
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await page.getByRole("button", { name: "Claim ready", exact: true }).click();
    await page.getByText(/Valued 1\/3 SKUs \(2\/4 units\)/).waitFor();
    await page.getByText("N/A (not zero)").first().waitFor();
    const invDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV", exact: true }).click();
    const invCsvExport = await readFile(await (await invDownload).path(), "utf8");
    assert.match(invCsvExport, /SKU-MATCH/);
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "导入库存清单与映射预览" }).waitFor();
    await page.getByText("未知（非零）").first().waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/sites`);
    await page
      .getByRole("heading", {
        name: "Explicit regional site research (US / UK / DE / FR / IT / ES / CA / AU)",
      })
      .waitFor();
    await page.getByText(/ebay_uk · eBay United Kingdom/).waitFor();
    await page.getByText(/ebay_de · eBay Deutschland/).waitFor();
    await page.getByText(/ebay_fr · eBay France/).waitFor();
    await page.getByText(/ebay_ca · eBay Canada/).waitFor();
    await page.getByText(/ebay_au · eBay Australia/).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page
      .getByRole("heading", { name: "显式区域站点研究（美 / 英 / 德 / 法 / 意 / 西 / 加 / 澳）" })
      .waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    await page.goto(`${origin}/en-GB/sites`);
    await page.getByRole("heading", { name: "SoldBench United Kingdom (eBay UK · GBP)" }).waitFor();
    await page.goto(`${origin}/de/sites`);
    await page.getByRole("heading", { name: "SoldBench Deutschland (eBay DE · EUR)" }).waitFor();
    await page.getByText("Versandkosten", { exact: true }).waitFor();
    await page.goto(`${origin}/fr/sites`);
    await page.getByRole("heading", { name: "SoldBench France (eBay FR · EUR)" }).waitFor();
    await page.getByText("Frais de livraison", { exact: true }).waitFor();
    await page.goto(`${origin}/fr-CA/sites`);
    await page.getByRole("heading", { name: "SoldBench Canada Français (eBay CA · CAD)" }).waitFor();
    await page.getByText("Livraison", { exact: true }).waitFor();
    const mercariSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
    await db.query("UPDATE sources SET marketplace='mercari_us' WHERE id=$1", [mercariSource.sourceId]);
    const mercariSvc = new SecondMarketplaceService(x.query);
    for (let i = 0; i < 8; i++) {
      await mercariSvc.ingestRecord({
        marketplace: "mercari_us",
        sourceId: mercariSource.sourceId,
        listingId: `chrome-m-${i}`,
        eventKey: `chrome-evt-${i}`,
        listingState: "sold",
        queryKeyword: "Nintendo Switch OLED",
        title: `Mercari Switch #${i}`,
        currency: "USD",
        itemMinor: 22000 + i * 500,
        shippingMinor: 0,
        shippingStatus: "verified_free_shipping",
        salePriceStatus: "verified_actual",
        conditionRaw: "Good",
        observedAt: x.now(),
        soldAt: x.now(),
        retentionUntil: new Date(Date.parse(x.now()) + 86400000).toISOString(),
      });
    }
    await mercariSvc.ingestRecord({
      marketplace: "mercari_us",
      sourceId: mercariSource.sourceId,
      listingId: "chrome-m-active",
      eventKey: "chrome-evt-active",
      listingState: "active",
      queryKeyword: "Nintendo Switch OLED",
      title: "High Active Switch",
      currency: "USD",
      itemMinor: 77700,
      shippingMinor: 0,
      shippingStatus: "verified_free_shipping",
      salePriceStatus: "displayed_only",
      conditionRaw: "New",
      observedAt: x.now(),
      retentionUntil: new Date(Date.parse(x.now()) + 86400000).toISOString(),
    });
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/marketplaces`);
    await page
      .getByRole("heading", {
        name: "Second marketplace vertical candidate matrix (Mercari US first vertical)",
      })
      .waitFor();
    await page.getByText(/mercari_us · Mercari US \(USD\) · selected_first_vertical/).waitFor();
    await page.getByRole("button", { name: "Preview Mercari US sold & active", exact: true }).click();
    await page.getByText(/Sold stats \(USD\): verified=8\/8/).waitFor();
    await page.getByText(/Active listings \(excluded_from_sold_stats=true\): count=1/).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page
      .getByRole("heading", {
        name: "第二平台纵向候选矩阵（首发闭环：Mercari US）",
      })
      .waitFor();
    await page.getByRole("button", { name: "预览 Mercari US 已售与在售", exact: true }).click();
    await page.getByText(/已售统计（USD）：已核验=8\/8/).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    const tcgSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
    const psaSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
    await db.query("UPDATE sources SET marketplace='tcgplayer_us' WHERE id=$1", [tcgSource.sourceId]);
    await db.query("UPDATE sources SET marketplace='psa_registry' WHERE id=$1", [psaSource.sourceId]);
    const cardsSvc = new CardsVerticalService(x.query);
    for (let i = 0; i < 8; i++) {
      await cardsSvc.ingestCardSale({
        productId: "tcg-pkmn-base-4-1st",
        sourceId: tcgSource.sourceId,
        eventKey: `chrome-card-${i}`,
        gradingState: "graded",
        gradingCompany: "PSA",
        gradeValue: "10",
        edition: "1st_edition",
        currency: "USD",
        itemMinor: 420000 + i * 5000,
        shippingMinor: 0,
        shippingStatus: "verified_free_shipping",
        salePriceStatus: "verified_actual",
        soldAt: x.now(),
        retentionUntil: new Date(Date.parse(x.now()) + 86400000).toISOString(),
      });
    }
    await cardsSvc.ingestGradingPopulation({
      productId: "tcg-pkmn-base-4-1st",
      sourceId: psaSource.sourceId,
      gradingCompany: "PSA",
      gradeValue: "10",
      popCount: 121,
      popHigherCount: 0,
      asOf: x.now(),
      retentionUntil: new Date(Date.parse(x.now()) + 86400000).toISOString(),
    });
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/cards`);
    await page
      .getByRole("heading", {
        name: "Structured TCG & graded card catalog (product ID authority)",
      })
      .waitFor();
    await page.getByText(/tcg-pkmn-base-4-1st · Charizard \(BS1 #4\/102/).waitFor();
    await page.getByLabel("Structured card product_id").selectOption("tcg-pkmn-base-4-1st");
    await page.getByRole("button", { name: "Evaluate card comps & registry pop", exact: true }).click();
    await page.getByText(/Sold stats \(graded · 1st_edition\): verified=8/).waitFor();
    await page.getByText(/Grading population \(is_sold_transaction=false · status=available\)/).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page
      .getByRole("heading", {
        name: "结构化卡牌与评级目录（以标准产品 ID 为唯一身份权威）",
      })
      .waitFor();
    await page.getByLabel("标准卡牌产品 ID").selectOption("tcg-pkmn-base-4-1st");
    await page.getByRole("button", { name: "查询卡牌成交与评级数量", exact: true }).click();
    await page.getByText(/评级分布参考（非成交交易 is_sold_transaction=false · 状态=available）/).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    const goldinSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
    await db.query("UPDATE sources SET marketplace='goldin_us' WHERE id=$1", [goldinSource.sourceId]);
    const aucSvc = new AuctionsVerticalService(x.query);
    const aucSession = await aucSvc.upsertSession({
      house: "goldin_us",
      sessionCode: "CHROME-AUC-2026",
      sessionName: "Chrome Auction Test",
      currency: "USD",
      taxSemantics: "sales_tax_excluded",
      closedAt: x.now(),
    });
    for (let i = 0; i < 8; i++) {
      await aucSvc.ingestLot({
        house: "goldin_us",
        sessionId: aucSession.id,
        sourceId: goldinSource.sourceId,
        lotNumber: `C-${i}`,
        eventKey: `chrome-lot-${i}`,
        queryKeyword: "1986 Fleer Jordan",
        title: `1986 Fleer Jordan #57 Lot ${i}`,
        gradingCompany: "PSA",
        gradeValue: "10",
        certNumber: `99900${i}`,
        currency: "USD",
        hammerMinor: 200000 + i * 10000,
        buyersPremiumStatus: "known",
        buyersPremiumBps: 2000,
        buyersPremiumMinor: Math.round((200000 + i * 10000) * 0.2),
        saleStatus: "sold",
        soldAt: x.now(),
        retentionUntil: new Date(Date.parse(x.now()) + 86400000).toISOString(),
      });
    }
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/auctions`);
    await page
      .getByRole("heading", {
        name: "Auction house onboarding catalog (Goldin US first auction vertical)",
      })
      .waitFor();
    await page.getByText(/goldin_us · Goldin Auctions US \(USD\)/).waitFor();
    await page.getByRole("button", { name: "Query Goldin US lots", exact: true }).click();
    await page.getByText(/Auction stats \(total_with_premium · USD\): verified=8\/8/).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page
      .getByRole("heading", {
        name: "拍卖渠道接入目录（首发拍卖闭环：Goldin US）",
      })
      .waitFor();
    await page.getByRole("button", { name: "查询 Goldin US 拍品", exact: true }).click();
    await page.getByText(/拍卖统计（total_with_premium · USD）：已核验=8\/8/).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/billing`);
    await page.getByRole("heading", { name: "Promo credit campaigns" }).waitFor();
    await page.getByRole("heading", { name: "Pricing offer versions (commercial approval gate)" }).waitFor();
    await page.getByText("starter-annual-v2-draft").waitFor();
    await page.getByLabel("Promo code", { exact: true }).fill("LAUNCH50_PREVIEW");
    await page.getByRole("button", { name: "Redeem promo code", exact: true }).click();
    await page.getByText(/Promo granted: LAUNCH50_PREVIEW \(\+50 credits/).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "促销额度活动兑换" }).waitFor();
    await page.getByRole("heading", { name: "版本化报价目录（待商业审批）" }).waitFor();
    await page.getByText(/已兑换促销记录/).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    await page.goto(`${origin}/account/security`);
    await page.getByRole("heading", { name: "Active sessions" }).waitFor();
    await page.getByRole("heading", { name: "Connected OAuth clients" }).waitFor();
    await page.getByRole("heading", { name: "Passkeys" }).waitFor();
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByRole("heading", { name: "已授权 OAuth 客户端" }).waitFor();
    await page.getByRole("heading", { name: "通行密钥" }).waitFor();
    await page.getByRole("link", { name: "English", exact: true }).click();
    await page.getByRole("heading", { name: "Active sessions" }).waitFor();
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Verify identity" }).click();
    await page.getByText("Identity verified.").waitFor();
    await page.getByRole("button", { name: "Set up authenticator" }).click();
    const secret = await page.locator(".security-secrets code").textContent();
    const totp = () => generate({ secret, epoch: Date.parse(x.now()) / 1000 });
    await page
      .getByLabel("Authenticator code", { exact: true })
      .first()
      .fill(await totp());
    await page.getByRole("button", { name: "Activate authenticator" }).click();
    await page.getByText("Authenticator enabled", { exact: true }).waitFor();
    assert.equal(await page.locator(".security-secrets li").count(), 10);
    await page.getByRole("button", { name: "Hide recovery codes" }).click();
    assert.equal(await page.locator(".security-secrets li").count(), 0);
    x.clock.value = new Date(Date.parse(x.now()) + 30000).toISOString();
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Authenticator code", { exact: true }).fill(await totp());
    await page.getByRole("button", { name: "Verify identity" }).click();
    await page.getByText("Identity verified.").waitFor();
    await page.getByRole("button", { name: "Prepare deletion" }).click();
    const receipt = await page.getByRole("textbox", { name: /Save this private receipt/ }).inputValue();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Confirm account deletion" }).click();
    await page.getByText(/Deletion requested ·/).waitFor();
    await page.getByRole("link", { name: "Check a deletion receipt" }).click();
    await page.getByLabel("Private receipt").fill(receipt);
    await page.getByRole("button", { name: "Check deletion status" }).click();
    await page.getByText(/Deletion requested ·/).waitFor();
    assert.ok(!page.url().includes(receipt));
    assert.equal(
      (await db.query("SELECT status FROM users WHERE id=$1", [verifiedUser])).rows[0].status,
      "deleted",
    );
    await page.goto(`${origin}/agents`);
    await page.getByRole("link", { name: "Connect MCP" }).click();
    await page.getByRole("heading", { name: "MCP and Agent Skill" }).waitFor();
    await page.goto(`${origin}/zh-CN/methodology`);
    await page.getByRole("heading", { name: "价格研究方法" }).waitFor();
    await page.getByRole("link", { name: "报告数据问题" }).click();
    await page.getByRole("heading", { name: "支持" }).waitFor();
    assert.deepEqual(mistakes, []);
    console.log(`Browser screenshots saved to ${captures}`);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
