import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  createFixtureArtifact,
  digest,
  FixtureTransport,
  loadFixtureArtifact,
  OfflineCollectorWorker,
  parseHtmlMoney,
  parseHtmlPage,
  provisionFixtureSource,
  validateHtmlProfile,
} from "@soldbench/collector";
import { canonicalJson, evaluate } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";

const profile = JSON.parse(readFileSync(new URL("./fixtures/html/profile.json", import.meta.url))),
  template = readFileSync(new URL("./fixtures/html/search.html", import.meta.url), "utf8"),
  fixed = "2026-11-16T12:00:00Z",
  db = database(process.env.DATABASE_URL),
  roots = [];
before(async () => migrate(db));
after(async () => {
  await db.end();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function setup(custom = profile) {
  const source = await provisionFixtureSource(db, fixed),
    store = new CollectorStore(db, () => fixed, { htmlProfile: custom }),
    binding = {
      sourceId: source.sourceId,
      queryHash: digest("synthetic-html-query"),
      cursor: "start",
      asOf: fixed,
    },
    jobId = await store.enqueue({ ...source, queryHash: binding.queryHash, runKey: "html-run", asOf: fixed }),
    root = await mkdtemp(join(tmpdir(), "soldbench-html-"));
  roots.push(root);
  const raw = Buffer.from(
    template.replaceAll("SOURCE_ID", source.sourceId).replaceAll("QUERY_HASH", binding.queryHash),
  );
  return { ...source, store, binding, jobId, root, raw, media: new PrivateMediaStore(join(root, "media")) };
}
const response = (raw) => ({ status: 200, contentType: "text/html; charset=utf-8", bytes: raw });
function runner(x, raw = x.raw) {
  return new OfflineCollectorWorker(
    x.store,
    new FixtureTransport(new Map([["page:start", [response(raw)]]])),
    x.media,
  );
}

test("HTML text parser preserves sold evidence, actual price, withheld seller and correctly bound lazy primary image", async () => {
  const x = await setup(),
    page = parseHtmlPage(x.raw, x.binding, profile),
    row = page.records[0];
  assert.equal(page.records.length, 1);
  assert.equal(row.title, "Nintendo Switch OLED & controller");
  assert.equal(row.candidate.itemCents, 27550);
  assert.equal(row.candidate.priceStatus, "verified_actual");
  assert.equal(row.candidate.sellerRef, undefined);
  assert.equal(row.recordEvidence.fields.seller, "withheld");
  assert.equal(row.recordEvidence.attributes.model, "OLED");
  assert.equal(row.primaryImage.url, "https://images.example.test/primary-large.png");
  assert.equal(globalThis.__soldbench_script_executed, undefined);
  assert.equal(row.recordEvidence.profileHash, digest(canonicalJson(validateHtmlProfile(profile))));
});

test("money conversion uses exact declared separators and rejects ranges, ambiguous grouping and unsafe amounts", () => {
  for (const [text, currency, decimal, grouping, cents] of [
    ["US $1,234.56", "USD", ".", ",", 123456],
    ["1.234,56 €", "EUR", ",", ".", 123456],
    ["1\u202f234,5 EUR", "EUR", ",", " ", 123450],
    ["$0.00", "USD", ".", ",", 0],
  ])
    assert.equal(parseHtmlMoney(text, currency, decimal, grouping), cents);
  for (const text of ["$10 to $20", "$12,34.56", "-$5.00", "$1.234", "$1e3", "£10", "$90071992547409.92"])
    assert.throws(() => parseHtmlMoney(text, "USD", ".", ","), /html_money_invalid/);
});

test("unknown accepted offer, shipping, event identity and ended date never become verified facts", async () => {
  const x = await setup(),
    raw = Buffer.from(
      x.raw
        .toString()
        .replace("fixed_price", "best_offer")
        .replace("actual_paid", "displayed_only")
        .replace("independent_event", "listing_only")
        .replace("verified_free_shipping", "unknown")
        .replace('data-semantic="sold"', 'data-semantic="ended"'),
    ),
    row = parseHtmlPage(raw, x.binding, profile).records[0];
  assert.equal(row.candidate.priceStatus, "displayed_only");
  assert.equal(row.candidate.itemCents, 27550);
  assert.equal(row.candidate.eventKey, null);
  assert.equal(row.candidate.identityVerified, false);
  assert.equal(row.candidate.shippingCents, null);
  assert.deepEqual(row.candidate.time, { precision: "unknown" });
  assert.equal((await runner(x, raw).runOne(x.sourceId)).status, "completed");
  const inputs = await x.store.candidates(x.jobId);
  assert.equal(
    evaluate(inputs, {
      sourceId: x.sourceId,
      asOf: fixed,
      days: 90,
      basis: "item_plus_observed_shipping",
      limit: 200,
    }).stats.n_price_verified,
    0,
  );
});

test("HTML page raw hash, observation/event metadata and generated primary image persist atomically", async () => {
  const x = await setup(),
    image = await sharp({ create: { width: 12, height: 12, channels: 3, background: "blue" } })
      .png()
      .toBuffer(),
    transport = new FixtureTransport(
      new Map([
        ["page:start", [response(x.raw)]],
        [
          "image:https://images.example.test/primary-large.png",
          [{ status: 200, contentType: "image/png", bytes: image }],
        ],
      ]),
    ),
    worker = new OfflineCollectorWorker(x.store, transport, x.media);
  assert.equal((await worker.runOne(x.sourceId)).status, "completed");
  const page = (await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [x.jobId])).rows[0];
  assert.equal(page.raw_hash, digest(x.raw));
  assert.notEqual(page.raw_hash, digest(JSON.stringify(page.payload)));
  const evidence = (
    await db.query("SELECT * FROM listing_record_evidence WHERE observation_id=$1", [page.observation_id])
  ).rows[0];
  assert.equal(evidence.evidence.conditionRaw, "Pre-Owned");
  assert.equal(evidence.evidence.listingUrl, "https://market.example.test/item/synthetic-listing-1");
  assert.equal(evidence.evidence.fields.seller, "withheld");
  const img = (await db.query("SELECT * FROM listing_images WHERE observation_id=$1", [page.observation_id]))
    .rows[0];
  assert.equal(img.state, "available");
  assert.equal(img.sale_event_id, evidence.sale_event_id);
  assert.equal((await sharp(await worker.readImageInternal(img.id)).metadata()).format, "webp");
  await assert.rejects(
    db.query("UPDATE listing_record_evidence SET listing_id=$2 WHERE sale_event_id=$1", [
      evidence.sale_event_id,
      "00000000-0000-0000-0000-000000000001",
    ]),
    /foreign key/,
  );
});

test("HTML structural drift, ambiguous fields, image mismatches and unsafe URLs quarantine without a watermark", async () => {
  for (const change of [
    (s) => s.replace('class="title"', 'class="renamed-title"'),
    (s) => s.replace("</h2>", "</h2><h2 class=title>Ambiguous</h2>"),
    (s) => s.replace('data-kind="sold-record"', 'data-kind="unknown"'),
    (s) => s.replace('data-role="primary"', 'data-role="advertisement"'),
    (s) => s.replace('data-listing-id="synthetic-listing-1" src=', 'data-listing-id="wrong-listing" src='),
    (s) => s.replaceAll("https://images.example.test/primary", "https://unapproved.invalid/primary"),
    (s) => s.replace('data-next-cursor=""', ""),
    (s) => s.replace('data-evidence="actual_paid"', 'data-evidence="guessed_price"'),
  ]) {
    const x = await setup();
    assert.equal(
      (await runner(x, Buffer.from(change(x.raw.toString()))).runOne(x.sourceId)).status,
      "failed",
    );
    assert.equal(
      (await db.query("SELECT reason FROM collector_quarantines WHERE job_id=$1", [x.jobId])).rows[0].reason,
      "page_structure_invalid",
    );
    assert.equal(
      (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
      0,
    );
  }
});

test("explicit empty marker is required and source-reported totals keep their unit without altering statistics", async () => {
  const x = await setup();
  const empty = Buffer.from(
    `<main data-sb-schema="soldbench.synthetic-html.v1" data-source-id="${x.sourceId}" data-query-hash="${x.binding.queryHash}" data-cursor="start" data-next-cursor="" data-as-of="${fixed}"><p class="empty" data-confirmed="true">No sold records</p></main>`,
  );
  assert.equal(parseHtmlPage(empty, x.binding, profile).empty, true);
  assert.throws(
    () =>
      parseHtmlPage(Buffer.from(empty.toString().replace('data-confirmed="true"', "")), x.binding, profile),
    /html_empty_not_confirmed/,
  );
  const withCount = Buffer.from(
      x.raw
        .toString()
        .replace(
          'data-next-cursor=""',
          'data-next-cursor="" data-reported-count="210000" data-reported-unit="listings" data-reported-estimated="true"',
        ),
    ),
    page = parseHtmlPage(withCount, x.binding, profile);
  assert.deepEqual(page.sourceReported, { count: 210000, unit: "listings", estimated: true });
  assert.equal(page.records.length, 1);
});

test("profile is frozen per run, changed profile cannot claim or bind an artifact, and parser itself cannot mutate it", async () => {
  const x = await setup(),
    changed = { ...profile, revision: 2 },
    other = new CollectorStore(db, () => fixed, { htmlProfile: changed });
  await assert.rejects(other.claim(x.sourceId), /collector_profile_mismatch/);
  await assert.rejects(
    other.bindFixtureArtifact({
      jobId: x.jobId,
      sourceId: x.sourceId,
      queryHash: x.binding.queryHash,
      asOf: fixed,
      hash: digest("changed"),
      pageHashes: new Map(),
    }),
    /collector_profile_mismatch/,
  );
  assert.throws(() => {
    x.store.htmlProfile.fields.title.selector = "h3.title";
  }, TypeError);
  const artifact = createFixtureArtifact(
    {
      jobId: x.jobId,
      sourceId: x.sourceId,
      queryHash: x.binding.queryHash,
      asOf: fixed,
      htmlProfile: profile,
    },
    new Map([["page:start", [response(x.raw)]]]),
  );
  const loaded = loadFixtureArtifact(Buffer.from(JSON.stringify(artifact)));
  assert.equal(loaded.pageHashes.get("start").has(digest(x.raw)), true);
});

test("HTML response artifact runs through a new CLI process with profile binding and original HTML evidence", async () => {
  const x = await setup(),
    artifact = createFixtureArtifact(
      {
        jobId: x.jobId,
        sourceId: x.sourceId,
        queryHash: x.binding.queryHash,
        asOf: fixed,
        htmlProfile: profile,
      },
      new Map([["page:start", [response(x.raw)]]]),
    ),
    path = join(x.root, "artifact.json");
  await writeFile(path, JSON.stringify(artifact));
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-worker.mjs",
        `--fixture=${path}`,
        `--clock=${fixed}`,
      ],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: x.root } },
    ),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.networkRequests, 0);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM listing_record_evidence WHERE source_id=$1", [x.sourceId]))
      .rows[0].n,
    1,
  );
});

