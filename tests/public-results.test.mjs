import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { database, migrate } from "@soldbench/db";
import { PublicResults } from "@soldbench/query";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  origin = "http://127.0.0.1:3000";
before(() => migrate(db));
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  await db.end();
});
async function setup(options = {}, scopes = ["public_cache", "public_share"]) {
  const x = await createProductFixture(db, roots, options);
  const service = new PublicResults(x.query);
  for (const scope of scopes)
    await db.query(
      "UPDATE source_clearances SET permitted_fields=jsonb_set(permitted_fields,ARRAY[$2], '[\"aggregate\"]') WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
      [x.source.sourceId, scope],
    );
  return { ...x, service };
}
async function webActor(x, user = x.user) {
  const token = x.auth.crypto.token("sb_s_"),
    csrf = x.auth.crypto.hash("auth.csrf", token),
    now = x.now();
  const sessionId = (
    await db.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5) RETURNING id",
      [
        user,
        x.auth.crypto.hash("auth.session", token),
        x.auth.crypto.hash("auth.csrf-store", csrf),
        now,
        "2027-01-01T00:00:00.000Z",
      ],
    )
  ).rows[0].id;
  return {
    sessionId,
    headers: {
      Cookie: `soldbench_session=${token}`,
      "X-CSRF-Token": csrf,
      Origin: origin,
      "Content-Type": "application/json",
    },
  };
}
function share(x, actor, overrides = {}, key = randomUUID()) {
  return x.app.request("/v1/shares", {
    method: "POST",
    headers: { ...actor.headers, "Idempotency-Key": key },
    body: JSON.stringify({ query_id: x.queryId, ...overrides }),
  });
}
function publicLookup(x, input, headers = {}) {
  return x.app.request("/web/search", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ q: input.q, limit: input.limit }),
  });
}
function validated(values) {
  execFileSync(
    "python3",
    [
      "-c",
      `
import json,sys,yaml
from jsonschema import Draft202012Validator,FormatChecker
from referencing import Registry,Resource
s=yaml.safe_load(open('docs/openapi.yaml'));u='urn:soldbench:openapi'
r=Registry().with_resource(u,Resource.from_contents({'$schema':'https://json-schema.org/draft/2020-12/schema',**s}))
for name,value in json.load(sys.stdin):
 Draft202012Validator({'$ref':u+'#/components/schemas/'+name},registry=r,format_checker=FormatChecker()).validate(value)
`,
    ],
    { input: JSON.stringify(values), stdio: ["pipe", "pipe", "pipe"] },
  );
}
function rejectsPrivateScope(schema, payload) {
  const polluted = structuredClone(payload);
  polluted.data.quality.comparison_scope = {
    status: "unresolved",
    modeled_price_input_count: 0,
    unknown_model_price_input_count: 58,
    distinct_model_labels: 0,
    model_options: [],
    model_options_truncated: false,
  };
  assert.throws(() => validated([[schema, polluted]]));
}

test("a share stores only a token hash, replays without a token, and hides owner and per-listing data", async () => {
  const x = await setup(),
    actor = await webActor(x),
    key = randomUUID();
  const response = await share(x, actor, {}, key),
    created = await response.json();
  assert.equal(response.status, 201, JSON.stringify(created));
  assert.match(created.data.token, /^sb_sh_[A-Za-z0-9_-]{43}$/);
  const saved = (await db.query("SELECT token_hash FROM shares WHERE id=$1", [created.data.share_id])).rows[0]
    .token_hash;
  assert.notEqual(saved, created.data.token);
  const token = urlPath(created.data.url),
    viewed = await x.app.request(token),
    body = await viewed.json();
  assert.equal(viewed.status, 200, JSON.stringify(body));
  assert.equal(viewed.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(viewed.headers.get("X-Robots-Tag"), /noindex/);
  assert.match(viewed.headers.get("Cache-Control"), /no-store/);
  assert.equal(body.data.stats.n_price_verified, 58);
  assert.equal(body.data.result_mode, "history");
  assert.equal(body.data.data_mode, "synthetic_fixture");
  assert.deepEqual(body.data.comps, []);
  const serialized = JSON.stringify(body);
  for (const secret of [
    created.data.token,
    x.user,
    x.queryId,
    x.q.q,
    x.source.sourceId,
    x.secret,
    "primary_image",
    "total_credits",
  ])
    assert.ok(!serialized.includes(secret), secret);
  const replay = await share(x, actor, {}, key),
    here = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(here.data.token_available, false);
  assert.equal(here.data.share_id, created.data.share_id);
  assert.equal((await share(x, actor, { expires_in: 200 }, key)).status, 409);
  const listing = await x.app.request(`/v1/shares?query_id=${x.queryId}`, { headers: actor.headers }),
    listed = await listing.json();
  assert.equal(listed.data.items[0].share_id, created.data.share_id);
  assert.ok(!JSON.stringify(listed).includes(created.data.token));
  validated([
    ["ShareCreated", created],
    ["ShareResponse", body],
    ["ShareCreatedReplay", here],
    ["SharesResponse", listed],
  ]);
  rejectsPrivateScope("ShareResponse", body);
  assert.equal(
    (await x.app.request(`/v1/shares/${created.data.share_id}`, { method: "DELETE", headers: actor.headers }))
      .status,
    204,
  );
  const gone = await x.app.request(token);
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).error.code, "share_unavailable");
  assert.equal((await share(x, actor, {}, key)).status, 410);
});
function urlPath(value) {
  return new URL(value).pathname;
}

