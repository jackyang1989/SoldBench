import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  LoopbackHttpTransport,
  OfflineCollectorWorker,
  provisionFixtureSource,
  TransportReadError,
} from "@soldbench/collector";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";

const db = database(process.env.DATABASE_URL),
  roots = [],
  servers = [];
before(() => migrate(db));
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const p of roots) await rm(p, { recursive: true, force: true });
  await db.end();
});
async function fixture(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const reader = (origin, path = "/", options = {}) =>
  new LoopbackHttpTransport({ origin, routes: [{ key: "page:start", path, ...options.route }], ...options });
async function root() {
  const p = await mkdtemp(join(tmpdir(), "soldbench-http-"));
  roots.push(p);
  return p;
}

test("HTTP origin and fixed routes cannot select external hosts, credentials, redirects or arbitrary keys", async () => {
  for (const origin of [
    "https://ebay.com",
    "http://localhost:1234",
    "http://127.0.0.2:1234",
    "http://user:secret@127.0.0.1:1234",
    "http://127.0.0.1:1234/other",
  ])
    assert.throws(() => reader(origin), /loopback_origin_required/);
  for (const path of ["https://ebay.com/", "//ebay.com/", "/\\ebay.com/", "/ok#fragment"])
    assert.throws(() => reader("http://127.0.0.1:1234", path), /invalid_http_route/);
  await assert.rejects(reader("http://127.0.0.1:1234").read("page:unknown"), /http_route_missing/);
});
test("HTTP stream reads exact bytes without cookies or caller credentials and supports numeric/date Retry-After", async () => {
  let headers;
  const { origin } = await fixture((req, res) => {
    headers = req.headers;
    res.writeHead(429, {
      "content-type": "text/html",
      "retry-after": req.url === "/date" ? "Tue, 17 Nov 2026 12:00:03 GMT" : "2",
    });
    res.end("fixture-body");
  });
  const response = await reader(origin).read("page:start");
  assert.equal(response.status, 429);
  assert.equal(response.retryAfterSeconds, 2);
  assert.equal(Buffer.from(response.bytes).toString(), "fixture-body");
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(
    (await reader(origin, "/date", { clock: () => Date.parse("2026-11-17T12:00:00Z") }).read("page:start"))
      .retryAfterSeconds,
    3,
  );
});
test("HTTP redirect, compression and declared/streamed body overflow fail before becoming parser inputs", async () => {
  let followed = 0;
  const { origin } = await fixture((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/target" });
      res.end();
    } else if (req.url === "/target") {
      followed++;
      res.end("not reached");
    } else if (req.url === "/compressed") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end("compressed");
    } else if (req.url === "/declared") {
      res.writeHead(200, { "content-length": 1000 });
      res.end("small");
    } else {
      res.writeHead(200);
      res.write("12345678");
      res.end("9");
    }
  });
  for (const [path, code] of [
    ["/redirect", "http_redirect_rejected"],
    ["/compressed", "http_encoding_rejected"],
    ["/declared", "response_exceeds_budget"],
    ["/chunked", "response_exceeds_budget"],
  ])
    await assert.rejects(
      reader(origin, path, { route: { maxBytes: 8 } }).read("page:start"),
      (e) => e instanceof TransportReadError && e.message === code,
    );
  assert.equal(followed, 0);
});
test("HTTP overall deadline, abort and interrupted body destroy sockets and preserve partial byte facts", async () => {
  const { origin } = await fixture((req, res) => {
    res.writeHead(200);
    res.write("abc");
    if (req.url === "/interrupt") setTimeout(() => res.destroy(), 20);
  });
  await assert.rejects(
    reader(origin, "/wait", { timeoutMs: 100 }).read("page:start"),
    (e) => e.message === "http_request_timeout" && e.receivedBytes === 3,
  );
  const controller = new AbortController(),
    p = reader(origin).read("page:start", 0, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(p, (e) => e.message === "worker_shutdown" && e.receivedBytes === 3);
  await assert.rejects(
    reader(origin, "/interrupt").read("page:start"),
    (e) => e.message === "http_response_interrupted" && e.receivedBytes === 3,
  );
  await assert.rejects(reader(origin).read("page:start", 0, AbortSignal.abort()), /worker_shutdown/);
});
test("actual HTTP 403 travels through the worker and persists a source stop without committing a page", async () => {
  const { origin } = await fixture((_req, res) => {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("Access denied");
    }),
    clock = "2026-11-17T12:00:00Z",
    source = await provisionFixtureSource(db, clock),
    store = new CollectorStore(db, () => clock),
    job = await store.enqueue({ ...source, queryHash: "d".repeat(64), runKey: "http-refusal", asOf: clock }),
    worker = new OfflineCollectorWorker(store, reader(origin), new PrivateMediaStore(await root()));
  assert.equal((await worker.runOne(source.sourceId, { jobId: job })).status, "failed");
  await assert.rejects(store.claim(source.sourceId), /source_circuit_open/);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM collector_pages WHERE job_id=$1", [job])).rows[0].n,
    0,
  );
});
test("HTTP interrupted requests settle actual partial bytes and retry with a bounded failure count", async () => {
  const { origin } = await fixture((_req, res) => {
      res.writeHead(200);
      res.write("abc");
      setTimeout(() => res.destroy(), 10);
    }),
    clock = { value: "2026-11-17T12:00:00Z" },
    source = await provisionFixtureSource(db, clock.value),
    store = new CollectorStore(db, () => clock.value),
    job = await store.enqueue({
      ...source,
      queryHash: "d".repeat(64),
      runKey: "http-retry",
      asOf: clock.value,
    }),
    worker = new OfflineCollectorWorker(store, reader(origin), new PrivateMediaStore(await root()));
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(
      (await worker.runOne(source.sourceId, { jobId: job })).status,
      attempt === 3 ? "failed" : "retry",
    );
    clock.value = new Date(Date.parse(clock.value) + 60000).toISOString();
  }
  assert.equal((await store.view(job)).attempts, 3);
  const r = (
    await db.query(
      "SELECT sum(actual_bytes)::text bytes,count(*)::int n FROM collector_dispatches WHERE job_id=$1",
      [job],
    )
  ).rows[0];
  assert.equal(r.bytes, "9");
  assert.equal(r.n, 3);
});
test("single command executes real local HTTP HTML pagination and eight primary images into PG and shared statistics", async () => {
  const directory = await root(),
    raw = execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-html-demo.mjs", "--http"],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: directory } },
    ),
    report = JSON.parse(raw);
  assert.equal(report.transport, "loopback_fixture");
  assert.equal(report.status, "completed");
  assert.equal(report.localHttpRequests, 10);
  assert.equal(report.networkRequests, 10);
  assert.equal(report.externalNetworkRequests, 0);
  assert.equal(report.pageCount, 2);
  assert.equal(report.recordEvidenceCount, 8);
  assert.equal(report.availablePrimaryImages, 8);
  assert.equal(report.stats.n_price_verified, 8);
  assert.equal(report.sourceVerified, false);
});
