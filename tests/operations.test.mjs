import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { publishNextScheduledContent } from "@soldbench/api";
import { AccountPrivacy } from "@soldbench/auth";
import { database, migrate } from "@soldbench/db";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  origin = "http://127.0.0.1:3000";
before(() => migrate(db));
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  await db.end();
});

test("public category and availability projections use current findings, scope and freshness", async () => {
  const x = await createProductFixture(db, roots, { prepareQuery: false });
  const get = (path) => x.app.request(path);
  const routes = ["/v1/categories", "/v1/data-status"];
  for (const route of routes) assert.deepEqual((await (await get(route)).json()).data, []);
  await db.query(
    `INSERT INTO category_taxonomy(marketplace,category_path,name,active,attribute_schema,supported_windows)
     VALUES('ebay_us','cards_graded','Graded cards',true,$1,'{30,90,180}'),
           ('ebay_us','watches','Watches',true,'[]','{90}'),
           ('ebay_us','sneakers','Hidden',false,'[]','{90}')`,
    [
      JSON.stringify([
        {
          name: "grading_company",
          type: "string",
          allowed_values: ["PSA"],
          required_for_comparability: true,
        },
        { name: "wrong_key", type: "string", allowed_values: [], required_for_comparability: false },
      ]),
    ],
  );
  await db.query(
    `INSERT INTO data_availability(source_id,category_path,last_successful_observation_at,freshness_state,collector_status,last_transition_at)
     VALUES($1,'cards_graded',$2,'fresh','running',$2)`,
    [x.source.sourceId, x.now()],
  );
  await db.query(
    `UPDATE source_clearances SET permitted_fields=permitted_fields || '{"public_cache":["aggregate"]}'::jsonb
     WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)`,
    [x.source.sourceId],
  );
  const cat = await get(routes[0]);
  assert.equal(cat.headers.get("X-SoldBench-Data-Mode"), "synthetic_fixture");
  const categories = await cat.json();
  assert.deepEqual(
    categories.data.map((row) => row.id),
    ["cards_graded", "watches"],
  );
  assert.deepEqual(categories.data[0].supported_windows, [30, 90]);
  assert.deepEqual(
    categories.data[0].supported_attributes.map((f) => f.name),
    ["grading_company"],
  );
  const status = async () => (await get(routes[1])).json();
  const snapshot = await status();
  assert.equal(snapshot.data[0].freshness_state, "fresh");
  assert.equal(snapshot.data[0].data_as_of, x.now());
  assert.equal(snapshot.data[1].freshness_state, "never_observed");
  assert.equal(snapshot.data[1].data_as_of, null);
  assert.equal(snapshot.meta.credits_charged, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(x.source.sourceId));
  const categoryPage = await get("/zh-CN/categories/cards_graded");
  assert.equal(categoryPage.status, 200);
  const categoryHtml = await categoryPage.text();
  assert.match(categoryHtml, /评级卡牌/);
  assert.match(categoryHtml, /30 天 \/ 90 天/);
  assert.match(categoryHtml, new RegExp(x.now()));
  await db.query(
    `INSERT INTO collector_circuits(source_id,category_key,status,opened_at) VALUES($1,'*','open',$2)`,
    [x.source.sourceId, x.now()],
  );
  const asOf = Date.parse(x.now());
  x.clock.value = new Date(asOf + 25 * 3600000).toISOString();
  const stale = (await status()).data[0];
  assert.equal(stale.freshness_state, "stale_acceptable");
  assert.equal(stale.collector_status, "paused");
  x.clock.value = new Date(asOf + 73 * 3600000).toISOString();
  assert.equal((await status()).data[0].freshness_state, "expired");
  await x.store.revokeSource(x.source.sourceId, "synthetic public field revocation");
  const revoked = (await status()).data[0];
  assert.equal(revoked.freshness_state, "forbidden");
  assert.equal(revoked.data_as_of, null);
  assert.equal((await get("/zh-CN/categories/cards_graded")).status, 404);
  assert.deepEqual(
    (await (await get(routes[0])).json()).data.map((row) => row.id),
    ["watches"],
  );
  assert.equal((await get("/v1/data-status?unexpected=1")).status, 400);
  const page = await x.app.request("/status", { headers: { Accept: "text/html" } });
  assert.match(await page.text(), /Data availability/);
  execFileSync("python3", ["tests/validate-response.py"], {
    input: JSON.stringify([
      ["CategoriesResponse", categories],
      ["DataStatusResponse", snapshot],
    ]),
  });
});
async function actor(x, role, options = {}) {
  const now = x.now(),
    token = x.auth.crypto.token("sb_s_"),
    csrf = x.auth.crypto.hash("auth.csrf", token),
    email = `${role}-${randomUUID()}@example.test`;
  const owner =
    options.userId ??
    (
      await db.query(
        "INSERT INTO users(email,password_hash,status,email_verified_at) VALUES($1,'fixture','active',$2) RETURNING id",
        [email, now],
      )
    ).rows[0].id;
  if (role !== "customer")
    await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,$2)", [owner, role]);
  if (role === "admin" && !options.withoutMfa)
    await db.query(
      "INSERT INTO user_mfa(user_id,encrypted_secret,state,enabled_at,updated_at) VALUES($1,$2,'enabled',$3,$3)",
      [owner, x.auth.crypto.seal("TEST_ONLY", owner), now],
    );
  const session = (
    await db.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,created_at,authenticated_at,expires_at,mfa_at) VALUES($1,$2,$3,$4,$4,$5,$6) RETURNING id",
      [
        owner,
        x.auth.crypto.hash("auth.session", token),
        x.auth.crypto.hash("auth.csrf-store", csrf),
        now,
        "2027-01-01",
        role === "admin" && !options.withoutMfa ? now : null,
      ],
    )
  ).rows[0].id;
  return {
    owner,
    session,
    email,
    headers: {
      Cookie: `soldbench_session=${token}`,
      "X-CSRF-Token": csrf,
      Origin: origin,
      "Content-Type": "application/json",
    },
  };
}
const post = (x, path, who, value, key = randomUUID()) =>
  x.app.request(path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...who?.headers, "Idempotency-Key": key },
    body: JSON.stringify(value),
  });
