import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { database, migrate } from "@soldbench/db";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  servers = [],
  clients = [];
before(() => migrate(db));
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const r of roots) await rm(r, { recursive: true, force: true });
  await db.end();
});
async function setup(options = {}) {
  let app;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) => (app ? app.fetch(r) : new Response(null, { status: 503 })),
  });
  servers.push(server);
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const port = server.address().port,
    x = await createProductFixture(db, roots, { limit: 50, prepareQuery: false, ...options, port });
  app = x.app;
  return { ...x, origin: `http://127.0.0.1:${port}` };
}
async function finish(x, id) {
  for (let i = 0; i < 32; i++) {
    if (
      (await db.query("SELECT compute_status FROM queries WHERE id=$1", [id])).rows[0].compute_status ===
      "completed"
    )
      return;
    await x.query.workOnce("mcp-test-worker");
  }
  throw new Error("expected_query_not_completed");
}
async function clientFor(x, mode = "legacy") {
  const c = new Client(
    { name: "soldbench-integration", version: "1.0.0" },
    { versionNegotiation: { mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );
  clients.push(c);
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${x.origin}/mcp`), {
      authProvider: { token: async () => x.secret },
      requestInit: { redirect: "error" },
    }),
  );
  return c;
}
async function call(c, name, args) {
  return c.callTool({ name, arguments: args });
}
const data = (r) => r.structuredContent;
async function rpc(x, method, params = {}, headers = {}, body) {
  const r = await fetch(`${x.origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${x.secret}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...headers,
    },
    body: body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await r.text();
  return {
    response: r,
    body: text.startsWith("event:")
      ? JSON.parse(
          text
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.slice(5) ?? "null",
        )
      : text
        ? JSON.parse(text)
        : null,
  };
}
test("official SDK legacy client runs queued search/status/explicit claim and free stats with REST reuse and20-row presentation", async () => {
  const x = await setup(),
    c = await clientFor(x),
    tools = await c.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["sold_search", "sold_stats"]);
  const searched = data(await call(c, "sold_search", { action: "search", query: { q: x.q.q } }));
  assert.equal(searched.data.status, "queued");
  assert.equal(searched.meta.credits_charged, 0);
  const queryId = searched.data.query_id,
    jobId = searched.data.job_id;
  assert.equal(data(await call(c, "sold_search", { action: "status", job_id: jobId })).data.status, "queued");
  assert.equal((await x.query.workOnce("mcp-worker")).status, "completed");
  const unpaid = await call(c, "sold_stats", { query_id: queryId });
  assert.equal(unpaid.isError, true);
  assert.equal(data(unpaid).error.code, "result_not_claimed");
  const key = randomUUID(),
    claimed = data(
      await call(c, "sold_search", { action: "claim", query_id: queryId, idempotency_key: key }),
    );
  assert.equal(claimed.meta.credits_charged, 1);
  assert.equal(claimed.data.stats.n_price_verified, 58);
  assert.equal(claimed.data.comps.length, 20);
  assert.ok(claimed.meta.truncation_reasons.includes("mcp_presentation_limit"));
  assert.equal(
    data(await call(c, "sold_search", { action: "claim", query_id: queryId, idempotency_key: key })).meta
      .credits_charged,
    0,
  );
  const stats = data(await call(c, "sold_stats", { query_id: queryId }));
  assert.equal(stats.data.stats.n_price_verified, 58);
  assert.equal(stats.data.comps, undefined);
  assert.equal(stats.meta.returned_comp_count, 0);
  assert.ok(stats.meta.truncation_reasons.includes("stats_only"));
  assert.equal(stats.meta.credits_charged, 0);
  assert.equal(stats.data.quality.comparison_scope.status, "unresolved");
  assert.deepEqual(stats.data.quality.comparison_scope, claimed.data.quality.comparison_scope);
  const rest = await x.query.submit(x.identity, x.q);
  assert.equal(rest.queryId, queryId);
  const restored = await x.query.result(x.identity, queryId, randomUUID());
  assert.equal(restored.data.comps.length, 50);
  assert.deepEqual(restored.data.quality.comparison_scope, stats.data.quality.comparison_scope);
  const logs = await x.audit.list(x.identity, { channel: "mcp", size: 100 });
  assert.equal(logs.items.filter((r) => r.credits_charged === 1).length, 1);
  assert.ok(logs.items.some((r) => r.operation === "sold_stats"));
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM billing_charges WHERE user_id=$1", [x.user])).rows[0].n,
    1,
  );
});
test("official modern client negotiates2026 and independent legacy HTTP probe sees the same two-tool surface", async () => {
  const x = await setup(),
    c = await clientFor(x, "modern");
  assert.equal(c.getProtocolEra(), "modern");
  const tools = await c.listTools();
  assert.equal(tools.tools.length, 2);
  const r = await rpc(x, "tools/list");
  assert.equal(r.response.status, 200);
  assert.deepEqual(r.body.result.tools.map((t) => t.name).sort(), tools.tools.map((t) => t.name).sort());
  const search = data(await call(c, "sold_search", { action: "search", query: { q: x.q.q } }));
  assert.ok(search.data.query_id);
  assert.equal(search.meta.credits_charged, 0);
});
test("MCP denies unauthenticated/cookie/cross-origin/rebinding requests and unsupported methods before business work", async () => {
  const x = await setup();
  for (const [headers, status] of [
    [{ Authorization: "" }, 401],
    [{ Cookie: "soldbench_session=fixture" }, 400],
    [{ Origin: "https://evil.example" }, 403],
  ]) {
    const r = await rpc(x, "tools/list", {}, headers);
    assert.equal(r.response.status, status, JSON.stringify(headers));
  }
  const rebinding = await new Promise((resolve, reject) => {
    const req = request(
      `${x.origin}/mcp`,
      {
        method: "POST",
        headers: {
          Host: "evil.example",
          Authorization: `Bearer ${x.secret}`,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
  assert.equal(rebinding, 403);
  const r = await fetch(`${x.origin}/mcp`, { headers: { Authorization: `Bearer ${x.secret}` } });
  assert.equal(r.status, 405);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM queries WHERE user_id=$1", [x.user])).rows[0].n,
    0,
  );
});
test("MCP scope, key revocation and source withdrawal use the same owner guards as REST", async () => {
  const x = await setup(),
    c = await clientFor(x),
    r = data(await call(c, "sold_search", { action: "search", query: { q: x.q.q } })),
    id = r.data.query_id;
  await finish(x, id);
  await call(c, "sold_search", { action: "claim", query_id: id, idempotency_key: randomUUID() });
  await db.query("UPDATE api_keys SET scopes=ARRAY['sold:read'] WHERE user_id=$1", [x.user]);
  const scope = await call(c, "sold_search", { action: "status", job_id: r.data.job_id });
  assert.equal(scope.isError, true);
  assert.equal(data(scope).error.code, "forbidden");
  await x.store.stop(x.source.sourceId, "offline");
  assert.equal(data(await call(c, "sold_stats", { query_id: id })).meta.source_status, "stopped");
  await db.query(
    "UPDATE source_clearances SET status='revoked' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId],
  );
  const revoked = await call(c, "sold_stats", { query_id: id });
  assert.equal(revoked.isError, true);
  assert.equal(data(revoked).error.code, "forbidden");
  await db.query("UPDATE api_keys SET revoked_at=$2 WHERE user_id=$1", [x.user, x.now()]);
  await assert.rejects(call(c, "sold_stats", { query_id: id }));
});
test("MCP invalid tool parameters and JSON-RPC batches cannot create queries or charges", async () => {
  const x = await setup(),
    c = await clientFor(x);
  try {
    const r = await call(c, "sold_search", { action: "search", query: { q: x.q.q, owner: "forged" } });
    assert.equal(r.isError, true);
  } catch (e) {
    assert.match(String(e), /invalid|validation|schema|parameter/i);
  }
  await assert.rejects(call(c, "does_not_exist", {}));
  const batch = await rpc(
    x,
    "",
    {},
    {},
    JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "sold_search", arguments: { action: "search", query: { q: x.q.q } } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sold_search", arguments: { action: "search", query: { q: x.q.q } } },
      },
    ]),
  );
  assert.ok(batch.response.status >= 400 || batch.body.error);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM queries WHERE user_id=$1", [x.user])).rows[0].n,
    0,
  );
  const large = await rpc(
    x,
    "tools/list",
    {},
    {},
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", padding: "x".repeat(140000) }),
  );
  assert.equal(large.response.status, 413);
});
test("MCP low sample is free and data with withdrawn row fields remains unavailable across both tools", async () => {
  const x = await setup({ count: 7, extra: false }),
    c = await clientFor(x),
    r = data(await call(c, "sold_search", { action: "search", query: { q: x.q.q } }));
  await finish(x, r.data.query_id);
  let stats = data(await call(c, "sold_stats", { query_id: r.data.query_id }));
  assert.equal(stats.data.stats.median_cents, null);
  assert.equal(stats.meta.credits_charged, 0);
  await db.query(
    "UPDATE source_clearances SET permitted_fields='{}' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId],
  );
  const result = data(await call(c, "sold_search", { action: "result", query_id: r.data.query_id }));
  assert.equal(result.data.comps.length, 0);
  assert.equal(result.meta.permitted_comp_count, 0);
  stats = data(await call(c, "sold_stats", { query_id: r.data.query_id }));
  assert.equal(stats.data.stats.n_price_verified, 7);
  assert.equal(stats.meta.credits_charged, 0);
});

