import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorRefresh,
  CollectorStore,
  createFixtureArtifact,
  digest,
  fixtureResponse,
  loadFixtureArtifact,
  provisionFixtureSource,
} from "@soldbench/collector";
import { database, migrate } from "@soldbench/db";
import sharp from "sharp";
import { publishFixtureFile } from "../scripts/collector-fixture-file.mjs";
import { createFixtureIntakeScanner } from "../scripts/collector-intake.mjs";
import { workerEnvironment } from "../scripts/collector-launcher.mjs";
import { initializeCluster, startCluster, stopCluster, urlFor } from "../scripts/local-db.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  children = [],
  fixed = "2026-11-16T12:00:00Z";
before(async () => migrate(db));
async function waitFor(check, limit = 5000) {
  const end = performance.now() + limit;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("test_process_deadline");
}
function start(script, args = [], env = {}) {
  const child = spawn(process.execPath, ["--import", "./scripts/test-network.mjs", script, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const state = { child, output: "", errors: "" };
  child.stdout.on("data", (v) => {
    state.output += v;
  });
  child.stderr.on("data", (v) => {
    state.errors += v;
  });
  state.exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return state;
}
after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await db.end();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "soldbench-isolation-"));
  roots.push(value);
  return value;
}
async function preparedDemo(directory, env = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-html-demo.mjs", "--prepare-only"],
      { encoding: "utf8", env: { ...process.env, ...env, COLLECTOR_DEMO_DIR: directory } },
    ),
  );
}

test("collector child environment excludes application credentials and Node preloads", () => {
  const environment = workerEnvironment({
    DATABASE_URL: "postgresql://localhost/fixture",
    COLLECTOR_DEMO_DIR: "/tmp/fixture",
    PATH: "/usr/bin",
    NODE_OPTIONS: "--import=untrusted",
    NODE_PATH: "untrusted",
    STRIPE_SECRET_KEY: "never-pass",
    SESSION_SECRET: "never-pass",
    COMPSNIPER_API_KEY: "never-pass",
    COLLECTOR_ENABLED: "true",
    DATA_MODE: "live",
  });
  assert.deepEqual(
    Object.keys(environment).sort(),
    ["COLLECTOR_DEMO_DIR", "COLLECTOR_ENABLED", "DATABASE_URL", "DATA_MODE", "PATH", "PAYMENTS_MODE"].sort(),
  );
  assert.equal(environment.COLLECTOR_ENABLED, "false");
  assert.equal(environment.DATA_MODE, "offline_fixture");
});

test("bounded launcher executes an owned worker and reports its actual final cycle", async () => {
  const directory = await root(),
    prepared = await preparedDemo(directory),
    run = start(
      "scripts/collector-launcher.mjs",
      [`--fixture=${prepared.artifactPath}`, "--max-ms=5000", "--grace-ms=200", "--heap-mb=128"],
      { COLLECTOR_DEMO_DIR: directory },
    ),
    outcome = await run.exited;
  assert.equal(outcome.code, 0, run.errors);
  const report = JSON.parse(run.output);
  assert.equal(report.workerExited, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.cycle.status, "completed");
  assert.equal(report.cycle.pageCount, 2);
  assert.equal(report.limits.v8HeapMb, 128);
  assert.throws(() => process.kill(report.workerPid, 0), /ESRCH/);
});

test("supervisor rotates JSON and multiple frozen HTML profiles within one shared dispatch limit", async () => {
  const spool = await root();
  const now = (await db.query("SELECT clock_timestamp() t")).rows[0].t.toISOString();
  const source = await provisionFixtureSource(db, now);
  const profilePath = "tests/fixtures/html/profile.json";
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const alternate = { ...profile, revision: profile.revision + 1 };
  const secondPath = join(spool, "profile-2.json");
  await writeFile(secondPath, JSON.stringify(alternate));
  const json = new CollectorStore(db);
  const html = new CollectorStore(db, undefined, { htmlProfile: profile });
  const htmlNext = new CollectorStore(db, undefined, { htmlProfile: alternate });
  const unconfigured = new CollectorStore(db, undefined, {
    htmlProfile: { ...profile, revision: profile.revision + 2 },
  });
  async function create(store, keyword) {
    return new CollectorRefresh(store).create({
      ...source,
      query: new URLSearchParams({ q: keyword }),
      key: randomUUID(),
      intervalSeconds: 3600,
      maxLagSeconds: 300,
    });
  }
  for (let i = 0; i < 8; i++) await create(json, `Offline JSON model ${i + 1}`);
  await create(html, "Offline original HTML");
  await create(htmlNext, "Offline revised HTML");
  await create(unconfigured, "Offline unconfigured HTML");
  const run = (...flags) =>
    start(
      "scripts/collector-supervisor.mjs",
      [`--source=${source.sourceId}`, `--spool=${spool}`, "--refresh=true", ...flags],
      { MEDIA_ROOT: spool },
    );
  const duplicate = run(`--refresh-profile=${profilePath}`, `--refresh-profile=${profilePath}`);
  assert.equal((await duplicate.exited).code, 1);
  assert.match(duplicate.errors, /collector_supervisor_duplicate_profile/);
  const jobs = async () =>
    (
      await db.query(
        `SELECT p.profile_hash, o.status, r.parser_profile_hash FROM collector_refresh_plans p
       LEFT JOIN collector_refresh_occurrences o ON o.plan_id=p.id AND o.source_id=p.source_id
       LEFT JOIN collector_jobs j ON j.id=o.job_id AND j.source_id=o.source_id
       LEFT JOIN collector_runs r ON r.id=j.collector_run_id AND r.source_id=j.source_id
       WHERE p.source_id=$1`,
        [source.sourceId],
      )
    ).rows;
  assert.ok((await jobs()).every((row) => row.status === null));
  const flags = [
    "--refresh-include-json=true",
    `--refresh-profile=${profilePath}`,
    `--refresh-profile=${secondPath}`,
  ];
  const first = run(...flags);
  assert.equal((await first.exited).code, 0, first.errors);
  assert.equal(JSON.parse(first.output).scheduled.enqueued, 8);
  const before = await jobs();
  assert.equal(before.filter((row) => row.status === "enqueued" && row.profile_hash === null).length, 6);
  for (const store of [html, htmlNext]) {
    const row = before.find((row) => row.profile_hash === store.profileHash);
    assert.equal(row.status, "enqueued");
    assert.equal(row.parser_profile_hash, store.profileHash);
  }
  assert.equal(before.find((row) => row.profile_hash === unconfigured.profileHash).status, "planned");
  const second = run(...flags);
  assert.equal((await second.exited).code, 0, second.errors);
  assert.equal(JSON.parse(second.output).scheduled.enqueued, 2);
  assert.equal((await jobs()).filter((row) => row.status === "enqueued").length, 10);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM collector_dispatches WHERE source_id=$1", [source.sourceId]))
      .rows[0].n,
    0,
  );
});

