import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { database, migrate } from "@soldbench/db";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const mediaRoots = [];
const servers = [];
const password = "Local-persona-only-541!";

before(() => migrate(db));
after(async () => {
  await Promise.all(
    servers.map((server) => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }),
  );
  await Promise.all(mediaRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  await db.end();
});

async function setup(options = {}) {
  let app;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => app.fetch(req),
  });
  servers.push(server);
  await new Promise((done) => (server.listening ? done() : server.once("listening", done)));
  const port = server.address().port;
  const fixture = await createProductFixture(db, mediaRoots, { port, prepareQuery: false, ...options });
  app = fixture.app;
  return { ...fixture, origin: `http://127.0.0.1:${port}` };
}

function http(x, path, { headers, method = "GET", body } = {}) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  return fetch(x.origin + path, {
    method,
    headers: {
      Origin: x.origin,
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
}

async function read(response, expected = 200) {
  const r = await response;
  const body = await r.json();
  assert.equal(r.status, expected, body.error?.code);
  return body;
}

async function account(x, language = "en") {
  const email = `journey-${randomUUID()}@example.test`;
  const headers = { "Accept-Language": language };
  await read(
    http(x, "/auth/register", {
      method: "POST",
      headers,
      body: { email, password, terms_version: "offline-fixture-v1" },
    }),
    202,
  );
  const mail = (
    await db.query(
      "SELECT u.id AS user_id,m.id,m.encrypted_payload FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.purpose='verify_email'",
      [email],
    )
  ).rows[0];
  const message = x.auth.crypto.open(mail.encrypted_payload, `auth.mail:${mail.id}`);
  const token = new URLSearchParams(new URL(message.link).hash.slice(1)).get("token");
  await read(http(x, "/auth/verify-email", { method: "POST", headers, body: { token } }), 202);
  const response = await http(x, "/auth/login", { method: "POST", headers, body: { email, password } });
  const login = await read(response);
  const session = response.headers.get("set-cookie").split(";")[0];
  return {
    user: mail.user_id,
    headers: { ...headers, Cookie: session, "X-CSRF-Token": login.data.csrf_token },
  };
}

async function issueKey(x, owner, scopes) {
  const headers = { ...owner.headers, "Idempotency-Key": randomUUID() };
  const body = { name: "Offline integration", scopes };
  const created = (await read(http(x, "/v1/keys", { method: "POST", headers, body }), 201)).data;
  const duplicate = (await read(http(x, "/v1/keys", { method: "POST", headers, body }))).data;
  assert.equal(duplicate.key, undefined);
  assert.equal(duplicate.key_info.id, created.key_info.id);
  return { token: created.key, id: created.key_info.id, headers: { Authorization: `Bearer ${created.key}` } };
}

function search(x, headers, parameters, web = false) {
  return read(
    web
      ? http(x, "/web/search", { headers, method: "POST", body: parameters })
      : http(x, `/v1/sold?${new URLSearchParams(parameters)}`, { headers }),
    202,
  );
}

function claim(x, id, headers, key = randomUUID()) {
  return http(x, `/v1/sold/${id}/claim`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": key },
  });
}

async function charges(user) {
  return (await db.query("SELECT count(*)::int AS n FROM billing_charges WHERE user_id=$1", [user])).rows[0]
    .n;
}

async function deliver(x, owner, parameters, web = false) {
  const requested = await search(x, owner.headers, parameters, web);
  assert.equal(requested.meta.credits_charged, 0);
  const id = requested.data.query_id;
  assert.equal((await x.query.workOnce("customer-journey-worker")).status, "completed");
  const job = await read(http(x, requested.data.status_url, { headers: owner.headers }));
  assert.equal(job.data.status, "completed");
  const result = await read(claim(x, id, owner.headers));
  assert.equal(result.meta.credits_charged, 1);
  return { id, result };
}

test("personal seller signs up from Worth and gets a price without managing a key", async () => {
  const x = await setup({ count: 30 });
  const parameters = { q: x.q.q, limit: x.q.limit };
  const landing = await http(x, "/worth");
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Search sold prices|What is it worth/);
  const miss = await read(http(x, "/web/search", { method: "POST", body: parameters }), 503);
  assert.equal(miss.error.code, "source_unavailable");
  const owner = await account(x);
  assert.deepEqual((await read(http(x, "/v1/keys", { headers: owner.headers }))).data, []);
  assert.equal(await charges(owner.user), 0);
  const { id, result } = await deliver(x, owner, parameters, true);
  assert.equal(result.data.stats.n_price_verified, 30);
  assert.ok(result.data.stats.median_cents > 0);
  const localized = await read(
    http(x, `/v1/sold/${id}`, {
      headers: { ...owner.headers, "Accept-Language": "zh-CN" },
    }),
  );
  assert.deepEqual(localized.data.stats, result.data.stats);
  assert.equal(localized.meta.credits_charged, 0);
  assert.equal(await charges(owner.user), 1);
});

