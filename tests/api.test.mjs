import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "@soldbench/api";
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

test("sold search validates inputs but does not return fake data or bypass authentication", async () => {
  const response = await app.request("/v1/sold?q=Game+Boy+Color");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthenticated");
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  const invalid = await app.request("/v1/sold?q=x&unknown=y");
  assert.equal(invalid.status, 400);
});