test("supervisor preserves viable HTML and JSON slots while accounting for a missed backlog", async () => {
  const spool = await root();
  const now = (await db.query("SELECT clock_timestamp() t")).rows[0].t.getTime();
  const first = new Date(now - (250 * 60 + 10) * 1000).toISOString();
  const source = await provisionFixtureSource(db, first);
  const profilePath = "tests/fixtures/html/profile.json";
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const profileStore = new CollectorStore(db, undefined, { htmlProfile: profile });
  const json = new CollectorRefresh(new CollectorStore(db, () => first));
  const plan = (q) => ({
    ...source,
    query: new URLSearchParams({ q }),
    key: randomUUID(),
    intervalSeconds: 60,
    maxLagSeconds: 60,
  });
  const history = await json.create(plan("Fixture after a long interruption"));
  const html = await new CollectorRefresh(profileStore).create(plan("Fixture first HTML slot"));
  const result = start(
    "scripts/collector-supervisor.mjs",
    [
      `--source=${source.sourceId}`,
      `--spool=${spool}`,
      "--refresh=true",
      "--refresh-include-json=true",
      `--refresh-profile=${profilePath}`,
    ],
    { MEDIA_ROOT: spool },
  );
  assert.equal((await result.exited).code, 0, result.errors);
  const { scheduled } = JSON.parse(result.output);
  assert.equal(scheduled.materialized, 200);
  assert.equal(scheduled.more, true);
  assert.equal(scheduled.prioritized, 2);
  assert.equal(scheduled.enqueued, 2);
  const current = (
    await db.query(
      "SELECT plan_id FROM collector_refresh_occurrences WHERE source_id=$1 AND status='enqueued'",
      [source.sourceId],
    )
  ).rows;
  assert.deepEqual(new Set(current.map(({ plan_id }) => plan_id)), new Set([history, html]));
});