test("MCP insufficient balance keeps a ready result unclaimed, then the same idempotency key succeeds after a legitimate grant", async () => {
  const x = await setup(),
    c = await clientFor(x);
  await db.query("UPDATE users SET free_anchor_at=NULL WHERE id=$1", [x.user]);
  const r = data(await call(c, "sold_search", { action: "search", query: { q: x.q.q } })),
    id = r.data.query_id,
    key = randomUUID();
  await finish(x, id);
  let claimed = await call(c, "sold_search", { action: "claim", query_id: id, idempotency_key: key });
  assert.equal(claimed.isError, true);
  assert.equal(data(claimed).error.code, "insufficient_credits");
  assert.equal(
    (await db.query("SELECT settlement_status FROM queries WHERE id=$1", [id])).rows[0].settlement_status,
    "pending",
  );
  await x.billing.grant(x.user, {
    kind: "promo",
    provider: "synthetic",
    reference: randomUUID(),
    amount: 1,
    expiresAt: new Date(Date.parse(x.now()) + 86400000),
  });
  claimed = await call(c, "sold_search", { action: "claim", query_id: id, idempotency_key: key });
  assert.equal(claimed.isError, undefined);
  assert.equal(data(claimed).meta.credits_charged, 1);
  assert.equal(data(await call(c, "sold_stats", { query_id: id })).meta.credits_charged, 0);
});
test("a cancelled streaming MCP request body is bounded and never reaches a business action", async () => {
  const x = await setup(),
    controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"jsonrpc":'));
      },
      cancel() {
        cancelled = true;
      },
    }),
    pending = x.app.request(`${x.origin}/mcp`, {
      method: "POST",
      headers: { ...x.headers, "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
      signal: controller.signal,
    });
  setTimeout(() => controller.abort(), 20);
  const r = await pending;
  assert.equal(r.status, 408);
  assert.equal(cancelled, true);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM queries WHERE user_id=$1", [x.user])).rows[0].n,
    0,
  );
});