test("collectibles trader checks the matching image and excludes uncertain offer prices", async () => {
  const x = await setup({ count: 30, limit: 50 });
  const owner = await account(x, "zh-CN");
  const { id } = await deliver(x, owner, { q: x.q.q, limit: 50 }, true);
  const path = `/v1/sold/${id}`;
  const { data: diagnostics } = await read(
    http(x, `${path}/diagnostics?page_size=50`, { headers: owner.headers }),
  );
  const offer = diagnostics.items.find((row) => row.sale_format === "best_offer");
  assert.ok(offer.displayed_price_cents > 0);
  assert.equal(offer.include_in_price_stats, false);
  assert.ok(diagnostics.items.some((row) => row.primary_exclusion_reason === "hard_attribute_mismatch"));
  const expected = (
    await db.query(
      "SELECT sale_event_id FROM query_snapshot_records WHERE query_id=$1 AND candidate->>'eventKey'='event-0'",
      [id],
    )
  ).rows[0];
  const original = diagnostics.items.find((row) => row.sale_event_id === expected.sale_event_id);
  const { data: evidence } = await read(
    http(x, `${path}/comps/${original.sale_event_id}`, { headers: owner.headers }),
  );
  assert.equal(evidence.fields.title.value, original.title);
  assert.equal(evidence.fields.primary_image.value.state, "available");
  const image = await http(x, evidence.fields.primary_image.value.url, { headers: owner.headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/webp");
  assert.equal(
    Buffer.from(await image.arrayBuffer())
      .subarray(8, 12)
      .toString(),
    "WEBP",
  );
  assert.equal(await charges(owner.user), 1);
});

test("second-hand merchant can save two delivered views, compare them and export the evidence", async () => {
  const x = await setup({ count: 30 });
  const owner = await account(x);
  const { id, result } = await deliver(x, owner, { q: x.q.q, limit: x.q.limit }, true);
  const save = (name, ids) =>
    read(
      http(x, "/v1/saved-research", {
        method: "POST",
        headers: owner.headers,
        body: { query_id: id, name, excluded_sale_event_ids: ids },
      }),
    );
  const { data: baseline } = await save("Purchase baseline", []);
  const { data: adjusted } = await save("Purchase review", [result.data.comps[0].sale_event_id]);
  const compare = await read(
    http(x, "/v1/saved-research/compare", {
      method: "POST",
      headers: owner.headers,
      body: {
        left_id: baseline.id,
        right_id: adjusted.id,
        left_view: "authoritative",
        right_view: "adjusted",
      },
    }),
  );
  assert.equal(compare.data.left.query_id, id);
  assert.equal(compare.data.right.query_id, id);
  assert.deepEqual(compare.data.differences, []);
  assert.equal(typeof compare.data.median_delta_cents, "number");
  const csv = await http(x, `/v1/sold/${id}/export`, {
    method: "POST",
    headers: owner.headers,
    body: { format: "csv", view: "authoritative" },
  });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /sale_event_id/);
  assert.equal(await charges(owner.user), 1);
});

test("developer issues a scoped key and reuses a REST delivery in MCP", async () => {
  const x = await setup();
  const owner = await account(x);
  const key = await issueKey(x, owner, ["sold:read", "jobs:read"]);
  const { id, result } = await deliver(x, key, { q: x.q.q, limit: x.q.limit });
  const client = new Client({ name: "soldbench-customer-journey", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", x.origin), {
        authProvider: { token: async () => key.token },
        requestInit: { redirect: "error" },
      }),
    );
    const stats = (await client.callTool({ name: "sold_stats", arguments: { query_id: id } }))
      .structuredContent;
    assert.deepEqual(stats.data.stats, result.data.stats);
    assert.equal(stats.meta.credits_charged, 0);
  } finally {
    await client.close();
  }
  assert.equal((await http(x, "/v1/usage", { headers: key.headers })).status, 403);
  assert.equal(await charges(owner.user), 1);
});