test("supervisor schedules eligible offline plans once and processes the published response", async () => {
  const spool = await root();
  const now = (await db.query("SELECT clock_timestamp() t")).rows[0].t.toISOString();
  const source = await provisionFixtureSource(db, now);
  const store = new CollectorStore(db);
  const profilePath = "tests/fixtures/html/profile.json";
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const htmlStore = new CollectorStore(db, undefined, { htmlProfile: profile });
  const setup = (keyword) => ({
    ...source,
    query: new URLSearchParams({ q: keyword }),
    key: randomUUID(),
    intervalSeconds: 3600,
    maxLagSeconds: 300,
  });
  const jsonPlan = await new CollectorRefresh(store).create(setup("Synthetic collector JSON"));
  const htmlPlan = await new CollectorRefresh(htmlStore).create(setup("Synthetic collector HTML"));
  const command = [`--source=${source.sourceId}`, `--spool=${spool}`, "--refresh=true"];
  const run = (...flags) =>
    start("scripts/collector-supervisor.mjs", [...command, ...flags], { MEDIA_ROOT: spool });
  const first = run("--watch=true", "--interval-ms=250");
  await waitFor(() => first.output.includes('"enqueued":1'));
  const competing = run();
  assert.equal((await competing.exited).code, 0);
  assert.equal(JSON.parse(competing.output).state, "already_supervised");
  assert.equal(JSON.parse(first.output.trim().split("\n")[0]).queues.pages.artifactUnavailable, 1);
  const occurrences = async () =>
    (
      await db.query(
        "SELECT plan_id,status,job_id FROM collector_refresh_occurrences WHERE source_id=$1 ORDER BY plan_id",
        [source.sourceId],
      )
    ).rows;
  const initial = await occurrences();
  assert.equal(initial.length, 2);
  assert.equal(initial.find((row) => row.plan_id === htmlPlan).status, "planned");
  const jobId = initial.find((row) => row.plan_id === jsonPlan).job_id;
  const job = await store.view(jobId);
  assert.equal(job.status, "queued");
  const handoff = (...flags) =>
    start("scripts/collector-handoff.mjs", [`--source=${source.sourceId}`, ...flags]);
  const listed = handoff("--limit=1");
  assert.equal((await listed.exited).code, 0, listed.errors);
  const discovered = JSON.parse(listed.output);
  assert.equal(discovered.nextAfter, null);
  assert.equal(discovered.jobs[0].queryHash, job.query_hash);
  assert.equal(discovered.jobs[0].jobId, jobId);
  assert.equal(discovered.jobs[0].artifactHash, null);
  const producer = await root();
  const path = join(producer, "scheduled-template.json");
  const url = "https://images.example.test/scheduled.png";
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  const record = (number) => ({
    listingId: `scheduled-listing-${number}`,
    title: "Synthetic scheduled listing",
    candidate: {
      eventKey: `scheduled-event-${number}`,
      identityVerified: true,
      comparable: true,
      priceStatus: "verified_actual",
      format: "fixed_price",
      currency: "USD",
      itemCents: 1000,
      shippingCents: 0,
      shippingStatus: "verified_free_shipping",
      time: { precision: "instant", value: now },
    },
  });
  const template = {
    schema: "soldbench.collector-json-responses.v1",
    synthetic: true,
    pages: [
      {
        cursor: "start",
        nextCursor: "p2",
        records: [{ ...record(1), primaryImage: { role: "primary", url } }],
      },
      { cursor: "p2", nextCursor: null, records: [record(2)] },
    ],
    images: [{ url, contentType: "image/png", bytesBase64: image.toString("base64") }],
  };
  const packageArgs = ["--action=package", `--job=${jobId}`, `--spool=${spool}`, `--template=${path}`];
  await writeFile(path, JSON.stringify({ ...template, pages: template.pages.slice(0, 1) }));
  const incomplete = handoff(...packageArgs);
  assert.equal((await incomplete.exited).code, 1);
  assert.match(incomplete.errors, /fixture_template_page_chain_invalid/);
  assert.equal((await store.view(jobId)).request_count, 0);
  assert.equal(first.child.kill("SIGTERM"), true);
  assert.equal((await first.exited).code, 0, first.errors);
  await writeFile(path, JSON.stringify(template));
  const uploads = [handoff(...packageArgs), handoff(...packageArgs)];
  for (const upload of uploads) assert.equal((await upload.exited).code, 0, upload.errors);
  assert.deepEqual(JSON.parse(uploads[0].output), JSON.parse(uploads[1].output));
  const resumed = run();
  assert.equal((await resumed.exited).code, 0, resumed.errors);
  assert.equal((await store.view(jobId)).status, "completed");
  const html = run(`--refresh-profile=${profilePath}`);
  assert.equal((await html.exited).code, 0, html.errors);
  assert.equal(JSON.parse(html.output).scheduled.enqueued, 1);
  const final = await occurrences();
  assert.equal(final.length, 2);
  assert.equal(final.find((row) => row.plan_id === jsonPlan).job_id, jobId);
  assert.equal(final.find((row) => row.plan_id === htmlPlan).status, "enqueued");
  const htmlJobId = final.find((row) => row.plan_id === htmlPlan).job_id;
  const htmlHandoff = handoff("--action=package", `--job=${htmlJobId}`, `--template=${path}`);
  assert.equal((await htmlHandoff.exited).code, 1);
  assert.match(htmlHandoff.errors, /collector_handoff_requires_original_html_response/);
  const completed = await store.view(jobId);
  assert.equal(completed.page_count, 2);
  assert.equal(completed.request_count, 3);
  const previousJsonPage = fixtureResponse({
    schema: "soldbench.synthetic-page.v1",
    synthetic: true,
    sourceId: source.sourceId,
    queryHash: completed.query_hash,
    asOf: completed.as_of.toISOString(),
    cursor: "start",
    nextCursor: "p2",
    records: template.pages[0].records.map((row) => ({
      ...row,
      candidate: { ...row.candidate, sourceId: source.sourceId },
    })),
    empty: false,
  });
  assert.equal(
    (await db.query("SELECT raw_hash FROM collector_pages WHERE job_id=$1 AND cursor='start'", [jobId]))
      .rows[0].raw_hash,
    digest(previousJsonPage.bytes),
  );
  assert.equal(
    (
      await db.query("SELECT count(*)::int n FROM listing_images WHERE source_id=$1 AND state='available'", [
        source.sourceId,
      ])
    ).rows[0].n,
    1,
  );
  const htmlJob = await store.view(htmlJobId);
  const rawHtml = (await readFile("tests/fixtures/html/search.html", "utf8"))
    .replace('data-source-id="SOURCE_ID"', `data-source-id="${source.sourceId}"`)
    .replace('data-query-hash="QUERY_HASH"', `data-query-hash="${htmlJob.query_hash}"`)
    .replace('data-as-of="2026-11-16T12:00:00Z"', `data-as-of="${htmlJob.as_of.toISOString()}"`);
  const htmlFile = join(producer, "scheduled-html.json");
  const htmlPage = (body) => ({ cursor: "start", bytesBase64: Buffer.from(body).toString("base64") });
  const htmlTemplate = {
    schema: "soldbench.collector-html-responses.v1",
    synthetic: true,
    profile,
    pages: [htmlPage(rawHtml)],
    images: [
      {
        url: "https://images.example.test/primary-large.png",
        contentType: "image/png",
        bytesBase64: image.toString("base64"),
      },
    ],
  };
  async function packageHtml(input) {
    await writeFile(htmlFile, JSON.stringify(input));
    const result = handoff(
      "--action=package",
      `--job=${htmlJobId}`,
      `--spool=${spool}`,
      `--template=${htmlFile}`,
    );
    const { code } = await result.exited;
    return { code, output: result.output, errors: result.errors };
  }
  for (const [changes, reason] of [
    [{ profile: { ...profile, revision: profile.revision + 1 } }, "collector_handoff_profile_mismatch"],
    [{ pages: [htmlPage(rawHtml.replace(htmlJob.query_hash, "0".repeat(64)))] }, "html_page_binding_invalid"],
    [
      { pages: [htmlPage(rawHtml.replace('data-next-cursor=""', 'data-next-cursor="missing-page"'))] },
      "fixture_template_page_chain_invalid",
    ],
    [
      { images: [{ ...htmlTemplate.images[0], url: "https://images.example.test/gallery.png" }] },
      "fixture_template_image_invalid",
    ],
  ]) {
    const rejected = await packageHtml({ ...htmlTemplate, ...changes });
    assert.equal(rejected.code, 1);
    assert.equal(JSON.parse(rejected.errors).error, reason);
  }
  const runBinding = (
    await db.query("SELECT fixture_artifact_hash FROM collector_runs WHERE id=$1", [htmlJob.collector_run_id])
  ).rows[0];
  assert.equal(runBinding.fixture_artifact_hash, null);
  const accepted = await packageHtml(htmlTemplate);
  assert.equal(accepted.code, 0, accepted.errors);
  assert.equal((await packageHtml(htmlTemplate)).output, accepted.output);
  const htmlRunner = run();
  assert.equal((await htmlRunner.exited).code, 0, htmlRunner.errors);
  assert.equal((await store.view(htmlJobId)).status, "completed");
  const archived = (
    await db.query(
      `SELECT p.raw_hash,i.state FROM collector_pages p JOIN listing_images i
       ON i.observation_id=p.observation_id AND i.source_id=p.source_id WHERE p.job_id=$1`,
      [htmlJobId],
    )
  ).rows;
  assert.deepEqual(archived, [{ raw_hash: digest(Buffer.from(rawHtml)), state: "available" }]);
});

test("fixture intake replays equal content and leaves a conflicting file untouched", async () => {
  const producer = await root();
  const spool = await root();
  const prepared = await preparedDemo(producer);
  const input = await readFile(prepared.artifactPath);
  const original = loadFixtureArtifact(input);
  const args = [`--source=${prepared.sourceId}`, `--spool=${spool}`, `--fixture=${prepared.artifactPath}`];
  const [a, b] = [start("scripts/collector-intake.mjs", args), start("scripts/collector-intake.mjs", args)];
  assert.equal((await a.exited).code, 0, a.errors);
  assert.equal((await b.exited).code, 0, b.errors);
  const receipt = JSON.parse(a.output);
  assert.deepEqual(receipt, JSON.parse(b.output));
  assert.equal(receipt.artifactHash, original.hash);
  assert.equal((await readFile(receipt.artifactPath)).toString(), input.toString());
  assert.equal((await new CollectorStore(db).view(prepared.jobId)).lease_count, 0);

  const modified = JSON.parse(input);
  modified.frames.reverse();
  await writeFile(prepared.artifactPath, JSON.stringify(modified));
  const conflicting = start("scripts/collector-intake.mjs", args);
  assert.equal((await conflicting.exited).code, 1);
  assert.equal(JSON.parse(conflicting.errors).error, "fixture_artifact_changed");
  assert.deepEqual(await readFile(receipt.artifactPath), input);
});

