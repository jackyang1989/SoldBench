import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { arch, availableParallelism, platform, totalmem } from "node:os";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "@soldbench/api";
import { PaymentLifecycle } from "@soldbench/billing";
import { database, migrate } from "@soldbench/db";
import { PublicResults } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  servers = [];
before(() => migrate(db));
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  await db.end();
});
async function create(options = {}) {
  let app;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req) });
  servers.push(server);
  await new Promise((done) => (server.listening ? done() : server.once("listening", done)));
  const port = server.address().port,
    x = await createProductFixture(db, roots, { ...options, port }),
    config = loadConfig({ PORT: String(port), PAYMENT_FIXTURES: "true" }),
    keys = { stripe: randomBytes(32).toString("hex"), paypal: randomBytes(32).toString("hex") };
  app = createApp(config, db, {
    auth: x.auth,
    query: x.query,
    payments: new PaymentLifecycle(x.billing, config.origin, keys),
  });
  return {
    ...x,
    origin: config.origin,
    session: async () => {
      const token = x.auth.crypto.token("sb_s_"),
        csrf = x.auth.crypto.hash("auth.csrf", token);
      await db.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)",
        [
          x.user,
          x.auth.crypto.hash("auth.session", token),
          x.auth.crypto.hash("auth.csrf-store", csrf),
          x.now(),
          new Date(Date.parse(x.now()) + 86400000),
        ],
      );
      return {
        token,
        headers: { Cookie: `soldbench_session=${token}`, Origin: config.origin, "X-CSRF-Token": csrf },
      };
    },
  };
}
const read = (x, path, options = {}) =>
  fetch(x.origin + path, {
    ...options,
    headers: { ...x.headers, ...options.headers },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
function start(x, { stale = false, limit = x.q.limit } = {}) {
  return read(
    x,
    `/v1/sold?${new URLSearchParams({ q: x.q.q, limit: String(limit), ...(stale ? { allow_stale: "true" } : {}) })}`,
  );
}
function claim(x, id, key = randomUUID()) {
  return read(x, `/v1/sold/${id}/claim`, { method: "POST", headers: { "Idempotency-Key": key } });
}
async function counts(x) {
  return (
    await db.query(
      "SELECT (SELECT count(*)::int FROM billing_charges WHERE user_id=$1) charges,(SELECT count(*)::int FROM collector_jobs) collected",
      [x.user],
    )
  ).rows[0];
}
async function current(x, options) {
  const response = await start(x, options),
    body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body));
  if (body.data.status !== "completed")
    assert.equal((await x.query.workOnce("readiness-query")).status, "completed");
  return body.data.query_id;
}