const read = (x, path, who) => x.app.request(path, { headers: who?.headers });
const scope = (source) => `/admin/sources/${source}/commands`;
const billingCount = async (userId) =>
  (await db.query("SELECT count(*)::int n FROM credit_ledger WHERE user_id=$1 AND kind='refund'", [userId]))
    .rows[0].n;

test("bilingual content remains private until independent approval and atomically publishes or restores an immutable revision", async () => {
  const x = await createProductFixture(db, roots, { prepareQuery: false });
  const writer = await actor(x, "admin"),
    reviewer = await actor(x, "admin"),
    support = await actor(x, "support");
  const endpoint = "/admin/content/commands",
    list = "/admin/content";
  const reason = "Controlled synthetic publication review";
  const draft = {
    command: "draft",
    kind: "announcement",
    slug: "fixture-announce",
    version: 0,
    reason,
    body: {
      en: { title: "Fixture announcement V1", body: "Use this controlled flow <script> as plain text." },
      "zh-CN": { title: "合成公告第一版", body: "中英文使用同一发布版本。" },
    },
  };
  const current = async () =>
    (await (await read(x, list, writer)).json()).data.find((row) => row.slug === draft.slug);
  const send = (op, who, row, revision = row.latest_revision) =>
    post(x, endpoint, who, { command: op, entry_id: row.id, version: row.version, revision, reason });
  const page = async (path) => (await read(x, path, null)).text();
  assert.equal((await read(x, list, support)).status, 403);
  assert.equal((await read(x, list, null)).status, 401);
  assert.equal((await post(x, endpoint, support, draft)).status, 403);
  assert.equal((await post(x, endpoint, writer, { ...draft, body: { en: draft.body.en } })).status, 400);
  assert.equal((await post(x, endpoint, writer, { ...draft, kind: "pricing" })).status, 400);
  const key = randomUUID();
  const initial = await post(x, endpoint, writer, draft, key);
  assert.equal(initial.status, 202);
  const receipt = await initial.json();
  assert.deepEqual((await (await post(x, endpoint, writer, draft, key)).json()).data, receipt.data);
  const first = await current();
  assert.equal(first.latest_revision, 1);
  assert.equal(first.published_revision, null);
  assert.equal((await send("publish", writer, first)).status, 409);
  assert.doesNotMatch(await page("/"), /Fixture announcement V1/);
  assert.equal((await send("submit", writer, first)).status, 202);
  assert.equal((await send("approve", writer, await current())).status, 403);
  assert.equal((await send("approve", reviewer, await current())).status, 202);
  assert.equal((await send("publish", reviewer, await current())).status, 202);
  assert.match(await page("/"), /Fixture announcement V1/);
  assert.match(await page("/"), /&lt;script&gt;/);
  assert.match(await page("/zh-CN"), /合成公告第一版/);
  const badUpdate = db.query("UPDATE site_content_revisions SET body='{}' WHERE entry_id=$1 AND revision=1", [
    first.id,
  ]);
  await assert.rejects(badUpdate, /immutable/);
  const change = {
    ...draft,
    version: (await current()).version,
    body: { ...draft.body, en: { ...draft.body.en, title: "Fixture announcement V2" } },
  };
  assert.equal((await post(x, endpoint, writer, change)).status, 202);
  assert.equal((await post(x, endpoint, writer, change)).status, 409);
  assert.match(await page("/"), /Fixture announcement V1/);
  assert.doesNotMatch(await page("/"), /Fixture announcement V2/);
  assert.equal((await send("submit", writer, await current())).status, 202);
  assert.equal((await send("approve", reviewer, await current())).status, 202);
  assert.equal((await send("publish", reviewer, await current())).status, 202);
  assert.match(await page("/"), /Fixture announcement V2/);
  assert.equal((await send("rollback", reviewer, await current(), 1)).status, 202);
  assert.match(await page("/"), /Fixture announcement V1/);
  assert.deepEqual((await current()).publication_history, [2, 1]);
  const studio = await x.app.request(`${list}?lang=zh-CN`, {
    headers: { ...writer.headers, Accept: "text/html" },
  });
  assert.match(await studio.text(), /内容中心/);
  assert.equal((await send("unpublish", reviewer, await current(), 1)).status, 202);
  assert.doesNotMatch(await page("/"), /Fixture announcement V1/);
  const view = await (await read(x, list, writer)).json();
  const due = () => new Date(Date.parse(x.now()) + 60000).toISOString();
  const schedule = async (execute_at, who = reviewer, idempotency = randomUUID()) => {
    const row = await current();
    return post(
      x,
      endpoint,
      who,
      {
        command: "schedule",
        entry_id: row.id,
        revision: row.latest_revision,
        version: row.version,
        execute_at,
        reason,
      },
      idempotency,
    );
  };
  assert.equal((await schedule(x.now())).status, 400);
  assert.equal((await schedule(due(), support)).status, 403);
  assert.equal((await schedule(due())).status, 202);
  assert.equal((await current()).schedule.status, "pending");
  assert.equal(await publishNextScheduledContent(db, x.now), null);
  assert.equal((await send("cancel_schedule", reviewer, await current(), 2)).status, 202);
  assert.equal((await current()).schedule.status, "cancelled");
  x.clock.value = due();
  assert.equal(await publishNextScheduledContent(db, x.now), null);
  const execute = due();
  const payload = {
    command: "schedule",
    entry_id: first.id,
    version: (await current()).version,
    revision: 2,
    execute_at: execute,
    reason,
  };
  const scheduleKey = randomUUID();
  const saved = await post(x, endpoint, reviewer, payload, scheduleKey);
  assert.equal(saved.status, 202);
  assert.deepEqual(
    (await (await post(x, endpoint, reviewer, payload, scheduleKey)).json()).data,
    (await saved.json()).data,
  );
  assert.doesNotMatch(await page("/"), /Fixture announcement V2/);
  x.clock.value = execute;
  const delivered = (
    await Promise.all(Array.from({ length: 10 }, () => publishNextScheduledContent(db, x.now)))
  ).filter(Boolean);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].status, "published");
  assert.equal((await current()).schedule.status, "published");
  assert.match(await page("/"), /Fixture announcement V2/);
  assert.match(await page("/zh-CN"), /合成公告第一版/);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM audit_events WHERE action='ops.content.scheduled_publish' AND request_id=$1",
        [delivered[0].schedule_id],
      )
    ).rowCount,
    1,
  );
  for (const cause of ["entry_changed", "operator_access_changed"]) {
    const update = {
      ...draft,
      version: (await current()).version,
      body: { ...draft.body, en: { ...draft.body.en, title: "Blocked version" } },
    };
    assert.equal((await post(x, endpoint, writer, update)).status, 202);
    assert.equal((await send("submit", writer, await current())).status, 202);
    assert.equal((await send("approve", reviewer, await current())).status, 202);
    const executeAt = due();
    assert.equal((await schedule(executeAt)).status, 202);
    if (cause === "entry_changed") {
      const newer = { ...draft, version: (await current()).version };
      assert.equal((await post(x, endpoint, writer, newer)).status, 202);
    } else await db.query("DELETE FROM admin_roles WHERE user_id=$1", [reviewer.owner]);
    x.clock.value = executeAt;
    assert.equal((await publishNextScheduledContent(db, x.now)).status, "blocked");
    const row = await current();
    assert.equal(row.schedule.failure_code, cause);
    assert.equal(row.published_revision, 2);
    assert.doesNotMatch(await page("/"), /Blocked version/);
  }
  execFileSync("python3", ["tests/validate-response.py"], {
    input: JSON.stringify([
      ["SiteContentList", view],
      ["SiteContentList", await (await read(x, list, writer)).json()],
      ["SiteContentScheduleRequest", payload],
      ["CommandResponse", receipt],
    ]),
  });
});