test("share authorization checks current source, owner, reauthentication, expiry, and permission changes", async () => {
  const x = await setup(),
    actor = await webActor(x),
    other = await setup(),
    wrong = await webActor(x, other.user);
  assert.equal((await share(x, wrong)).status, 404);
  assert.equal((await share(x, actor, {}, { toString: () => "x" })).status, 400);
  assert.equal(
    (await share(x, { headers: { ...actor.headers, Origin: "https://other.example" } })).status,
    403,
  );
  const response = await share(x, actor, { expires_in: 60 }),
    data = (await response.json()).data;
  assert.equal((await x.app.request(urlPath(data.url))).status, 200);
  x.clock.value = "2026-11-17T12:01:00.000Z";
  assert.equal((await x.app.request(urlPath(data.url))).status, 410);
  const long = await share(x, actor);
  const longURL = urlPath((await long.json()).data.url);
  await db.query(
    "UPDATE source_clearances SET permitted_fields=permitted_fields-'public_share' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId],
  );
  assert.equal((await x.app.request(longURL)).status, 410);
  assert.equal((await share(x, actor)).status, 403);
  assert.equal((await x.app.request("/share/guessed")).status, 410);
  x.clock.value = "2026-11-17T12:11:00.000Z";
  assert.equal((await (await share(x, actor)).json()).error.code, "reauthentication_required");
});

test("replay and public access recheck changed source rights, retention, and original owner status", async () => {
  const x = await setup(),
    actor = await webActor(x),
    key = randomUUID();
  const response = await share(x, actor, { expires_in: 604800 }, key),
    data = (await response.json()).data;
  const token = urlPath(data.url);
  await db.query(
    "UPDATE source_clearances SET expires_at=$2 WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId, "2026-11-17T12:00:10.000Z"],
  );
  const shortening = (await (await x.app.request(token)).json()).data;
  assert.equal(shortening.expires_at, "2026-11-17T12:00:10.000Z");
  x.clock.value = "2026-11-17T12:00:10.000Z";
  assert.equal((await x.app.request(token)).status, 410);
  assert.equal((await share(x, actor, { expires_in: 604800 }, key)).status, 403);
  await db.query(
    "UPDATE source_clearances SET expires_at=NULL WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId],
  );
  assert.equal((await x.app.request(token)).status, 200);
  await db.query("UPDATE users SET status='deleted' WHERE id=$1", [x.user]);
  assert.equal((await x.app.request(token)).status, 410);
});