test("loopback product HTTP serves retained history and account functions during outage, with exact freshness limits and recovery", async (t) => {
  const x = await create(),
    t0 = Date.parse(x.now()),
    original = await counts(x);
  assert.equal(original.charges, 1);
  await x.store.stop(x.source.sourceId, "offline_source_paused");
  for (const elapsed of [0, 86400000, 86400001, 172800000, 259200000, 259200001]) {
    x.clock.value = new Date(t0 + elapsed).toISOString();
    const actor = await x.session();
    for (const path of ["/auth/me", "/v1/keys", "/billing/subscription"]) {
      const reply = await fetch(x.origin + path, {
        headers: actor.headers,
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(reply.status, 200, `${path} at ${elapsed}`);
    }
    assert.equal((await read(x, "/v1/usage")).status, 200);
    const history = await (await read(x, `/v1/sold/${x.queryId}`)).json();
    assert.equal(history.meta.result_mode, "history");
    assert.equal(history.meta.data_mode, "synthetic_fixture");
    assert.equal(history.meta.source_status, "stopped");
    assert.equal(history.meta.credits_charged, 0);
    assert.equal(history.meta.stale, elapsed > 86400000);
    assert.equal(history.data.stats.n_price_verified, 58);
    if (elapsed === 0) {
      const r = await start(x);
      assert.equal(r.status, 202);
      assert.equal((await r.json()).data.query_id, x.queryId);
    } else if (elapsed === 86400000) {
      await current(x); // completes just before the same-parameter reuse crosses the boundary
    } else if (elapsed <= 259200000) {
      const rejected = await start(x);
      assert.equal(rejected.status, 503);
      assert.equal((await rejected.json()).error.code, "source_unavailable");
      const id = await current(x, { stale: true }),
        result = await read(x, `/v1/sold/${id}`),
        body = await result.json();
      assert.equal(result.status, 200);
      assert.equal(body.meta.stale, true);
      assert.equal(body.meta.credits_charged, 0);
      assert.equal(body.data.stats.n_price_verified, 58);
    } else {
      const unavailable = await start(x, { stale: true });
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json()).error.code, "data_expired");
    }
  }
  assert.deepEqual(await counts(x), original);
  const replacement = await createProductFixture(db, roots, {
    prepareQuery: false,
    keyword: x.q.q,
    clockValue: x.now(),
  });
  const fresh = await current(x),
    key = randomUUID(),
    first = await claim(x, fresh, key),
    data = await first.json();
  assert.equal(first.status, 200, JSON.stringify(data));
  assert.equal(data.meta.credits_charged, 1);
  assert.equal(data.meta.stale, false);
  assert.equal(data.data.stats.n_price_verified, 58);
  assert.equal(data.data.comps[0].source_id, replacement.source.sourceId);
  assert.equal((await (await claim(x, fresh, key)).json()).meta.credits_charged, 0);
  assert.equal((await (await start(x)).json()).data.query_id, fresh);
  const final = await counts(x);
  assert.deepEqual(final, { charges: original.charges + 1, collected: original.collected + 1 });
  assert.deepEqual(await x.billing.reconcile(x.user), []);
  t.diagnostic(
    JSON.stringify({
      coverage: "loopback_http_synthetic_outage",
      timestamps_ms: [0, 86400000, 86400001, 172800000, 259200000, 259200001],
      source_recovery: "new_local_fixture_watermark",
      charged_during_outage: 0,
      charge_after_recovery: 1,
    }),
  );
});

test("a newly recovered watermark replaces an invalid in-flight dedupe slot without reviving the old job", async () => {
  const x = await create(),
    t0 = Date.parse(x.now());
  x.clock.value = new Date(t0 + 86400000).toISOString();
  const old = await (await start(x)).json();
  assert.equal(old.data.status, "queued");
  x.clock.value = new Date(t0 + 86400001).toISOString();
  const response = await start(x);
  assert.equal(response.status, 503);
  await createProductFixture(db, roots, { prepareQuery: false, keyword: x.q.q, clockValue: x.now() });
  const fresh = await (await start(x)).json();
  assert.equal(fresh.data.status, "queued");
  assert.notEqual(fresh.data.query_id, old.data.query_id);
  const previous = await (await read(x, `/v1/jobs/${old.data.job_id}`)).json();
  assert.equal(previous.data.status, "expired");
  assert.equal((await x.query.workOnce("fresh-replacement")).status, "completed");
  assert.equal((await (await read(x, `/v1/jobs/${fresh.data.job_id}`)).json()).data.status, "completed");
});

test("measure real loopback cached HTTP latency over three rounds of 50 concurrent shares", async (t) => {
  const x = await create(),
    actor = await x.session(),
    publisher = new PublicResults(x.query);
  await db.query(
    'UPDATE source_clearances SET permitted_fields=permitted_fields||\'{"public_share":["aggregate"]}\' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)',
    [x.source.sourceId],
  );
  const made = await publisher.create(
    await x.auth.sessionIdentity(actor.token),
    x.queryId,
    3600,
    randomUUID(),
    x.origin,
  );
  const url = made.data.url,
    count = await counts(x);
  const warm = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(warm.status, 200);
  await warm.arrayBuffer();
  const samples = [];
  for (let round = 0; round < 3; round++) {
    const values = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const began = performance.now(),
          response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10000) }),
          body = await response.json();
        const duration = performance.now() - began;
        assert.equal(response.status, 200);
        assert.equal(body.data.stats.n_price_verified, 58);
        assert.equal(body.meta.credits_charged, 0);
        return duration;
      }),
    );
    samples.push(...values);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p) => Number(samples[Math.ceil(samples.length * p) - 1].toFixed(2));
  t.diagnostic(
    JSON.stringify({
      measurement: "local_cached_share_http",
      instance: "loopback_hono_and_isolated_pg16",
      platform: platform(),
      arch: arch(),
      logical_parallelism: availableParallelism(),
      host_memory_bytes: totalmem(),
      node: process.versions.node,
      requests: samples.length,
      concurrency: 50,
      http_200: samples.length,
      latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) },
      commercial_slo_verified: false,
    }),
  );
  assert.deepEqual(await counts(x), count);
});

