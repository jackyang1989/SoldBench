import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { database, migrate } from "@soldbench/db";
import { createProductFixture } from "./helpers/product.mjs";

const run = promisify(execFile),
  db = database(process.env.DATABASE_URL),
  roots = [],
  servers = [];
before(() => migrate(db));
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
  }
  for (const p of roots) await rm(p, { recursive: true, force: true });
  await db.end();
});
async function http() {
  let app;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => app.fetch(r) });
  servers.push(server);
  await new Promise((done) => (server.listening ? done() : server.once("listening", done)));
  return {
    server,
    port: server.address().port,
    bind: (value) => {
      app = value;
    },
    origin: `http://127.0.0.1:${server.address().port}`,
  };
}
const commands = [
  [process.execPath, ["developer/examples/sold.ts"]],
  ["python3", ["developer/examples/sold.py"]],
  ["sh", ["developer/examples/sold.sh"]],
];
function client(command, x, claim = true) {
  return run(command[0], [...command[1], ...(claim ? ["--claim"] : [])], {
    env: {
      ...process.env,
      SOLDBENCH_API_KEY: x.secret,
      SOLDBENCH_BASE_URL: `${x.origin}/v1`,
      SOLDBENCH_KEYWORD: x.q.q,
      ...x.extraEnv,
    },
    timeout: 30000,
    maxBuffer: 1048576,
  });
}
async function workerDuring(x, work) {
  let pending = Promise.resolve(),
    busy = false;
  const timer = setInterval(() => {
    if (!busy) {
      busy = true;
      pending = x.query.workOnce("developer-example-worker").finally(() => {
        busy = false;
      });
    }
  }, 30);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await pending;
  }
}
test("public developer assets are bilingual, fixed-path, cacheable and distinguish contract-only operations", async () => {
  const s = await http(),
    x = await createProductFixture(db, roots, { port: s.port });
  s.bind(x.app);
  const get = (path) => fetch(s.origin + path, { redirect: "manual" });
  assert.equal((await get("/docs")).headers.get("Location"), "/docs/en/quickstart");
  for (const locale of ["en", "zh-CN"]) {
    const r = await get(`/docs/${locale}/quickstart`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("Content-Type"), /text\/markdown/);
    const text = await r.text();
    assert.ok(text.includes("developer:demo"));
    const cached = await fetch(`${s.origin}/docs/${locale}/quickstart`, {
      headers: { "If-None-Match": r.headers.get("ETag") },
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
  }
  const index = await (await get("/.well-known/skills/index.json")).json();
  const skill = await get(index.skills[0].url);
  assert.match(await skill.text(), /result_not_claimed/);
  const search = await (await get("/docs/search?q=领取&locale=zh-CN&limit=2")).json();
  assert.equal(search.data.items.length, 2);
  assert.ok(search.data.items.every((p) => p.path.startsWith("/docs/zh-CN/")));
  assert.equal(search.meta.credits_charged, 0);
  assert.equal((await get("/docs/search?q=x&limit=21")).status, 400);
  assert.equal((await get("/docs/search?q=x&q=y")).status, 400);
  assert.equal((await get("/docs/search?q=key&locale=fr")).status, 400);
  assert.equal((await get("/.well-known/skills/soldbench/references/private.md")).status, 404);
  const status = await (await get("/docs/implementation-status.json")).json();
  assert.ok(status.operations.some((o) => o.status === "contract_only"));
  assert.ok(status.operations.find((o) => o.path === "/mcp").status === "local_route_present");
  const spec = await (await get("/openapi.json")).json();
  assert.match(spec.info.version, /^1\.\d+\.\d+$/);
  assert.ok(spec.paths["/mcp"]);
  const collection = await (await get("/soldbench.postman.json")).json();
  assert.equal(collection.variable.find((v) => v.key === "api_key").value, "");
  assert.ok(!JSON.stringify(collection).includes(x.secret));
  assert.match(await (await get("/examples/sold.py")).text(), /NoRedirect/);
  assert.match(await (await get("/llms-full.txt")).text(), /MCP 与 Agent Skill/);
});
test("TypeScript, Python and curl clients execute real queued API/PG flow with one shared claim and no secret output", async () => {
  const s = await http(),
    x = await createProductFixture(db, roots, { port: s.port, prepareQuery: false });
  s.bind(x.app);
  const outputs = await workerDuring(x, async () => {
    const results = [];
    for (const command of commands) {
      const r = await client(command, { ...x, origin: s.origin });
      assert.ok(!r.stdout.includes(x.secret) && !r.stderr.includes(x.secret));
      results.push(JSON.parse(r.stdout));
    }
    return results;
  });
  assert.ok(outputs.every((o) => o.n_price_verified === 58 && o.data_mode === "synthetic_fixture"));
  assert.equal(new Set(outputs.map((o) => o.query_id)).size, 1);
  assert.deepEqual(
    outputs.map((o) => o.credits_charged),
    [1, 0, 0],
  );
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM billing_charges WHERE user_id=$1", [x.user])).rows[0].n,
    1,
  );
});
test("all clients stop at explicit claim boundary without consent", async () => {
  const s = await http(),
    x = await createProductFixture(db, roots, { port: s.port, prepareQuery: false });
  s.bind(x.app);
  await workerDuring(x, async () => {
    for (const command of commands)
      await assert.rejects(client(command, { ...x, origin: s.origin }, false), (e) => {
        assert.equal(JSON.parse(e.stderr).error, "claim_required");
        assert.ok(!e.stderr.includes(x.secret));
        return true;
      });
  });
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM billing_charges WHERE user_id=$1", [x.user])).rows[0].n,
    0,
  );
});
test("all clients reject redirects without forwarding bearer secrets", async () => {
  let received = 0;
  const sink = createServer((_req, res) => {
    received++;
    res.end("unexpected");
  });
  servers.push(sink);
  await new Promise((done) => sink.listen(0, "127.0.0.1", done));
  const redirect = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${sink.address().port}/leak` });
    res.end(JSON.stringify({ error: { code: "redirect_forbidden" } }));
  });
  servers.push(redirect);
  await new Promise((done) => redirect.listen(0, "127.0.0.1", done));
  const curlHome = await mkdtemp(join(tmpdir(), "soldbench-curl-config-"));
  roots.push(curlHome);
  await writeFile(join(curlHome, ".curlrc"), "location\nlocation-trusted\n");
  for (const command of commands)
    await assert.rejects(
      client(command, {
        secret: "sb_k_syntheticOnly",
        q: { q: "fixture" },
        extraEnv: { CURL_HOME: curlHome },
        origin: `http://127.0.0.1:${redirect.address().port}`,
      }),
      (e) => {
        assert.ok(!e.stderr.includes("sb_k_syntheticOnly"));
        return true;
      },
    );
  assert.equal(received, 0);
});
test("all clients preserve the same idempotency key after a transient claim failure", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let searchCount = 0,
    claims = [];
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/v1/sold?")) {
      searchCount++;
      res.writeHead(202);
      res.end(JSON.stringify({ data: { query_id: id, job_id: id } }));
    } else if (req.url.startsWith("/v1/jobs/")) res.end(JSON.stringify({ data: { status: "completed" } }));
    else if (req.method === "POST") {
      claims.push(req.headers["idempotency-key"]);
      if (claims.length === 1) {
        res.writeHead(503, { "Retry-After": "0" });
        res.end(JSON.stringify({ error: { code: "service_unavailable" } }));
      } else
        res.end(
          JSON.stringify({
            data: { stats: { median_cents: 100, n_price_verified: 8 } },
            meta: { credits_charged: 0, data_mode: "synthetic_fixture" },
          }),
        );
    } else {
      res.writeHead(409);
      res.end(JSON.stringify({ error: { code: "result_not_claimed" } }));
    }
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  for (const command of commands) {
    searchCount = 0;
    claims = [];
    await client(command, {
      secret: "sb_k_syntheticOnly",
      q: { q: "fixture" },
      origin: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(searchCount, 1);
    assert.equal(claims.length, 2);
    assert.equal(claims[0], claims[1]);
  }
});
test("developer demo prepares synthetic collector evidence and a private revocable API key without printing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "soldbench-developer-demo-"));
  roots.push(directory);
  const s = await http(),
    env = { ...process.env, COLLECTOR_DEMO_DIR: directory, PORT: String(s.port) };
  const first = await run(process.execPath, ["scripts/developer-demo.mjs"], {
      env,
      timeout: 60000,
      maxBuffer: 1048576,
    }),
    report = JSON.parse(first.stdout);
  const path = join(directory, "developer-demo.env"),
    text = await readFile(path, "utf8"),
    secret = /^SOLDBENCH_API_KEY='([^']+)'$/m.exec(text)[1];
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(report.records, 8);
  assert.equal(report.images, 8);
  assert.ok(!first.stdout.includes(secret));
  // Follow the actual env-file + dev launcher composition, not injected test services.
  servers.splice(servers.indexOf(s.server), 1);
  s.server.closeAllConnections();
  await new Promise((done) => s.server.close(done));
  const processEnv = Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 2, -1).replaceAll("'\\''", "'")];
      }),
  );
  const dev = spawn(process.execPath, ["scripts/dev.mjs"], {
    env: { ...env, ...processEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  dev.stdout.on("data", (d) => {
    output += d;
  });
  dev.stderr.on("data", (d) => {
    output += d;
  });
  const closed = new Promise((done) => dev.once("close", done));
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${s.origin}/ready`)).status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(ready, true, "actual dev composition should start");
    const r = await client(commands[0], { secret, origin: s.origin, q: { q: "Nintendo Switch OLED" } });
    assert.equal(JSON.parse(r.stdout).n_price_verified, 8);
    await run(process.execPath, ["scripts/developer-demo.mjs"], { env, timeout: 60000, maxBuffer: 1048576 });
    const revoked = await fetch(`${s.origin}/v1/usage`, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(revoked.status, 401);
    assert.ok(!output.includes(secret));
  } finally {
    dev.kill("SIGTERM");
    await closed;
  }
});