test("typed bilingual release projects only the active revision and never publishes unapproved legal copy", async () => {
  const x = await createProductFixture(db, roots, { prepareQuery: false });
  const writer = await actor(x, "admin");
  const reviewer = await actor(x, "admin");
  const endpoint = "/admin/content/commands";
  const reason = "Exercise the typed publication workflow";
  const draft = (kind, slug, metadata, version = 0, label = slug) => ({
    command: "draft",
    kind,
    slug,
    version,
    reason,
    metadata,
    body: {
      en: { title: label, body: "Editorial text" },
      "zh-CN": { title: `中文 ${label}`, body: "编辑文案" },
    },
  });
  const current = async (slug) =>
    (await (await read(x, "/admin/content", writer)).json()).data.find((row) => row.slug === slug);
  const change = async (command, slug, who = reviewer, extra = {}) => {
    const row = await current(slug);
    return post(x, endpoint, who, {
      command,
      entry_id: row.id,
      version: row.version,
      revision: row.latest_revision,
      reason,
      ...extra,
    });
  };
  const review = async (slug) => {
    assert.equal((await change("submit", slug, writer)).status, 202);
    assert.equal((await change("approve", slug)).status, 202);
  };
  for (const input of [
    draft("navigation", "bad-nav", { target: "//example.test/" }),
    draft("navigation", "missing-nav", {}),
    draft("comparison", "bad-comparison", { reference: "https://name:secret@example.test/" }),
    draft("terms", "no-version", {}),
    draft("offer_copy", "fake-price", { reference_key: "valid", cents: 100 }),
    draft("status_component", "fake-healthy", { reference_key: "valid", state: "operational" }),
  ])
    assert.equal((await post(x, endpoint, writer, input)).status, 400, input.slug);

  for (const [kind, slug, metadata] of [
    ["home", "fixture-home-block", { position: 20, target: "/guides" }],
    ["navigation", "fixture-nav-later", { position: 50, target: "/pricing" }],
    ["navigation", "fixture-nav-first", { position: 2, target: "/search" }],
    ["footer", "fixture-footer", { target: "/data-availability" }],
    ["blog", "fixture-cms-article", { author: "Fixture editor", related: ["fixture-cms-related"] }],
    ["blog", "fixture-cms-related", {}],
    ["guide", "fixture-published-guide", {}],
    ["comparison", "fixture-cms-comparison", { reference: "https://example.test/evidence" }],
    ["changelog", "fixture-cms-release", {}],
  ]) {
    assert.equal((await post(x, endpoint, writer, draft(kind, slug, metadata))).status, 202, slug);
    assert.deepEqual((await current(slug)).metadata, metadata);
    await review(slug);
    assert.equal((await change("publish", slug)).status, 202);
  }
  const home = await (await read(x, "/")).text();
  assert.match(home, /fixture-home-block/);
  assert.match(home, /href="\/search">fixture-nav-first/);
  assert.ok(home.indexOf("fixture-nav-first") < home.indexOf("fixture-nav-later"));
  const articlePath = "/blog/fixture-cms-article";
  assert.match(home, /href="\/blog\/fixture-cms-article"/);
  assert.match(await (await read(x, "/guides")).text(), /href="\/guides\/fixture-published-guide"/);
  const article = await read(x, `/zh-CN${articlePath}?tracking=ignored`);
  assert.equal(article.status, 200);
  assert.equal(article.headers.get("cache-control"), "no-store");
  const articleHtml = await article.text();
  assert.match(articleHtml, /中文 fixture-cms-article/);
  assert.match(articleHtml, /Fixture editor/);
  assert.match(articleHtml, /href="\/zh-CN\/blog\/fixture-cms-related"/);
  assert.match(
    articleHtml,
    /rel="canonical" href="https:\/\/soldbench.com\/zh-CN\/blog\/fixture-cms-article"/,
  );
  assert.match(articleHtml, /hrefLang="en" href="https:\/\/soldbench.com\/blog\/fixture-cms-article"/i);
  assert.doesNotMatch(articleHtml, /tracking=ignored/);
  assert.equal((await change("unpublish", "fixture-cms-related")).status, 202);
  assert.doesNotMatch(await (await read(x, articlePath)).text(), /fixture-cms-related/);
  assert.equal((await change("unpublish", "fixture-cms-article")).status, 202);
  assert.equal((await read(x, articlePath)).status, 404);
  assert.doesNotMatch(await (await read(x, "/")).text(), /fixture-cms-article/);
  const comparison = await (await read(x, "/compare/fixture-cms-comparison")).text();
  assert.match(comparison, /https:\/\/example.test\/evidence/);
  assert.match(await (await read(x, "/zh-CN/changelog")).text(), /中文 fixture-cms-release/);
  assert.match(
    await (await read(x, "/zh-CN/faq")).text(),
    /href="\/zh-CN\/data-availability">中文 fixture-footer/,
  );
  const previous = await current("fixture-home-block");
  assert.equal(
    (
      await post(
        x,
        endpoint,
        writer,
        draft("home", previous.slug, { target: "/search" }, previous.version, "Next block"),
      )
    ).status,
    202,
  );
  assert.doesNotMatch(await (await read(x, "/")).text(), /Next block/);
  assert.equal((await change("unpublish", previous.slug, reviewer, { revision: 1 })).status, 202);
  assert.doesNotMatch(await (await read(x, "/")).text(), /fixture-home-block|Next block/);
  await assert.rejects(
    db.query("UPDATE site_content_revisions SET metadata='{}' WHERE entry_id=$1", [previous.id]),
    /immutable/,
  );

  assert.equal(
    (await post(x, endpoint, writer, draft("terms", "fixture-terms", { policy_version: "2026-11-19" })))
      .status,
    202,
  );
  await review("fixture-terms");
  assert.equal((await change("publish", "fixture-terms")).status, 403);
  assert.equal(
    (
      await change("schedule", "fixture-terms", reviewer, {
        execute_at: new Date(Date.parse(x.now()) + 60000).toISOString(),
      })
    ).status,
    403,
  );

  assert.equal(
    (await post(x, endpoint, writer, draft("guide", "revoked-review-guide", { author: "Fixture editor" })))
      .status,
    202,
  );
  await review("revoked-review-guide");
  await db.query("DELETE FROM admin_roles WHERE user_id=$1 AND role='admin'", [reviewer.owner]);
  assert.equal((await change("publish", "revoked-review-guide", writer)).status, 403);
});