test("an in-flight revoked snapshot can recover on a new authorized watermark without reviving the old result", async () => {
  const x = await create({ prepareQuery: false });
  const old = (await (await start(x)).json()).data;
  const lane = new AsyncLocalStorage(),
    connect = db.connect;
  let acquired,
    unpause,
    connections = 0;
  const paused = new Promise((done) => {
    acquired = done;
  });
  const resume = new Promise((done) => {
    unpause = done;
  });
  db.connect = function (...args) {
    if (lane.getStore() && !args.length && ++connections === 2) {
      acquired();
      return resume.then(() => Reflect.apply(connect, this, args));
    }
    return Reflect.apply(connect, this, args);
  };
  const delayedWorker = lane.run(true, () => x.query.workOnce("old-lease-worker"));
  try {
    await Promise.race([
      paused,
      delayedWorker.then(() => {
        throw new Error("worker_did_not_acquire_old_lease");
      }),
    ]);
    assert.equal((await (await read(x, `/v1/jobs/${old.job_id}`)).json()).data.status, "running");
    await x.store.revokeSource(x.source.sourceId, "simulated_permission_withdrawal");
    assert.equal((await read(x, `/v1/sold/${old.query_id}`)).status, 403);
    x.clock.value = new Date(Date.parse(x.now()) + 1000).toISOString();
    const replacement = await createProductFixture(db, roots, {
      prepareQuery: false,
      keyword: x.q.q,
      clockValue: x.now(),
    });
    const fresh = await current(x);
    assert.notEqual(fresh, old.query_id);
    assert.equal((await (await read(x, `/v1/jobs/${old.job_id}`)).json()).data.status, "expired");
    unpause();
    await delayedWorker;
    assert.equal((await (await read(x, `/v1/jobs/${old.job_id}`)).json()).data.status, "expired");
    assert.equal((await read(x, `/v1/sold/${old.query_id}`)).status, 403);
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM query_results WHERE query_id=$1", [old.query_id])).rows[0]
        .n,
      0,
    );
    const key = randomUUID(),
      got = await (await claim(x, fresh, key)).json();
    assert.equal(got.data.comps[0].source_id, replacement.source.sourceId);
    assert.equal(got.meta.credits_charged, 1);
    assert.equal((await (await claim(x, fresh, key)).json()).meta.credits_charged, 0);
  } finally {
    unpause();
    db.connect = connect;
    await delayedWorker;
  }
});

test("revoking a recently charged snapshot cannot make the same canonical search charge again inside ten minutes", async () => {
  const x = await create(),
    t0 = Date.parse(x.now());
  await x.store.revokeSource(x.source.sourceId, "simulated_permission_withdrawal");
  x.clock.value = new Date(t0 + 1000).toISOString();
  await createProductFixture(db, roots, { prepareQuery: false, keyword: x.q.q, clockValue: x.now() });
  const affected = await start(x),
    error = (await affected.json()).error;
  assert.equal(affected.status, 503);
  assert.equal(error.code, "source_unavailable");
  assert.equal(error.details.retry_after, 599);
  assert.equal(affected.headers.get("Retry-After"), "599");
  assert.equal((await counts(x)).charges, 1);
  x.clock.value = new Date(t0 + 600000).toISOString();
  const fresh = await current(x);
  assert.notEqual(fresh, x.queryId);
  assert.equal((await (await claim(x, fresh)).json()).meta.credits_charged, 1);
});
