import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, availableParallelism, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { createApp } from "@soldbench/api";
import { localAuthSecrets } from "@soldbench/auth";
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

test("the live API serves delivered results through a stalled and killed query worker and its replacement", async () => {
  const state = await mkdtemp(join(tmpdir(), "soldbench-worker-supervision-"));
  roots.push(state);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const origin = `http://127.0.0.1:${port}`,
    x = await createProductFixture(db, roots, {
      port,
      count: 8,
      clockValue: new Date().toISOString(),
      authSecrets: localAuthSecrets(state),
    });
  const dev = spawn(process.execPath, ["scripts/dev.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      APP_ORIGIN: origin,
      LOCAL_STATE_ROOT: state,
      MEDIA_ROOT: roots.at(-1),
      PAYMENT_FIXTURES: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(dev, "close");
  let logs = "";
  dev.stdout.on("data", (bytes) => {
    logs += bytes;
  });
  dev.stderr.on("data", (bytes) => {
    logs += bytes;
  });
  const poll = async (label, check) => {
    for (let i = 0; i < 120; i++) {
      try {
        const value = await check();
        if (value) return value;
      } catch (error) {
        if (!(error instanceof TypeError) || !error.cause) throw error;
      }
      await wait(50);
    }
    assert.fail(`${label}\n${logs}`);
  };
  const live = { ...x, origin };
  const readiness = async () => {
    const response = await read(live, "/ready");
    assert.equal(response.status, 200);
    return response.json();
  };
  let stopped;
  try {
    const initial = await poll(
      "query worker started",
      () => logs.match(/"event":"query_worker_started","pid":(\d+)/)?.[1],
    );
    await poll("query worker heartbeat", async () => (await readiness()).query_worker === "recent");
    const original = await counts(x);
    process.kill(Number(initial), "SIGSTOP");
    stopped = Number(initial);
    await db.query("UPDATE worker_heartbeats SET last_cycle_at=now()-interval '31 seconds'");
    const response = await start(live, { limit: 1 });
    assert.equal(response.status, 202);
    const request = (await response.json()).data;
    await db.query("UPDATE query_jobs SET available_at=now()-interval '16 seconds' WHERE id=$1", [
      request.job_id,
    ]);
    assert.deepEqual(await readiness(), {
      status: "ready",
      data_mode: "offline_fixture",
      query_worker: "stale",
      query_queue: "delayed",
    });
    for (const path of ["/health", `/v1/sold/${x.queryId}`, "/v1/usage"])
      assert.equal((await read(live, path)).status, 200, path);
    process.kill(stopped, "SIGKILL");
    stopped = undefined;
    await poll("query worker isolated crash recorded", () =>
      logs.includes('"signal":"SIGKILL","restart_ms":1000'),
    );
    assert.equal((await read(live, `/v1/sold/${x.queryId}`)).status, 200);
    await poll("replacement completed the queued query", async () => {
      const job = await read(live, `/v1/jobs/${request.job_id}`);
      assert.equal(job.status, 200);
      return (await job.json()).data.status === "completed";
    });
    await poll("replacement heartbeat", async () => (await readiness()).query_worker === "recent");
    assert.equal((await readiness()).query_queue, "within_budget");
    assert.deepEqual(await counts(x), original);
    assert.equal((await read(live, `/v1/sold/${request.query_id}`)).status, 409);
    for (const [index, delay] of [
      [2, 2000],
      [3, 4000],
      [4, null],
    ]) {
      const pid = await poll(
        `replacement process ${index} started`,
        () => [...logs.matchAll(/"event":"query_worker_started","pid":(\d+)/g)][index - 1]?.[1],
      );
      process.kill(Number(pid), "SIGKILL");
      await poll(`restart budget advances to ${delay}`, () =>
        logs.includes(`"signal":"SIGKILL","restart_ms":${delay}`),
      );
      assert.equal((await read(live, `/v1/sold/${x.queryId}`)).status, 200);
    }
  } finally {
    if (stopped) process.kill(stopped, "SIGCONT");
    dev.kill("SIGTERM");
    await exited;
  }
});

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

test("measure private result reads at 1, 50 and 200 items, preserving media rights and query charges", async (t) => {
  const x = await create({ count: 200, extra: false, limit: 1, claimed: false });
  const snapshots = [];
  const original = await counts(x);
  const secondaryId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`capacity-${randomUUID()}@example.test`, x.now()],
    )
  ).rows[0].id;
  const secondaryKey = x.auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'capacity',$2,'sb_k_test',ARRAY['sold:read','jobs:read'])",
    [secondaryId, x.auth.crypto.hash("auth.api-key", secondaryKey)],
  );
  const secondary = { ...x, user: secondaryId, headers: { Authorization: `Bearer ${secondaryKey}` } };
  for (const limit of [1, 50, 200]) {
    const id = limit === 1 ? x.queryId : await current(x, { limit });
    const secondaryQuery = await current(secondary, { limit });
    const delivered = await claim(x, id);
    assert.equal(delivered.status, 200);
    const result = await delivered.json();
    assert.equal(result.meta.credits_charged, 1);
    assert.equal(result.data.comps.length, limit);
    assert.equal(result.data.stats.n_price_verified, 200);
    assert.equal(result.meta.candidate_set_hash, snapshots[0]?.hash ?? result.meta.candidate_set_hash);
    const same = await (await claim(secondary, secondaryQuery)).json();
    assert.equal(same.meta?.credits_charged, 1);
    assert.equal(same.meta?.candidate_set_hash, result.meta.candidate_set_hash);
    snapshots.push({ limit, id, secondaryQuery, hash: result.meta.candidate_set_hash });
  }
  const connect = db.connect;
  const queries = { transaction: 0, image: 0 };
  db.connect = function (...args) {
    const client = Reflect.apply(connect, this, args);
    if (args.length) return client;
    return client.then(
      (connected) =>
        new Proxy(connected, {
          get(target, key) {
            if (key === "query")
              return (sql, ...params) => {
                queries.transaction++;
                if (typeof sql === "string" && sql.includes("FROM listing_images i JOIN sources src"))
                  queries.image++;
                return target.query(sql, ...params);
              };
            const value = target[key];
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
  };
  const measure = async ({ limit, id, secondaryQuery }, expectedImage) => {
    x.clock.value = new Date(Date.parse(x.now()) + 60000).toISOString();
    queries.transaction = 0;
    queries.image = 0;
    const sizes = [];
    const times = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const began = performance.now();
        const response = await read(
          index < 25 ? x : secondary,
          `/v1/sold/${index < 25 ? id : secondaryQuery}?sort=price_asc`,
        );
        assert.equal(response.status, 200);
        const text = await response.text();
        const result = JSON.parse(text);
        sizes.push(Buffer.byteLength(text));
        assert.equal(result.data.stats.n_price_verified, 200);
        assert.equal(result.data.comps.length, limit);
        assert.equal(result.data.comps[0].primary_image.state, expectedImage);
        assert.equal(result.meta.credits_charged, 0);
        return performance.now() - began;
      }),
    );
    times.sort((a, b) => a - b);
    assert.equal(queries.image, expectedImage === "available" ? 50 : 0);
    const percentile = (p) => Number(times[Math.ceil(times.length * p) - 1].toFixed(2));
    t.diagnostic(
      JSON.stringify({
        measurement: "local_private_result_http",
        limit,
        expectedImage,
        requests: 50,
        image_sql_per_request: queries.image / 50,
        transaction_sql_per_request: queries.transaction / 50,
        largest_response_bytes: Math.max(...sizes),
        latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
        commercial_slo_verified: false,
      }),
    );
  };
  try {
    for (const snapshot of snapshots) await measure(snapshot, "available");
    await db.query(
      `UPDATE source_clearances SET permitted_fields=jsonb_set(permitted_fields,'{research}',(permitted_fields->'research')-'primary_image')
        WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)`,
      [x.source.sourceId],
    );
    await measure(snapshots.at(-1), "not_permitted");
  } finally {
    db.connect = connect;
  }
  assert.deepEqual(await counts(x), { ...original, charges: original.charges + 3 });
  assert.deepEqual(await counts(secondary), { ...original, charges: 3 });
  assert.deepEqual(await x.billing.reconcile(x.user), []);
  assert.deepEqual(await x.billing.reconcile(secondary.user), []);
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