test("support intake is private, idempotent, rate limited and prunes expired original messages", async () => {
  const x = await createProductFixture(db, roots),
    key = randomUUID(),
    userMessage = "private support fixture";
  const payload = { category: "data_quality", message: userMessage, request_id: randomUUID() };
  for (const message of [String.fromCharCode(0), String.fromCharCode(0xd800)]) {
    assert.equal((await post(x, "/support/requests", null, { ...payload, message }, key)).status, 400);
  }
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM idempotency_records WHERE operation='support.submit'"))
      .rows[0].n,
    0,
  );
  const initial = await post(x, "/support/requests", null, payload, key),
    data = (await initial.json()).data;
  assert.equal(initial.status, 202);
  assert.equal(data.status, "accepted");
  assert.ok(!JSON.stringify(data).includes(userMessage));
  assert.equal(
    (await (await post(x, "/support/requests", null, payload, key)).json()).data.request_id,
    data.request_id,
  );
  assert.equal(
    (await post(x, "/support/requests", null, { ...payload, message: "different" }, key)).status,
    409,
  );
  assert.equal(
    (await post(x, "/support/requests", { headers: { Origin: "https://elsewhere.example" } }, payload))
      .status,
    403,
  );
  for (let i = 0; i < 7; i++)
    assert.equal(
      (await post(x, "/support/requests", null, { ...payload, message: `valid fixture ${i}` })).status,
      202,
    );
  assert.equal(
    (await post(x, "/support/requests", { headers: { "X-Forwarded-For": "203.0.113.9" } }, payload)).status,
    429,
  );
  assert.equal(
    (await (await post(x, "/support/requests", null, payload, key)).json()).data.request_id,
    data.request_id,
  );
  const saved = (
    await db.query("SELECT user_id,message,request_ref FROM support_requests WHERE id=$1", [data.request_id])
  ).rows[0];
  assert.deepEqual(saved, { user_id: null, message: userMessage, request_ref: payload.request_id });
  x.clock.value = "2026-12-18T00:00:00.000Z";
  await new AccountPrivacy(x.auth, x.now).prune();
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM support_requests WHERE id=$1", [data.request_id])).rows[0].n,
    0,
  );
});