test("revocation blocks new fixture publication and removes only source-bound response files", async () => {
  const spool = await root(),
    first = await preparedDemo(spool),
    other = await preparedDemo(spool),
    laterSpool = await root();
  const original = await readFile(first.artifactPath);
  const loaded = loadFixtureArtifact(original);
  const pending = join(spool, "collector-incoming", first.sourceId, `${first.jobId}.${loaded.hash}.json`);
  await publishFixtureFile(pending, loaded.artifact);
  const interruptedPublication = `${first.artifactPath}.${randomUUID()}.tmp`;
  const staleTemporary = `${first.artifactPath}.${randomUUID()}.tmp`;
  await link(first.artifactPath, interruptedPublication);
  await writeFile(staleTemporary, original, { mode: 0o600 });
  const unexpectedCopy = join(laterSpool, "not-a-collector-name.json");
  await link(pending, unexpectedCopy);
  const unverified = join(spool, `collector-fixture-${first.jobId}.json`);
  await writeFile(unverified, "Unverified bytes", { mode: 0o600 });
  const cleanup = () =>
    start("scripts/collector-spool-cleanup.mjs", [`--source=${first.sourceId}`, `--spool=${spool}`]);
  const active = cleanup();
  assert.equal((await active.exited).code, 1);
  assert.match(active.errors, /collector_spool_source_not_revoked/);
  assert.deepEqual(await readFile(first.artifactPath), original);
  await new CollectorStore(db).revokeSource(first.sourceId, "response_package_revocation_fixture");
  const intake = start("scripts/collector-intake.mjs", [
    `--source=${first.sourceId}`,
    `--spool=${laterSpool}`,
    `--fixture=${first.artifactPath}`,
  ]);
  assert.equal((await intake.exited).code, 1);
  assert.match(intake.errors, /source_inactive/);
  assert.deepEqual(await readdir(join(laterSpool, "collector-incoming", first.sourceId)), []);
  const revoked = cleanup();
  assert.equal((await revoked.exited).code, 2, revoked.errors);
  const report = JSON.parse(revoked.output);
  assert.equal(report.scope, "configured_spool_only");
  assert.equal(report.removed, 3);
  assert.equal(report.unverified, 2);
  await assert.rejects(readFile(first.artifactPath), /ENOENT/);
  await assert.rejects(readFile(interruptedPublication), /ENOENT/);
  await assert.rejects(readFile(staleTemporary), /ENOENT/);
  assert.deepEqual(await readFile(pending), original);
  assert.deepEqual(await readFile(unexpectedCopy), original);
  assert.equal(await readFile(unverified, "utf8"), "Unverified bytes");
  assert.ok((await readFile(other.artifactPath)).length > 0);
  await rm(unverified);
  await rm(unexpectedCopy);
  const retry = cleanup();
  assert.equal((await retry.exited).code, 0, retry.errors);
  assert.equal(JSON.parse(retry.output).removed, 1);
  await assert.rejects(readFile(pending), /ENOENT/);
  assert.equal((await new CollectorStore(db).view(first.jobId)).request_count, 0);
});

test("offline supervisor recovers an intake interrupted before the artifact database binding", async () => {
  const directory = await root();
  const now = new Date().toISOString();
  const source = await provisionFixtureSource(db, now);
  const store = new CollectorStore(db);
  const queryHash = digest("staged fixture recovery");
  const jobId = await store.enqueue({ ...source, queryHash, asOf: now, runKey: randomUUID() });
  const artifact = createFixtureArtifact(
    { sourceId: source.sourceId, jobId, queryHash, asOf: now },
    new Map([
      [
        "page:start",
        [
          fixtureResponse({
            schema: "soldbench.synthetic-page.v1",
            synthetic: true,
            sourceId: source.sourceId,
            queryHash,
            cursor: "start",
            nextCursor: null,
            asOf: now,
            empty: true,
            records: [],
          }),
        ],
      ],
    ]),
  );
  const { hash } = loadFixtureArtifact(Buffer.from(JSON.stringify(artifact)));
  const pendingDirectory = join(directory, "collector-incoming", source.sourceId);
  await mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
  const pending = join(pendingDirectory, `${jobId}.${hash}.json`);
  await publishFixtureFile(pending, artifact);
  const conflictingPath = join(directory, `collector-html-fixture-${jobId}.json`);
  await writeFile(conflictingPath, "Existing alternate format", { mode: 0o600 });
  const conflict = start("scripts/collector-intake.mjs", [
    `--source=${source.sourceId}`,
    `--spool=${directory}`,
    `--fixture=${pending}`,
  ]);
  assert.equal((await conflict.exited).code, 1);
  assert.match(conflict.errors, /fixture_spool_file_conflict/);
  const unbound = await db.query(
    "SELECT fixture_artifact_hash FROM collector_runs r JOIN collector_jobs j ON j.collector_run_id=r.id WHERE j.id=$1",
    [jobId],
  );
  assert.equal(unbound.rows[0].fixture_artifact_hash, null);
  assert.equal(await readFile(conflictingPath, "utf8"), "Existing alternate format");
  await rm(conflictingPath);
  const run = start(
    "scripts/collector-supervisor.mjs",
    [`--source=${source.sourceId}`, `--spool=${directory}`],
    { MEDIA_ROOT: join(directory, "media") },
  );
  assert.equal((await run.exited).code, 0, run.errors);
  const result = JSON.parse(run.output);
  assert.equal(result.intake.published, 1);
  assert.equal(result.cycles[0].claimed, true);
  assert.equal((await store.view(jobId)).page_count, 1);
  assert.deepEqual(await readdir(pendingDirectory), []);
  const replay = start(
    "scripts/collector-supervisor.mjs",
    [`--source=${source.sourceId}`, `--spool=${directory}`],
    { MEDIA_ROOT: join(directory, "media") },
  );
  assert.equal((await replay.exited).code, 0, replay.errors);
  assert.deepEqual(JSON.parse(replay.output).cycles, []);
  assert.equal((await store.view(jobId)).request_count, 1);
});

