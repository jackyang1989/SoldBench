import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { database, migrate } from "@soldbench/db";
import { PublicResults } from "@soldbench/query";
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
      "/account/usage",
      "/account/logs",
      "/account/keys",
      "/playground",
      "/support",
      "/categories",
      "/data-availability",
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
  for (const [extension, mime] of [
    ["css", "text/css"],
    ["js", "text/javascript"],
  ]) {
    const response = await x.app.request(`/assets/soldbench.${extension}`);
    assert.match(response.headers.get("content-type"), new RegExp(mime));
  }
});

test("Chrome walks an empty account from cache miss and registration to explicit claim and free reuse", {
  skip: !process.env.SOLDBENCH_BROWSER_MODULE || !process.env.SOLDBENCH_BROWSER_BINARY,
}, async () => {
  const { chromium } = await import(process.env.SOLDBENCH_BROWSER_MODULE);
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
    app = x.app;
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
    await page.goto(`${origin}/support`);
    await page.getByRole("textbox", { name: "What happened?" }).fill("Synthetic request to verify the form.");
    const intake = () => page.waitForResponse((response) => response.url().endsWith("/support/requests"));
    const firstIntake = intake();
    await page.getByRole("button", { name: "Submit request" }).click();
    const firstReceipt = (await (await firstIntake).json()).data.request_id;
    await page.getByText(`Request received · ${firstReceipt}`).waitFor();
    const secondIntake = intake();
    await page.getByRole("button", { name: "Submit request" }).click();
    assert.equal((await (await secondIntake).json()).data.request_id, firstReceipt);
    await page.goto(`${origin}/?q=Nintendo+Switch`);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText("Cached result · 4 lookups left today").waitFor();
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
    await page.getByRole("button", { name: "Claim result" }).click();
    await page.getByText(/This research originally used 1 credit/).waitFor();
    assert.equal(claimRequests.length, 1);
    assert.equal(claimRequests[0], `web-claim-${id}`);
    await page.getByRole("img", { name: "Sale photo" }).first().waitFor();
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
    const beforeLanguage = requests.length;
    await page.getByRole("link", { name: "简体中文" }).click();
    await page.getByText(/本次扣费 0 个额度/).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("result"), id);
    assert.equal(requests.length, beforeLanguage);
    await page.goto(`${origin}/account`);
    await page.getByRole("heading", { name: "Recent research" }).waitFor();
    await page.locator(`a[href="/results/${id}"]`).click();
    await page.getByText(/0 credits charged for this request/).waitFor();
    assert.equal(new URL(page.url()).pathname, `/results/${id}`);
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
    assert.deepEqual(mistakes, []);
    console.log(`Browser screenshots saved to ${captures}`);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