test("support work follows assignment and version, provides a limited private reply, and expires", async () => {
  const x = await createProductFixture(db, roots, { prepareQuery: false });
  const first = await actor(x, "admin"),
    second = await actor(x, "admin"),
    support = await actor(x, "support");
  const privateReceipt = randomBytes(32).toString("base64url");
  const message = "Original billing details for the assigned administrator";
  const requester = { headers: { "X-Support-Receipt": privateReceipt } };
  const payload = { category: "billing", message, request_id: randomUUID() };
  const key = randomUUID();
  const accepted = await post(x, "/support/requests", requester, payload, key);
  assert.equal(accepted.status, 202);
  const id = (await accepted.json()).data.request_id;
  assert.equal(
    (await (await post(x, "/support/requests", requester, payload, key)).json()).data.request_id,
    id,
  );
  assert.equal((await post(x, "/support/requests", requester, payload)).status, 409);
  assert.equal(
    (await post(x, "/support/requests", { headers: { "X-Support-Receipt": "A".repeat(43) } }, payload, key))
      .status,
    409,
  );
  assert.equal((await read(x, `/support/receipt?id=${id}`, null)).status, 404);
  const state = async () => {
    const response = await read(x, "/support/receipt", requester);
    assert.match(response.headers.get("Cache-Control"), /private, no-store/);
    return response.json();
  };
  assert.equal((await state()).data.status, "received");
  const endpoint = `/admin/support/${id}`;
  assert.equal((await read(x, endpoint, first)).status, 404);
  const metadata = await (await read(x, "/admin/support", support)).json();
  assert.ok(metadata.data.items.some((item) => item.id === id));
  assert.ok(!JSON.stringify(metadata).includes(message));
  assert.equal((await read(x, endpoint, support)).status, 403);
  const due_at = new Date(Date.parse(x.now()) + 86400000).toISOString();
  const claim = { command: "claim", version: 1, due_at, reason: "Assign synthetic case" };
  const claimKey = randomUUID();
  const command = (who, value, idempotency) => post(x, `${endpoint}/commands`, who, value, idempotency);
  assert.equal((await command(support, claim)).status, 403);
  assert.equal((await command(first, { ...claim, due_at: x.now() })).status, 400);
  const assigned = await command(first, claim, claimKey);
  assert.equal(assigned.status, 202);
  assert.deepEqual((await (await command(first, claim, claimKey)).json()).data, (await assigned.json()).data);
  assert.equal((await command(second, claim)).status, 409);
  const details = await (await read(x, endpoint, first)).json();
  assert.equal(details.data.message, message);
  assert.equal(details.data.related_request_id, payload.request_id);
  assert.equal((await read(x, endpoint, second)).status, 404);
  const take = { command: "take_over", version: 2, due_at, reason: "Resume synthetic investigation" };
  assert.equal((await command(second, take)).status, 409);
  await db.query("DELETE FROM admin_roles WHERE user_id=$1", [first.owner]);
  assert.equal((await command(second, take)).status, 202);
  assert.equal((await read(x, endpoint, first)).status, 403);
  const reply = "The original charge was verified and the support case can close.";
  const resolve = { command: "resolve", version: 3, reason: "Confirmed internal evidence", reply };
  assert.equal((await command(second, resolve)).status, 202);
  const final = await state();
  assert.equal(final.data.status, "resolved");
  assert.equal(final.data.reply, reply);
  assert.ok(!JSON.stringify(final).includes(message));
  assert.equal(
    (await command(second, { command: "close", version: 4, reason: "Close synthetic case" })).status,
    202,
  );
  assert.equal(
    (await command(second, { command: "reopen", version: 5, due_at, reason: "Review new evidence" })).status,
    202,
  );
  assert.equal((await state()).data.status, "in_progress");
  const audit = await (await read(x, "/admin/audit?page_size=100", support)).json();
  assert.ok(audit.data.items.some((item) => item.object_id === id && item.action === "ops.support.read"));
  assert.ok(!JSON.stringify(audit).includes(reply));
  assert.ok(!JSON.stringify(audit).includes(privateReceipt));
  execFileSync("python3", ["tests/validate-response.py"], {
    input: JSON.stringify([
      ["SupportQueueResponse", metadata],
      ["SupportDetailResponse", details],
      ["SupportReceiptResponse", final],
      ["SupportCommand", resolve],
    ]),
  });
  x.clock.value = new Date(Date.parse(x.now()) + 31 * 86400000).toISOString();
  assert.equal((await read(x, "/support/receipt", requester)).status, 404);
  await new AccountPrivacy(x.auth, x.now).prune();
  assert.equal((await db.query("SELECT id FROM support_requests WHERE id=$1", [id])).rowCount, 0);
});