test("intake scan progresses past noisy prefixes and reopens a replaced source directory", async (t) => {
  const producer = await root();
  const spool = await root();
  const prepared = await preparedDemo(producer);
  const loaded = loadFixtureArtifact(await readFile(prepared.artifactPath));
  const pending = join(spool, "collector-incoming", prepared.sourceId);
  await mkdir(pending, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 9; i++) await writeFile(join(pending, `old-${i}.log`), "synthetic");
  const scanner = createFixtureIntakeScanner(db, spool, prepared.sourceId, 2);
  t.after(() => scanner.close());
  const signal = new AbortController().signal;
  for (let i = 0; i < 4; i++)
    assert.deepEqual(await scanner.resume(signal), {
      published: 0,
      deferred: 0,
      scanned: 2,
      status: "scan_limit",
    });
  assert.deepEqual(await scanner.resume(signal), { published: 0, deferred: 0, scanned: 1, status: "ready" });
  assert.equal((await scanner.resume(signal)).status, "scan_limit");
  await rename(pending, `${pending}-previous`);
  await mkdir(pending, { mode: 0o700 });
  await publishFixtureFile(join(pending, `${prepared.jobId}.${loaded.hash}.json`), loaded.artifact);
  const result = await scanner.resume(signal);
  assert.deepEqual(result, { published: 1, deferred: 0, scanned: 1, status: "ready" });
  assert.deepEqual(await readdir(pending), []);
  assert.equal((await readdir(`${pending}-previous`)).length, 9);
  assert.equal(
    loadFixtureArtifact(await readFile(join(spool, `collector-html-fixture-${prepared.jobId}.json`))).hash,
    loaded.hash,
  );
});

test("watcher captures current health from PostgreSQL and avoids duplicate reports after restart", async () => {
  const spool = await root();
  const prepared = await preparedDemo(spool);
  const { sourceId } = prepared;
  await db.query(
    `INSERT INTO collector_health_snapshots(source_id,captured_at,metrics)
     SELECT s.id,now(),jsonb_build_object('schema','soldbench.collector-health.v1',
       'mode','offline_fixture','clock','explicit_simulation','onlineVerified',false,
       'permissionEpoch',s.permission_epoch::text)
     FROM sources s WHERE s.id=$1`,
    [sourceId],
  );
  const launch = () =>
    start(
      "scripts/collector-supervisor.mjs",
      [`--source=${sourceId}`, `--spool=${spool}`, "--watch=true", "--interval-ms=250"],
      { MEDIA_ROOT: join(spool, "media") },
    );
  const reports = async () =>
    (
      await db.query(
        `SELECT id,metrics FROM collector_health_snapshots WHERE source_id=$1
       AND metrics->>'schema'='soldbench.collector-health.v1' AND metrics->>'clock'='database'
       ORDER BY captured_at`,
        [sourceId],
      )
    ).rows;
  const inspect = async (expected) => {
    const watcher = launch();
    await waitFor(() => watcher.output.includes(`"healthReport":"${expected}"`));
    assert.equal(watcher.child.kill("SIGTERM"), true);
    assert.deepEqual(await watcher.exited, { code: 0, signal: null });
  };
  await inspect("recorded");
  const [first] = await reports();
  assert.equal(first.metrics.jobs.completed, 1);
  assert.equal(first.metrics.media.primaryImageCoverage.eligibleObservations, 8);
  assert.equal(first.metrics.networkRequests, 0);
  await inspect("recent");
  assert.deepEqual(
    (await reports()).map(({ id }) => id),
    [first.id],
  );
  await db.query(
    "UPDATE collector_health_snapshots SET captured_at=now()-interval '16 minutes' WHERE id=$1",
    [first.id],
  );
  await inspect("recorded");
  assert.equal((await reports()).length, 2);
  await new CollectorStore(db).revokeSource(sourceId, "synthetic_health_test_revoked");
  await inspect("unavailable");
  assert.equal((await reports()).length, 2);
});

test("supervisor stays running with offline spool absent, expires missing work and resumes when files return", async () => {
  const directory = await root();
  const spool = join(directory, "spool");
  const prepared = await preparedDemo(directory);
  const artifact = loadFixtureArtifact(await readFile(prepared.artifactPath)).artifact;
  const store = new CollectorStore(db, undefined, { htmlProfile: artifact.htmlProfile });
  const original = await store.view(prepared.jobId);
  const expired = await store.enqueue({
    sourceId: original.source_id,
    configId: original.config_id,
    queryHash: digest("never delivered"),
    runKey: randomUUID(),
    asOf: artifact.asOf,
    ttlSeconds: 1,
  });
  const watcher = start(
    "scripts/collector-supervisor.mjs",
    [`--source=${prepared.sourceId}`, `--spool=${spool}`, "--watch=true", "--interval-ms=250"],
    { MEDIA_ROOT: join(directory, "media") },
  );
  await waitFor(() => watcher.output.includes('"state":"spool_unavailable"'));
  const posture = (
    await db.query(
      "SELECT cycle_summary,expected_progress_at FROM collector_supervisor_state WHERE source_id=$1",
      [prepared.sourceId],
    )
  ).rows[0];
  assert.equal(posture.cycle_summary.spool, "unavailable");
  assert.ok(posture.expected_progress_at);
  await waitFor(async () => (await store.view(expired)).status === "failed");
  assert.equal(watcher.child.exitCode, null);
  assert.equal((await store.view(expired)).request_count, 0);
  await mkdir(spool);
  await rename(prepared.artifactPath, join(spool, `collector-html-fixture-${original.id}.json`));
  await waitFor(async () => (await store.view(original.id)).status === "completed");
  const images = (
    await db.query("SELECT count(*)::int n FROM listing_images WHERE source_id=$1 AND state='available'", [
      prepared.sourceId,
    ])
  ).rows[0].n;
  assert.equal(images, 8);
  assert.equal(watcher.child.kill("SIGTERM"), true);
  assert.deepEqual(await watcher.exited, { code: 0, signal: null });
  assert.deepEqual(
    (
      await db.query(
        "SELECT phase,expected_progress_at,job_id FROM collector_supervisor_state WHERE source_id=$1",
        [prepared.sourceId],
      )
    ).rows[0],
    { phase: "stopped", expected_progress_at: null, job_id: null },
  );
});