test("SaaS integration recovers an uncertain claim, isolates tenants and audits the single charge", async () => {
  const x = await setup();
  const tenant = await account(x);
  const outsider = await account(x);
  const key = await issueKey(x, tenant, ["sold:read", "jobs:read", "usage:read"]);
  const other = await issueKey(x, outsider, ["sold:read", "jobs:read"]);
  const { data: request } = await search(x, key.headers, { q: x.q.q, limit: x.q.limit });
  const path = `/v1/sold/${request.query_id}`;
  assert.equal((await http(x, path, { headers: key.headers })).status, 409);
  assert.equal(await charges(tenant.user), 0);
  assert.equal((await x.query.workOnce("saas-journey-worker")).status, "completed");
  assert.ok([403, 404].includes((await http(x, path, { headers: other.headers })).status));
  assert.ok([403, 404].includes((await http(x, request.status_url, { headers: other.headers })).status));
  const retryKey = randomUUID();
  const first = await claim(x, request.query_id, key.headers, retryKey);
  assert.equal(first.status, 200);
  const requestId = first.headers.get("X-Request-Id");
  await first.body.cancel();
  const retry = await read(claim(x, request.query_id, key.headers, retryKey));
  assert.equal(retry.data.query_id, request.query_id);
  assert.equal(retry.meta.credits_charged, 0);
  const { data: audit } = await read(http(x, "/v1/requests?operation=sold_claim", { headers: key.headers }));
  const charged = audit.items.filter((row) => row.credits_charged > 0);
  assert.equal(charged.length, 1);
  assert.equal(charged[0].request_id, requestId);
  assert.equal(charged[0].ledger_ids.length, 1);
  assert.equal(await charges(tenant.user), 1);
  assert.equal(await charges(outsider.user), 0);
});

test("professional researcher adjusts the full 58-sale snapshot beyond presentation limit", async () => {
  const x = await setup();
  const owner = await account(x);
  const { id, result } = await deliver(x, owner, { q: x.q.q, limit: 5 }, true);
  assert.equal(result.data.comps.length, 5);
  const path = `/v1/sold/${id}`;
  const exportView = (view, ids) =>
    read(
      http(x, `${path}/export`, {
        method: "POST",
        headers: owner.headers,
        body: { format: "json", view, ...(ids && { excluded_sale_event_ids: ids }) },
      }),
    );
  const authoritative = await exportView("authoritative");
  const last = authoritative.items.at(-1).sale_event_id;
  assert.ok(!result.data.comps.some((row) => row.sale_event_id === last));
  const adjusted = await exportView("adjusted", [last]);
  assert.equal(authoritative.items.length, 58);
  assert.equal(adjusted.items.length, 57);
  assert.equal(adjusted.original_stats.n_price_verified, 58);
  assert.equal(adjusted.price_summary.n_price_verified, 57);
  assert.ok(!adjusted.items.some((row) => row.sale_event_id === last));
  const reopened = await read(http(x, path, { headers: owner.headers }));
  assert.deepEqual(reopened.data.stats, result.data.stats);
  assert.equal(await charges(owner.user), 1);
});