test("legitimate challenge or sign-in text never acts as a source access refusal, but explicit access markers do", async () => {
  const x = await setup(),
    valid = Buffer.from(
      x.raw
        .toString()
        .replace("Nintendo Switch OLED &amp; controller", "Pokemon Gym Challenge Sign In Coin")
        .replace("<body>", "<body><nav>Sign in</nav><script>var challenge = true;</script>"),
    );
  assert.equal((await runner(x, valid).runOne(x.sourceId)).status, "completed");
  for (const marker of [
    '<section class="access-wall">Verification required</section>',
    '<form class="access-login"></form>',
  ]) {
    const y = await setup();
    assert.equal(
      (await runner(y, Buffer.from(`<html><body>${marker}</body></html>`)).runOne(y.sourceId)).status,
      "failed",
    );
    assert.equal((await y.store.view(y.jobId)).error_code, "source_access_refused");
    assert.equal((await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [y.jobId])).rowCount, 0);
  }
});

test("invalid selector configurations are rejected before a run or circuit mutation", async () => {
  for (const change of [
    { root: "[" },
    { accessBlocks: ["["] },
    { fields: { ...profile.fields, title: { selector: "[" } } },
  ]) {
    const invalid = { ...profile, ...change };
    assert.throws(() => validateHtmlProfile(invalid), /invalid_html_profile/);
    assert.throws(
      () => new CollectorStore(db, () => fixed, { htmlProfile: invalid }),
      /invalid_html_profile/,
    );
  }
});