test("supervisor finds actionable work after a full page of missing packs and over 10000 archived entries", async () => {
  const directory = await root();
  const prepared = await preparedDemo(directory);
  const artifact = loadFixtureArtifact(await readFile(prepared.artifactPath)).artifact;
  const store = new CollectorStore(db, undefined, { htmlProfile: artifact.htmlProfile });
  const original = await store.view(prepared.jobId);
  for (let i = 0; i < 10001; i += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, 10001 - i) }, (_, offset) =>
        link(prepared.artifactPath, join(directory, `archive-${i + offset}`)),
      ),
    );
  }
  const earlier = [];
  for (let i = 0; i < 65; i++) {
    earlier.push(
      await store.enqueue({
        sourceId: original.source_id,
        configId: original.config_id,
        queryHash: digest(`missing pack ${i}`),
        runKey: randomUUID(),
        asOf: artifact.asOf,
      }),
    );
  }
  await db.query("UPDATE collector_jobs SET available_at=now()-interval '1 hour' WHERE id=ANY($1::uuid[])", [
    earlier,
  ]);
  const watcher = start(
    "scripts/collector-supervisor.mjs",
    [`--source=${prepared.sourceId}`, `--spool=${directory}`, "--watch=true", "--interval-ms=250"],
    { MEDIA_ROOT: join(directory, "media") },
  );
  await waitFor(async () => (await store.view(original.id)).status === "completed");
  assert.equal((await store.view(original.id)).request_count, 10);
  const first = JSON.parse(watcher.output.trim().split("\n")[0]);
  assert.deepEqual(first.queues.pages, {
    due: 66,
    scanned: 64,
    uninspected: 2,
    withArtifact: 0,
    artifactUnavailable: 64,
    deferred: 0,
  });
  assert.equal(watcher.child.kill("SIGTERM"), true);
  assert.deepEqual(await watcher.exited, { code: 0, signal: null });
});

test("offline supervisor serves the available queue, resumes primary images, and purges the withdrawn source", async () => {
  const directory = await root(),
    prepared = await preparedDemo(directory),
    artifact = JSON.parse(await readFile(prepared.artifactPath, "utf8")),
    store = new CollectorStore(db, undefined, { htmlProfile: artifact.htmlProfile }),
    first = await store.view(prepared.jobId),
    source = first.source_id;
  const extra = async (query) =>
    store.enqueue({
      sourceId: source,
      configId: first.config_id,
      queryHash: digest(query),
      asOf: first.as_of.toISOString(),
      runKey: randomUUID(),
    });
  const unavailable = await extra("missing fixture"),
    linked = await extra("symlinked fixture"),
    wrong = [];
  await symlink(prepared.artifactPath, join(directory, `collector-fixture-${linked}.json`));
  for (let i = 0; i < 4; i++) {
    const id = await extra(`misfiled fixture ${i}`);
    wrong.push(id);
    await writeFile(join(directory, `collector-fixture-${id}.json`), JSON.stringify(artifact), {
      mode: 0o600,
    });
  }
  await db.query("UPDATE collector_jobs SET available_at=now()-interval '1 hour' WHERE id=ANY($1::uuid[])", [
    wrong,
  ]);
  const command = [
      "scripts/collector-supervisor.mjs",
      [`--source=${source}`, `--spool=${directory}`, "--max-ms=8000"],
    ],
    env = { COLLECTOR_DEMO_DIR: directory, MEDIA_ROOT: join(directory, "media") };
  await writeFile(env.MEDIA_ROOT, "fixture media root temporarily unavailable", { mode: 0o600 });
  const loop = start(command[0], [...command[1], "--watch=true", "--interval-ms=250"], env);
  const reports = () =>
    loop.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  const original = await waitFor(
    () => reports().find((report) => report.cycles.some((cycle) => cycle.claimed)),
    8000,
  );
  assert.equal(original.externalNetworkRequests, 0);
  assert.equal(original.queues.pages.artifactUnavailable, 2);
  assert.equal(original.queues.pages.deferred, wrong.length);
  for (const id of wrong) {
    const rejected = reports()
      .flatMap((row) => row.cycles)
      .find((cycle) => cycle.jobId === id);
    assert.equal(rejected.claimed, false);
    assert.equal(rejected.exitCode, 1);
  }
  const duplicate = start(...command, env);
  assert.equal((await duplicate.exited).code, 0, duplicate.errors);
  assert.equal(JSON.parse(duplicate.output).state, "already_supervised");
  assert.equal((await store.view(first.id)).status, "completed");
  assert.equal((await store.view(first.id)).page_count, 2);
  const jobs = (
    await db.query("SELECT id,status FROM collector_image_jobs WHERE parent_job_id=$1", [first.id])
  ).rows;
  assert.equal(jobs.length, 8);
  assert.ok(jobs.every((job) => job.status === "retry"));
  await rm(env.MEDIA_ROOT);
  await db.query("UPDATE collector_image_jobs SET available_at=now() WHERE parent_job_id=$1", [first.id]);
  await waitFor(
    () =>
      reports().some((report) =>
        report.cycles.some(
          (cycle) =>
            cycle.lane === "images" &&
            cycle.mediaResults.filter((item) => item.status === "completed").length === 8,
        ),
      ),
    8000,
  );
  const results = await db.query(
    `SELECT (SELECT count(*) FROM collector_pages WHERE job_id=$1)::int pages,
            (SELECT count(*) FROM listing_images WHERE source_id=$2 AND state='available')::int images`,
    [first.id, source],
  );
  assert.deepEqual(results.rows[0], { pages: 2, images: 8 });
  assert.deepEqual((await readdir(join(directory, "collector-supervised-status"))).sort(), [
    `${first.id}-images.json`,
    `${first.id}-pages.json`,
  ]);
  for (const pending of [unavailable, linked, ...wrong]) {
    const row = await store.view(pending);
    assert.equal(row.lease_count, 0);
    assert.equal(row.request_count, 0);
  }
  loop.child.kill("SIGTERM");
  assert.deepEqual(await loop.exited, { code: 0, signal: null }, loop.errors);
  await store.revokeSource(source, "supervised_source_revocation");
  const cleanup = start(...command, env);
  assert.equal((await cleanup.exited).code, 0, cleanup.errors);
  const report = JSON.parse(cleanup.output);
  assert.equal(report.state, "source_inactive");
  assert.equal(report.maintenance.cleanupProcessed, 1);
  assert.equal(report.cycles.length, 0);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM listing_images WHERE source_id=$1 AND object_key IS NOT NULL",
        [source],
      )
    ).rows[0].n,
    0,
  );
});

