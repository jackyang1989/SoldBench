import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "@soldbench/api";
import { database as createDatabase, isDatabaseConnectionError, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";

const config = loadConfig({});
const database = {
  query: async () => ({ rows: [{ query_worker: "unobserved", query_queue: "within_budget" }] }),
};
const app = createApp(config, database);

test("health and readiness disclose fixture mode without claiming collector availability", async () => {
  const health = await app.request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    data_mode: "offline_fixture",
    collector_enabled: false,
  });
  const ready = await app.request("/ready");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: "ready",
    data_mode: "offline_fixture",
    query_worker: "unobserved",
    query_queue: "within_budget",
  });
  const disconnected = createApp(config, {
    query: async () => {
      throw new Error("fixture_db_offline");
    },
  });
  assert.equal((await disconnected.request("/health")).status, 200);
  assert.equal((await disconnected.request("/ready")).status, 503);
});

test("database connection failure leaves liveness and static pricing available and rechecks readiness", async () => {
  let available = true;
  const temporary = createApp(config, {
    query: async () => {
      if (!available) throw Object.assign(new Error("fixture endpoint details"), { code: "57P01" });
      return { rows: [{ query_worker: "recent", query_queue: "within_budget" }] };
    },
  });
  assert.equal((await temporary.request("/ready")).status, 200);
  available = false;
  const unavailable = await temporary.request("/ready");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("Retry-After"), "2");
  assert.doesNotMatch(await unavailable.text(), /fixture endpoint details/);
  assert.equal((await temporary.request("/health")).status, 200);
  assert.equal((await temporary.request("/zh-CN/pricing")).status, 200);
  available = true;
  assert.equal((await temporary.request("/ready")).status, 200);
});

test("an uncertain commit preserves the original error and discards a broken client without replaying work", async () => {
  const failure = Object.assign(new Error("commit connection lost"), { code: "ECONNRESET" });
  const calls = [];
  const db = {
    connect: async () => ({
      query: async (sql) => {
        calls.push(sql);
        if (sql === "COMMIT") throw failure;
        if (sql === "ROLLBACK") throw new Error("socket is closed");
      },
      release: (discard) => calls.push(discard),
    }),
  };
  await assert.rejects(
    transaction(db, async (c) => c.query("WRITE")),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["BEGIN", "WRITE", "COMMIT", "ROLLBACK", true]);
  assert.equal(isDatabaseConnectionError(failure), true);
  assert.equal(
    isDatabaseConnectionError(Object.assign(new Error("relation missing"), { code: "42P01" })),
    false,
  );
  assert.equal(
    isDatabaseConnectionError(Object.assign(new Error("file missing"), { code: "ENOENT", syscall: "open" })),
    false,
  );
  const pool = createDatabase("postgresql://localhost/soldbench_fixture");
  try {
    assert.equal(pool.listenerCount("error"), 1);
  } finally {
    await pool.end();
  }
});

test("SSR home stays bilingual, synthetic-data disclosed and protected by response headers", async () => {
  for (const [path, locale, requiredText] of [
    ["/", "en", "Sample results use synthetic records."],
    ["/zh-CN", "zh-CN", "示例结果使用合成记录"],
  ]) {
    const response = await app.request(path);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, new RegExp(`<html lang="${locale}"`));
    assert.ok(body.includes(requiredText));
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  }
});

test("public pricing serves both languages without embedding account or sandbox quote data", async () => {
  for (const [path, heading, state] of [
    ["/pricing", "Pricing and credits", "Commercial pricing is pending approval."],
    ["/zh-CN/pricing", "定价与额度", "正式定价有待审批。"],
  ]) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`<h1>${heading}</h1>`));
    assert.ok(html.includes(state));
    assert.ok(html.includes('data-pricing-offers=""'));
    assert.doesNotMatch(html, /purchased_1500|offline-v1|／月|pro_monthly/);
  }
});

test("sold search validates inputs but does not return fake data or bypass authentication", async () => {
  const response = await app.request("/v1/sold?q=Game+Boy+Color");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthenticated");
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  const invalid = await app.request("/v1/sold?q=x&unknown=y");
  assert.equal(invalid.status, 400);
});

test("developer resource groups navigate to both official local language variants and report mounted routes", async () => {
  for (const [locale, reference] of [
    ["en", "API reference"],
    ["zh-CN", "接口参考"],
  ]) {
    const intro = await app.request(`/docs/${locale}/quickstart`, { headers: { Accept: "text/html" } });
    assert.equal(intro.status, 200);
    const html = await intro.text();
    for (const slug of ["api-reference", "rate-limits-and-headers", "integration-tools"]) {
      const path = `/docs/${locale}/${slug}`;
      assert.ok(html.includes(`href="${path}"`));
      const markdown = await app.request(path);
      assert.equal(markdown.status, 200);
      assert.match(markdown.headers.get("Content-Type"), /text\/markdown/);
    }
    assert.ok(html.includes(reference));
  }
  assert.equal((await app.request("/zh-CN/docs")).headers.get("Location"), "/docs/zh-CN/quickstart");
  const response = await app.request("/docs/implementation-status.json");
  const inventory = await response.json();
  const spec = await (await app.request("/openapi.json")).json();
  assert.equal(inventory.schema_version, spec.info.version);
  assert.equal(inventory.operations.length, Object.values(spec.paths).flatMap(Object.keys).length);
  for (const path of [
    "/mcp",
    "/admin/recovery",
    "/admin/support",
    "/v1/categories",
    "/billing/offers",
    "/v1/batches",
    "/v1/batches/preview",
    "/v1/batches/{id}/claim",
    "/v1/batches/{id}/export",
    "/v1/history/coverage",
    "/v1/history",
    "/v1/history/export",
    "/v1/sold/{id}/best-offers",
    "/v1/sold/{id}/best-offers/verify",
    "/v1/sold/{id}/revisions",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/revoke",
    "/v1/oauth/grants",
    "/v1/auth/passkeys",
    "/auth/passkeys/login/verify",
    "/v1/watchlists",
    "/v1/watchlists/{id}/evaluate",
    "/v1/alerts/unsubscribe",
    "/v1/webhooks",
    "/v1/webhooks/deliveries",
    "/v1/lookup/image",
    "/v1/lookup/barcode",
    "/v1/lookup/sessions",
    "/v1/lookup/sessions/{id}/confirm",
  ]) {
    assert.ok(
      inventory.operations.some((op) => op.path === path && op.status === "local_route_present"),
      path,
    );
  }
  const reserve = inventory.operations.find((op) => op.path === "/webhooks/paddle");
  assert.equal(reserve?.status, "local_route_present");
  assert.equal((await app.request("/webhooks/paddle", { method: "POST" })).status, 503);
  assert.match(inventory.acceptance, /not functional, production or stage acceptance/);
});