test("operator roles, recent MFA, and source CAS protect stop, readiness check and immediate evidence withdrawal", async () => {
  const x = await createProductFixture(db, roots),
    admin = await actor(x, "admin"),
    support = await actor(x, "support"),
    customer = await actor(x, "customer"),
    noMfa = await actor(x, "admin", { withoutMfa: true }),
    source = x.source.sourceId,
    path = scope(source);
  const input = {
    command: "suspend",
    reason: "private operational reason",
    evidence_ref: "fixture-private-ref",
    version: 1,
  };
  assert.equal((await read(x, "/admin/sources", support)).status, 403);
  assert.equal((await read(x, "/admin/jobs", support)).status, 200);
  assert.equal((await read(x, "/admin/jobs", customer)).status, 403);
  assert.equal((await post(x, path, support, input)).status, 403);
  assert.equal((await post(x, path, noMfa, input)).status, 403);
  assert.equal((await post(x, path, admin, input, "too-short")).status, 400);
  assert.equal(
    (await post(x, path, { headers: { ...admin.headers, "X-CSRF-Token": "bad" } }, input)).status,
    403,
  );
  const firstKey = randomUUID(),
    first = await post(x, path, admin, input, firstKey),
    applied = (await first.json()).data;
  assert.equal(first.status, 202);
  assert.deepEqual((await (await post(x, path, admin, input, firstKey)).json()).data, applied);
  assert.equal((await post(x, path, admin, { ...input, reason: "different" }, firstKey)).status, 409);
  assert.equal((await post(x, path, admin, input)).status, 409);
  const before = (await db.query("SELECT count(*)::int n FROM collector_jobs")).rows[0].n;
  const probeKey = randomUUID(),
    probeBody = { ...input, command: "probe", version: 2 };
  const probe = await post(x, path, admin, probeBody, probeKey),
    probeResult = (await probe.json()).data;
  assert.equal(probe.status, 202);
  assert.equal(probeResult.probe_status, "ready_for_offline_probe");
  assert.deepEqual((await (await post(x, path, admin, probeBody, probeKey)).json()).data, probeResult);
  assert.equal((await db.query("SELECT count(*)::int n FROM collector_jobs")).rows[0].n, before);
  assert.equal((await (await read(x, "/status")).json()).data.collector, "paused");
  const delivered = await x.query.result(x.identity, x.queryId, randomUUID());
  assert.equal(delivered.meta.source_status, "stopped");
  assert.equal((await post(x, path, admin, { ...input, command: "revoke", version: 3 })).status, 202);
  await assert.rejects(x.query.result(x.identity, x.queryId, randomUUID()), (e) => e.code === "forbidden");
  const latest = (await (await read(x, "/admin/sources", admin)).json()).data.find(
    (r) => r.source_id === source,
  );
  assert.equal(latest.clearance_status, "revoked");
  assert.equal(latest.permission_epoch, 2);
  assert.equal(latest.version, 4);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM outbox WHERE event_key=$1", [`source-revoke:${source}:2`]))
      .rows[0].n,
    1,
  );
  const history = await (await read(x, "/admin/audit", support)).text();
  for (const secret of [admin.email, admin.owner, input.reason, input.evidence_ref])
    assert.ok(!history.includes(secret), secret);
  x.clock.value = "2026-11-17T12:11:00.000Z";
  assert.equal(
    (await (await read(x, "/admin/sources", admin)).json()).error.code,
    "reauthentication_required",
  );
});

test("a temporary failed query can be recovered safely; repeat requests do not start new collection or charge", async () => {
  const x = await createProductFixture(db, roots, { prepareQuery: false }),
    admin = await actor(x, "admin"),
    support = await actor(x, "support");
  const queued = await x.query.submit(x.identity, x.q);
  await db.query("UPDATE queries SET compute_status='failed' WHERE id=$1", [queued.queryId]);
  await db.query(
    "UPDATE query_jobs SET status='failed',attempt_count=1,error_code='service_unavailable',version=2 WHERE id=$1",
    [queued.jobId],
  );
  const prev = (await db.query("SELECT count(*)::int n FROM collector_jobs")).rows[0].n;
  const path = `/admin/jobs/${queued.jobId}/retry`,
    key = randomUUID(),
    body = { reason: "retry fixture", version: 2 };
  assert.equal((await post(x, path, support, body)).status, 403);
  assert.equal((await post(x, path, admin, { ...body, version: 1 })).status, 409);
  const result = await post(x, path, admin, body, key),
    payload = (await result.json()).data;
  assert.equal(result.status, 202, JSON.stringify(payload));
  assert.deepEqual((await (await post(x, path, admin, body, key)).json()).data, payload);
  assert.equal((await x.query.workOnce("recovered-fixture")).status, "completed");
  assert.equal((await x.query.job(x.identity, queued.jobId)).settlement_status, "pending");
  assert.equal((await db.query("SELECT count(*)::int n FROM collector_jobs")).rows[0].n, prev);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM billing_charges WHERE query_id=$1", [queued.queryId]))
      .rows[0].n,
    0,
  );
  assert.equal((await post(x, path, admin, { ...body, version: 4 })).status, 409);
  const page = (await (await read(x, "/admin/jobs?page_size=1", support)).json()).data;
  assert.equal(page.items.length, 1);
  assert.ok(!JSON.stringify(page).includes(x.q.q));
  assert.equal((await read(x, `/admin/jobs?cursor=${page.next_cursor}`, admin)).status, 400);
});