test("supervisor stops an active child on ownership loss and recovers the same queue after PostgreSQL restarts", async () => {
  const directory = await root();
  const spool = join(directory, "spool");
  await mkdir(spool);
  const cluster = initializeCluster(directory);
  const url = urlFor(cluster, "postgres");
  const testSocket = process.env.SOLDBENCH_TEST_SOCKET;
  process.env.SOLDBENCH_TEST_SOCKET = cluster.socket;
  const env = {
    DATABASE_URL: url,
    SOLDBENCH_TEST_SOCKET: cluster.socket,
    MEDIA_ROOT: join(directory, "media"),
  };
  const target = database(url);
  const store = new CollectorStore(target);
  let running = false;
  let blocker;
  let supervisor;
  let phase = "starting";
  try {
    startCluster(cluster);
    running = true;
    const prepared = await preparedDemo(directory, env);
    const job = await store.view(prepared.jobId);
    stopCluster(cluster);
    running = false;
    supervisor = start(
      "scripts/collector-supervisor.mjs",
      [
        `--source=${job.source_id}`,
        `--spool=${spool}`,
        "--watch=true",
        "--interval-ms=250",
        "--max-ms=30000",
      ],
      env,
    );
    const unavailable = "soldbench_collector_supervisor_database_unavailable";
    const recovered = "soldbench_collector_supervisor_database_recovered";
    await waitFor(() => supervisor.errors.includes(unavailable));
    assert.equal(supervisor.child.exitCode, null);
    assert.equal(supervisor.output, "");
    startCluster(cluster);
    running = true;
    await waitFor(() => supervisor.output.includes(recovered));
    await waitFor(() => supervisor.output.includes('"artifactUnavailable":1'));
    phase = "waiting for blocked child";
    const owner = (
      await target.query(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=2
          AND classid = (hashtext('soldbench.offline-collector-supervisor')::bigint & 4294967295)::oid
          AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
        [job.source_id],
      )
    ).rows[0];
    assert.ok(owner);
    blocker = await target.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
    await rename(prepared.artifactPath, join(spool, `collector-html-fixture-${job.id}.json`));
    await waitFor(
      async () =>
        (
          await target.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event='advisory'
          AND query='SELECT pg_advisory_lock(hashtext(''soldbench:migrations''))'`,
          )
        ).rows[0],
    );
    assert.deepEqual(
      (
        await target.query("SELECT phase,job_id,lane FROM collector_supervisor_state WHERE source_id=$1", [
          job.source_id,
        ])
      ).rows[0],
      { phase: "dispatching", job_id: job.id, lane: "pages" },
    );
    assert.equal(
      (await target.query("SELECT pg_terminate_backend($1) stopped", [owner.pid])).rows[0].stopped,
      true,
    );
    phase = "waiting for child exit after ownership loss";
    const stopped = await waitFor(() =>
      supervisor.errors
        .split("\n")
        .find((line) => line.includes('"kind":"collector_supervised_child_stopped"')),
    );
    const stoppedChild = JSON.parse(stopped);
    assert.equal(stoppedChild.workerExited, true);
    assert.throws(() => process.kill(stoppedChild.workerPid, 0), /ESRCH/);
    await waitFor(() => supervisor.errors.split(unavailable).length >= 3);
    assert.equal((await store.view(job.id)).request_count, 0);
    blocker.release(true);
    blocker = undefined;
    stopCluster(cluster);
    running = false;
    assert.equal(supervisor.child.exitCode, null);
    startCluster(cluster);
    running = true;
    phase = "waiting for original supervisor to recover";
    await waitFor(() => supervisor.output.split(recovered).length >= 3, 12000);
    await waitFor(async () => (await store.view(job.id)).status === "completed", 8000);
    const persisted = (
      await target.query(
        `SELECT (SELECT count(*) FROM collector_pages WHERE job_id=$1)::int pages,
                (SELECT count(*) FROM listing_images WHERE source_id=$2 AND state='available')::int images`,
        [job.id, job.source_id],
      )
    ).rows[0];
    assert.deepEqual(persisted, { pages: 2, images: 8 });
    assert.equal(supervisor.child.kill("SIGTERM"), true);
    assert.deepEqual(await supervisor.exited, { code: 0, signal: null });
  } catch (error) {
    throw new Error(`${phase}: ${supervisor?.errors}\n${supervisor?.output.slice(-2000)}`, { cause: error });
  } finally {
    if (supervisor?.child.exitCode === null && supervisor.child.signalCode === null) {
      supervisor.child.kill("SIGKILL");
      await supervisor.exited;
    }
    if (running) stopCluster(cluster);
    blocker?.release();
    await target.end();
    if (testSocket === undefined) delete process.env.SOLDBENCH_TEST_SOCKET;
    else process.env.SOLDBENCH_TEST_SOCKET = testSocket;
  }
});

test("watchdog kills a stalled child after a bounded grace interval without consuming a queued job", async () => {
  const directory = await root(),
    prepared = await preparedDemo(directory),
    blocker = await db.connect();
  await blocker.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
  try {
    const run = start(
        "scripts/collector-launcher.mjs",
        [`--fixture=${prepared.artifactPath}`, "--max-ms=300", "--grace-ms=100"],
        { COLLECTOR_DEMO_DIR: directory },
      ),
      result = await run.exited;
    assert.equal(result.code, 124, run.errors);
    const report = JSON.parse(run.output);
    assert.equal(report.timedOut, true);
    assert.equal(report.workerExited, true);
    assert.ok(report.elapsedMs < 3000);
    assert.throws(() => process.kill(report.workerPid, 0), /ESRCH/);
    assert.equal((await new CollectorStore(db).view(prepared.jobId)).status, "queued");
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(hashtext('soldbench:migrations'))");
    blocker.release();
  }
});

test("parent termination propagates to a stalled child and waits for child exit", async () => {
  const directory = await root(),
    prepared = await preparedDemo(directory),
    blocker = await db.connect();
  await blocker.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
  try {
    const run = start(
      "scripts/collector-launcher.mjs",
      [`--fixture=${prepared.artifactPath}`, "--max-ms=5000", "--grace-ms=100"],
      { COLLECTOR_DEMO_DIR: directory },
    );
    await waitFor(
      async () =>
        (
          await db.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND application_name='soldbench' AND query LIKE '%soldbench:migrations%' AND pid<>pg_backend_pid()",
          )
        ).rowCount > 0,
    );
    run.child.kill("SIGTERM");
    assert.equal((await run.exited).code, 143, run.errors);
    const report = JSON.parse(run.output);
    assert.equal(report.interrupted, "SIGTERM");
    assert.equal(report.workerExited, true);
    assert.throws(() => process.kill(report.workerPid, 0), /ESRCH/);
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(hashtext('soldbench:migrations'))");
    blocker.release();
  }
});

test("abrupt launcher exit stops a detached child without advancing its queued job", async () => {
  const directory = await root();
  const prepared = await preparedDemo(directory);
  const blocker = await db.connect();
  await blocker.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
  try {
    const run = start(
      "scripts/collector-launcher.mjs",
      [`--fixture=${prepared.artifactPath}`, "--max-ms=30000"],
      { COLLECTOR_DEMO_DIR: directory },
    );
    await waitFor(
      async () =>
        (
          await db.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND datname=current_database() AND query LIKE '%soldbench:migrations%'",
          )
        ).rowCount,
    );
    const processTable = () =>
      execFileSync("ps", ["-ax", "-o", "pid=,ppid=,stat="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/));
    const [workerPid] = processTable().find(([, parent]) => parent === String(run.child.pid));
    assert.equal(run.child.kill("SIGKILL"), true);
    assert.deepEqual(await run.exited, { code: null, signal: "SIGKILL" });
    await waitFor(() => {
      const row = processTable().find(([pid]) => pid === workerPid);
      return !row || row[2].startsWith("Z");
    });
    const current = await new CollectorStore(db).view(prepared.jobId);
    assert.equal(current.status, "queued");
    assert.equal(current.request_count, 0);
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(hashtext('soldbench:migrations'))");
    blocker.release();
  }
});

test("killing an active collector preserves a live API and recovery conservatively settles unknown dispatch budget", async () => {
  const source = await provisionFixtureSource(db, fixed),
    store = new CollectorStore(db, () => fixed),
    queryHash = digest("isolation-query"),
    jobId = await store.enqueue({ ...source, queryHash, runKey: "isolation", asOf: fixed }),
    directory = await root(),
    frames = new Map();
  for (let i = 0; i < 3; i++)
    frames.set(`page:${i ? `page-${i}` : "start"}`, [
      fixtureResponse({
        schema: "soldbench.synthetic-page.v1",
        synthetic: true,
        sourceId: source.sourceId,
        queryHash,
        cursor: i ? `page-${i}` : "start",
        nextCursor: i === 2 ? null : `page-${i + 1}`,
        asOf: fixed,
        empty: false,
        records: [
          {
            listingId: `listing-${i}`,
            title: `Synthetic ${i}`,
            candidate: {
              sourceId: source.sourceId,
              eventKey: `event-${i}`,
              identityVerified: true,
              comparable: true,
              priceStatus: "verified_actual",
              format: "fixed_price",
              currency: "USD",
              itemCents: 1000,
              shippingCents: 0,
              shippingStatus: "verified_free_shipping",
              time: { precision: "instant", value: "2026-11-15T12:00:00Z" },
            },
          },
        ],
      }),
    ]);
  const artifact = createFixtureArtifact(
      { sourceId: source.sourceId, jobId, queryHash, asOf: fixed },
      frames,
    ),
    path = join(directory, "artifact.json");
  await writeFile(path, JSON.stringify(artifact));
  const api = start("tests/fixtures/process/api-server.mjs");
  const ready = await waitFor(() => {
      try {
        return JSON.parse(api.output);
      } catch {
        return null;
      }
    }),
    base = `http://127.0.0.1:${ready.port}`;
  const healthy = async () => {
    for (const endpoint of ["/health", "/ready"]) {
      const r = await fetch(base + endpoint, { signal: AbortSignal.timeout(2000) });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).data_mode, "offline_fixture");
    }
    const r = await fetch(`${base}/v1/sold?q=synthetic`, { signal: AbortSignal.timeout(2000) });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, "unauthenticated");
  };
  await healthy();
  const blocker = await db.connect();
  await blocker.query("SELECT pg_advisory_lock(789003)");
  await db.query(
    "CREATE FUNCTION collector_isolation_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='page' AND NEW.state='settled' AND EXISTS(SELECT 1 FROM collector_pages p WHERE p.job_id=NEW.job_id) THEN PERFORM pg_advisory_xact_lock(789003); END IF; RETURN NEW; END $$",
  );
  await db.query(
    "CREATE TRIGGER collector_isolation_block BEFORE UPDATE ON collector_dispatches FOR EACH ROW EXECUTE FUNCTION collector_isolation_block()",
  );
  try {
    const collector = start("scripts/collector-worker.mjs", [`--fixture=${path}`, `--clock=${fixed}`], {
      COLLECTOR_DEMO_DIR: directory,
    });
    await waitFor(async () => {
      const job = await store.view(jobId);
      return job.page_count === 1 && job.bytes_reserved !== "0";
    });
    await healthy();
    collector.child.kill("SIGKILL");
    assert.equal((await collector.exited).signal, "SIGKILL");
    await healthy();
    assert.equal(
      (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [source.sourceId])).rowCount,
      0,
    );
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(789003)");
    blocker.release();
    await db.query("DROP TRIGGER collector_isolation_block ON collector_dispatches");
    await db.query("DROP FUNCTION collector_isolation_block()");
  }
  const resumed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-worker.mjs",
        `--fixture=${path}`,
        "--clock=2026-11-16T12:01:01Z",
      ],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: directory } },
    ),
  );
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.pageCount, 3);
  assert.equal(resumed.requestsReserved, 4);
  const run = (
    await db.query("SELECT bytes_unconfirmed FROM collector_runs WHERE id=$1", [
      (await store.view(jobId)).collector_run_id,
    ])
  ).rows[0];
  assert.equal(run.bytes_unconfirmed, String(1024 * 1024));
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM sale_events WHERE source_id=$1", [source.sourceId])).rows[0]
      .n,
    3,
  );
  await healthy();
  api.child.kill("SIGTERM");
  assert.equal((await api.exited).code, 0);
});