test("visitor consumes only fresh published cache delivery, reuses the same identity, and never creates jobs or pays", async () => {
  const x = await setup(),
    initialJobs = (await db.query("SELECT count(*) n FROM query_jobs")).rows[0].n,
    initialCharges = (await db.query("SELECT count(*) n FROM billing_charges")).rows[0].n;
  const miss = await publicLookup(x, x.q);
  assert.equal(miss.status, 503);
  assert.equal((await miss.json()).error.details.next_action, "register_or_try_later");
  assert.equal((await db.query("SELECT count(*)::int n FROM anonymous_quota")).rows[0].n, 0);
  await x.service.publishFixture(x.queryId);
  const cookie = miss.headers.get("Set-Cookie").split(";")[0],
    response = await publicLookup(x, x.q, { Cookie: cookie });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data.result_mode, "current");
  assert.equal(data.data.stats.n_price_verified, 58);
  assert.equal(data.meta.anonymous_remaining, 4);
  assert.equal(data.meta.credits_charged, 0);
  assert.equal(data.meta.reused, false);
  validated([["AnonymousCacheResponse", data]]);
  rejectsPrivateScope("AnonymousCacheResponse", data);
  const replay = await publicLookup(x, x.q, {
    Cookie: cookie,
    "Accept-Language": "zh-CN",
    "X-Forwarded-For": "203.0.113.55",
  });
  assert.equal((await replay.json()).meta.reused, true);
  assert.equal((await db.query("SELECT count(*) n FROM query_jobs")).rows[0].n, initialJobs);
  assert.equal((await db.query("SELECT count(*) n FROM billing_charges")).rows[0].n, initialCharges);
  await db.query(
    "UPDATE source_clearances SET permitted_fields=permitted_fields-'public_cache' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId],
  );
  assert.equal((await publicLookup(x, x.q, { Cookie: cookie })).status, 503);
  assert.equal(
    (await share(x, await webActor(x))).status,
    201,
    "share and public cache permissions are separate",
  );
});

test("five successful new lookups are atomic and a rotating cookie or forwarded address cannot refill the daily pool", async () => {
  const models = [];
  for (let i = 0; i < 6; i++) models.push(await setup());
  // All requests use the same logical clock, but the public service and re-use buckets
  // must use the same auth authority to share a visitor/network allowance.
  const x = models[0];
  await db.query("TRUNCATE anonymous_cache_deliveries,anonymous_quota,anonymous_rate_windows");
  for (const m of models) await x.service.publishFixture(m.queryId);
  const visitor = `soldbench_visitor=${x.auth.crypto.token("sb_vis_")}`;
  const results = await Promise.all(
    models.map((m, i) => publicLookup(x, m.q, { Cookie: visitor, "X-Forwarded-For": `203.0.113.${i + 1}` })),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 1);
  const deniedIndex = results.findIndex((r) => r.status === 429);
  const blocked = await publicLookup(x, models[deniedIndex].q, {
    Cookie: `soldbench_visitor=${x.auth.crypto.token("sb_vis_")}`,
    "X-Forwarded-For": "203.0.113.224",
  });
  assert.equal(blocked.status, 429);
  assert.equal((await db.query("SELECT max(used_count) n FROM anonymous_quota")).rows[0].n, 5);
  const replay = await publicLookup(x, models[results.findIndex((r) => r.status === 200)].q, {
    Cookie: visitor,
  });
  assert.equal((await replay.json()).meta.anonymous_remaining, 0);
  x.clock.value = "2026-11-18T00:00:00.000Z";
  assert.equal((await publicLookup(x, models[deniedIndex].q, { Cookie: visitor })).status, 200);
});

test("an anonymous hit is concurrency-idempotent, bounded per minute, purged after rotation, and fails when stale", async () => {
  const x = await setup(),
    visitor = `soldbench_visitor=${x.auth.crypto.token("sb_vis_")}`;
  await db.query("TRUNCATE anonymous_cache_deliveries,anonymous_quota,anonymous_rate_windows");
  await x.service.publishFixture(x.queryId);
  const results = await Promise.all(
    Array.from({ length: 100 }, () => publicLookup(x, x.q, { Cookie: visitor })),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 20);
  assert.equal(results.filter((r) => r.status === 429).length, 80);
  assert.equal((await db.query("SELECT max(used_count) n FROM anonymous_quota")).rows[0].n, 1);
  x.clock.value = "2026-11-18T12:00:00.001Z";
  assert.equal((await publicLookup(x, x.q, { Cookie: visitor })).status, 503);
  assert.equal((await db.query("SELECT count(*)::int n FROM anonymous_cache_deliveries")).rows[0].n, 1);
  x.clock.value = "2026-11-20T12:00:00.000Z";
  await x.service.prune();
  assert.equal((await db.query("SELECT count(*)::int n FROM anonymous_cache_deliveries")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM anonymous_quota")).rows[0].n, 0);
});