test("operations workbench binds account changes to independent approval, protects case notes and preserves wallet facts", async () => {
  const x = await createProductFixture(db, roots);
  const writer = await actor(x, "admin");
  const reviewer = await actor(x, "admin");
  const support = await actor(x, "support");
  const noMfa = await actor(x, "admin", { withoutMfa: true });
  const customer = await actor(x, "customer", { userId: x.user });
  const path = `/admin/users/${x.user}`;
  const project = async (endpoint, who = writer) => (await (await read(x, endpoint, who)).json()).data;
  assert.equal((await read(x, path, support)).status, 403);
  assert.equal((await read(x, path, noMfa)).status, 403);
  assert.equal((await read(x, "/admin/settings", support)).status, 403);
  assert.equal((await project("/admin/overview", support)).pending_approvals, null);
  const lockedSettings = await project("/admin/settings");
  assert.equal(lockedSettings.collector_enabled, false);
  const view = await project(path);
  assert.equal(view.account.status, "active");
  assert.match(view.account.email_hint, /\*\*\*@/);
  assert.ok(!JSON.stringify(view).includes("private-device"));
  const charge = view.charges[0];
  const ledgerPath = `/admin/charges/${charge.id}`;
  const ledger = await project(ledgerPath);
  assert.equal(ledger.ledger[0].kind, "consume");
  assert.equal((await read(x, ledgerPath, support)).status, 403);
  const noteKey = randomUUID();
  const noteInput = { content: "Private operator evidence for a customer case" };
  const noted = await post(x, `${path}/notes`, writer, noteInput, noteKey);
  assert.equal(noted.status, 202);
  const repeated = await post(x, `${path}/notes`, writer, noteInput, noteKey);
  assert.equal(repeated.status, 202);
  assert.deepEqual((await repeated.json()).data, (await noted.json()).data);
  assert.equal((await project(path)).notes.length, 1);

  const reason = "Controlled synthetic account access review";
  const create = (action, version, who = writer) =>
    post(x, `${path}/approvals`, who, { action, credential_version: version, reason });
  const current = async () =>
    (await project("/admin/approvals")).items.find(
      (row) => row.subject_user_id === x.user && ["requested", "approved"].includes(row.state),
    );
  const command = (row, operation, who, key = randomUUID()) =>
    post(
      x,
      `/admin/approvals/${row.id}/commands`,
      who,
      { command: operation, version: row.version, reason },
      key,
    );
  assert.equal((await create("suspend", 1)).status, 409);
  assert.equal((await create("suspend", 0, support)).status, 403);
  assert.equal((await create("suspend", 0)).status, 202);
  const requested = await current();
  assert.equal(requested.can_review, false);
  assert.equal((await command(requested, "approve", writer)).status, 403);
  assert.equal((await command(requested, "execute", reviewer)).status, 409);
  assert.equal((await command(requested, "approve", reviewer)).status, 202);
  assert.equal((await command(requested, "cancel", writer)).status, 409);
  const approved = await current();
  await db.query("DELETE FROM admin_roles WHERE user_id=$1 AND role='admin'", [reviewer.owner]);
  assert.equal((await command(approved, "execute", writer)).status, 403);
  assert.equal((await project(path)).account.status, "active");
  await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin')", [reviewer.owner]);
  const executionKey = randomUUID();
  const executed = await command(approved, "execute", writer, executionKey);
  assert.equal(executed.status, 202);
  const applied = await executed.json();
  assert.deepEqual(
    (await (await command(approved, "execute", writer, executionKey)).json()).data,
    applied.data,
  );
  assert.equal((await project(path)).account.status, "suspended");
  assert.equal((await read(x, "/auth/me", customer)).status, 401);
  assert.equal((await x.app.request(`/v1/sold/${x.queryId}`, { headers: x.headers })).status, 401);
  assert.equal((await create("restore", 1)).status, 202);
  assert.equal((await command(await current(), "approve", reviewer)).status, 202);
  assert.equal((await command(await current(), "execute", writer)).status, 202);
  assert.equal((await project(path)).account.status, "active");
  assert.equal((await read(x, "/auth/me", customer)).status, 401);
  assert.deepEqual(await project(ledgerPath), ledger);
  const incidentInputs = { component: "collector", title: "Internal fixture incident", reason };
  const opened = await post(x, "/admin/incidents", writer, incidentInputs);
  assert.equal(opened.status, 202);
  const incident = (await project("/admin/incidents")).items.find(
    (entry) => entry.title === incidentInputs.title,
  );
  assert.equal(incident.state, "open");
  const incidentPath = `/admin/incidents/${incident.id}`;
  assert.equal((await post(x, incidentPath, writer, { state: "resolved", version: 1, reason })).status, 202);
  assert.equal(
    (await post(x, incidentPath, writer, { state: "monitoring", version: 1, reason })).status,
    409,
  );
  const detail = await project(incidentPath);
  assert.deepEqual(new Set(detail.timeline.map((row) => row.state)), new Set(["open", "resolved"]));
  assert.doesNotMatch(await (await read(x, "/status")).text(), /Internal fixture incident/);
  execFileSync("python3", ["tests/validate-response.py"], {
    input: JSON.stringify([
      ["OperationsWorkbenchSettings", lockedSettings],
      ["OperatorAccountCase", await project(path)],
      ["OperatorChargeDetail", ledger],
      ["OperatorAccountApproval", approved],
      ["OperatorIncidentDetail", detail],
      ["CommandResponse", applied],
    ]),
  });
});