test("persisted HTML candidates retain titles for downstream result sorting", async () => {
  const x = await setup();
  await runner(x).runOne(x.sourceId);
  const inputs = await x.store.candidates(x.jobId);
  assert.equal(inputs[0].title, "Nintendo Switch OLED & controller");
  const second = { ...inputs[0], eventKey: "synthetic-second", title: "Apple controller", itemCents: 20000 };
  const result = evaluate([...inputs, second], {
    sourceId: x.sourceId,
    asOf: fixed,
    days: 90,
    basis: "item",
    limit: 200,
    presentationSort: "title_asc",
  });
  assert.deepEqual(
    result.comps.map((r) => r.eventKey),
    ["synthetic-second", "synthetic-event-1"],
  );
});

test("one-command HTML demo proves two real HTML pages, eight bound generated primary images and an eligible median", async () => {
  const x = await setup();
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-html-demo.mjs"],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: x.root } },
    ),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.pageCount, 2);
  assert.equal(report.recordEvidenceCount, 8);
  assert.equal(report.availablePrimaryImages, 8);
  assert.equal(report.stats.n_price_verified, 8);
  assert.equal(report.stats.median_cents, 27400);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.sourceVerified, false);
});

test("HTML and main-image work resumes across two separate processes without replaying committed pages", async () => {
  const x = await setup(),
    env = { ...process.env, COLLECTOR_DEMO_DIR: x.root };
  const prepared = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-html-demo.mjs", "--prepare-only"],
      { encoding: "utf8", env },
    ),
  );
  const base = [
    "--import",
    "./scripts/test-network.mjs",
    "scripts/collector-worker.mjs",
    `--fixture=${prepared.artifactPath}`,
  ];
  const first = JSON.parse(
    execFileSync(process.execPath, [...base, "--max-pages=1"], { encoding: "utf8", env }),
  );
  assert.equal(first.status, "retry");
  assert.equal(first.pageCount, 1);
  const job = await x.store.view(prepared.jobId),
    resumeClock = new Date(job.available_at.getTime() + 1).toISOString();
  const second = JSON.parse(
    execFileSync(process.execPath, [...base, `--clock=${resumeClock}`], { encoding: "utf8", env }),
  );
  assert.equal(second.status, "completed");
  assert.equal(second.pageCount, 2);
  assert.equal(second.requestsReserved, 10);
  assert.notEqual(first.pid, second.pid);
  const actual = (
    await db.query(
      "SELECT (SELECT count(*) FROM sale_events WHERE source_id=$1)::int n,(SELECT count(*) FROM listing_images WHERE source_id=$1 AND state='available')::int images",
      [job.source_id],
    )
  ).rows[0];
  assert.deepEqual(actual, { n: 8, images: 8 });
});