test("telemetry uses real offline runs, current evidence rights and versioned local alert thresholds", async () => {
  const x = await createProductFixture(db, roots);
  const admin = await actor(x, "admin");
  const support = await actor(x, "support");
  const end = x.now();
  const start = new Date(Date.parse(end) - 40_000).toISOString();
  const base = "/admin/telemetry/";
  let operator = admin;
  const get = async (view) => {
    const response = await read(x, base + view, operator);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const rows = (data, section = 0) => {
    const item = data.sections[section];
    return item.rows.map((row) => Object.fromEntries(item.columns.map((name, i) => [name, row[i]])));
  };
  const source = x.source.sourceId;
  await db.query(
    "INSERT INTO worker_heartbeats(worker_kind,last_cycle_at) VALUES('query',$1) ON CONFLICT(worker_kind) DO UPDATE SET last_cycle_at=$1",
    [start],
  );
  await db.query(
    `INSERT INTO data_availability(source_id,category_path,last_successful_observation_at,freshness_state,collector_status,last_transition_at)
     VALUES($1,'video_games',$2,'fresh','running',$2) ON CONFLICT(source_id,category_path) DO UPDATE
       SET last_successful_observation_at=$2,freshness_state='fresh',collector_status='running',last_transition_at=$2`,
    [source, end],
  );
  const result = await x.app.request(`/v1/sold/${x.queryId}`, { headers: x.headers });
  assert.equal(result.status, 200);
  assert.equal((await read(x, `${base}records`, support)).status, 403);
  assert.equal((await read(x, `${base}growth?source=${source}`, admin)).status, 400);
  assert.equal((await read(x, `${base}collector?days=31`, admin)).status, 400);

  const views = Object.fromEntries(
    await Promise.all(
      ["monitoring", "api", "collector", "records", "rules", "coverage", "quality", "growth", "costs"].map(
        async (view) => [view, (await get(view)).data],
      ),
    ),
  );
  assert.equal(rows(views.monitoring).find((row) => row.signal === "worker_heartbeat_age").state, "alert");
  assert.ok(rows(views.api).some((row) => row.operation === "sold_result" && row.requests >= 1));
  assert.ok(rows(views.collector).some((row) => row.source_id === source && row.outcome === "completed"));
  const photo = (
    await db.query(
      "SELECT sale_event_id FROM listing_images WHERE source_id=$1 AND state='available' LIMIT 1",
      [source],
    )
  ).rows[0];
  await db.query(
    "UPDATE sold_listings SET title='Later listing revision' WHERE id=(SELECT listing_id FROM sale_events WHERE id=$1)",
    [photo.sale_event_id],
  );
  const selected = (await get(`records?source=${source}&record=${photo.sale_event_id}`)).data;
  assert.equal(rows(selected).length, 1);
  assert.equal(rows(selected)[0].primary_image, true);
  assert.equal(typeof rows(selected)[0].title, "string");
  assert.notEqual(rows(selected)[0].title, "Later listing revision");
  assert.doesNotMatch(JSON.stringify(selected), /images\.example\.test|object_key|source_url/);
  assert.ok(rows(views.rules).some((row) => row.rule === "engine"));
  assert.ok(rows(views.rules, 1).some((row) => row.source_id === source));
  assert.equal(rows(views.coverage).find((row) => row.source_id === source).market_coverage, null);
  assert.ok(rows(views.quality).some((row) => row.snapshots >= 1 && Number(row.verified_prices) >= 8));
  assert.equal(rows(views.growth)[0].paid_conversion, null);
  assert.ok(rows(views.costs).some((row) => row.source_id === source && Number(row.used) > 0));
  assert.equal(rows(views.costs, 1)[0].network_cost, null);

  const input = {
    ...views.monitoring.alert_settings,
    heartbeat_stale_seconds: 60,
    reason: "Change a local observation threshold",
  };
  const key = randomUUID();
  const updated = await post(x, "/admin/alerts/commands", admin, input, key);
  assert.equal(updated.status, 202);
  assert.deepEqual(
    (await updated.json()).data,
    (await (await post(x, "/admin/alerts/commands", admin, input, key)).json()).data,
  );
  assert.equal((await post(x, "/admin/alerts/commands", admin, input)).status, 409);
  const current = await get("monitoring");
  assert.equal(
    rows(current.data).find((row) => row.signal === "worker_heartbeat_age").state,
    "within_budget",
  );
  execFileSync("python3", ["tests/validate-response.py"], {
    input: JSON.stringify([["OperationsTelemetryResponse", current]]),
  });

  await db.query(
    `INSERT INTO collector_quarantines(source_id,job_id,collector_run_id,dispatch_id,parser_version,cursor,reason,raw_hash,byte_length,affected_event_id,captured_at)
     SELECT e.source_id,p.job_id,o.collector_run_id,d.id,o.parser_version,p.cursor,'event_identity_conflict',p.raw_hash,d.actual_bytes,e.id,$2
     FROM sale_events e JOIN source_observations o ON o.id=e.observation_id
     JOIN collector_pages p ON p.observation_id=o.id JOIN collector_dispatches d ON d.committed_observation_id=o.id
     WHERE e.id=$1`,
    [photo.sale_event_id, end],
  );
  assert.equal(rows((await get(`records?record=${photo.sale_event_id}`)).data).length, 0);
  assert.equal(rows((await get(`quality?source=${source}`)).data).length, 0);
  assert.equal((await x.app.request(`/v1/sold/${x.queryId}`, { headers: x.headers })).status, 403);
  assert.ok(rows((await get(`collector?source=${source}`)).data).some((row) => row.source_id === source));

  x.clock.value = new Date(Date.parse(end) + 25 * 3600000).toISOString();
  operator = await actor(x, "admin");
  assert.equal(rows((await get(`coverage?source=${source}`)).data)[0].freshness, "stale_acceptable");
  await x.store.revokeSource(source, "Exercise telemetry revocation");
  assert.equal(rows((await get(`records?source=${source}&days=7`)).data).length, 0);
  const blocked = rows((await get(`coverage?source=${source}`)).data)[0];
  assert.equal(blocked.data_as_of, null);
  assert.equal(blocked.freshness, "forbidden");
  assert.equal(rows((await get(`quality?source=${source}&days=7`)).data).length, 0);
});

test("administrator compensation commits once and support sees only an opaque billing summary", async () => {
  const x = await createProductFixture(db, roots),
    admin = await actor(x, "admin"),
    support = await actor(x, "support");
  const charge = (await db.query("SELECT id FROM billing_charges WHERE query_id=$1", [x.queryId])).rows[0].id,
    path = `/admin/charges/${charge}/refund-credit`,
    key = randomUUID(),
    reason = "operator review fixture";
  assert.equal((await post(x, path, support, { reason })).status, 403);
  const results = await Promise.all(Array.from({ length: 10 }, () => post(x, path, admin, { reason }, key)));
  assert.ok(
    results.every((r) => r.status === 200),
    results.map((r) => r.status).join(","),
  );
  const ids = await Promise.all(results.map(async (r) => (await r.json()).data.audit_id));
  assert.equal(new Set(ids).size, 1);
  assert.equal(await billingCount(x.user), 1);
  assert.equal(
    (await db.query("SELECT state FROM billing_charges WHERE id=$1", [charge])).rows[0].state,
    "refunded",
  );
  assert.deepEqual(await x.billing.reconcile(x.user), []);
  const view = (await (await read(x, "/admin/billing?page_size=100", support)).json()).data.items.find(
    (r) => r.charge_id === charge,
  );
  assert.equal(view.state, "refunded");
  assert.equal(view.reconciliation_status, "balanced");
  assert.notEqual(view.user_ref, x.user);
  assert.equal((await post(x, path, admin, { reason: "other" }, key)).status, 409);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM payments WHERE user_id=$1", [x.user])).rows[0].n,
    0,
  );
});
