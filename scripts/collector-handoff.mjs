import { resolve } from "node:path";
import {
  CollectorStore,
  createFixtureArtifact,
  fixtureResponse,
  loadFixtureArtifact,
} from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { fixtureJobId, readFixtureTemplate } from "./collector-fixture-file.mjs";
import { intakeFixture } from "./collector-intake.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const selection = `SELECT j.id "jobId",j.query_hash "queryHash",j.as_of "asOf",j.expires_at "expiresAt",j.status,
    o.plan_id "planId",o.id "occurrenceId",r.parser_profile_hash "profileHash",r.fixture_artifact_hash "artifactHash",
    CASE WHEN j.status='completed' THEN 'primary_image_retry' ELSE 'pages' END "workKind"
  FROM collector_jobs j
  JOIN collector_runs r ON (r.id,r.source_id)=(j.collector_run_id,j.source_id)
  JOIN collector_refresh_occurrences o ON o.source_id=j.source_id AND j.run_key='refresh:'||o.id::text
  JOIN sources s ON s.id=j.source_id
  JOIN source_clearances x ON x.id=s.source_clearance_id
  WHERE j.source_id=$1 AND s.status='active' AND s.access_method='offline_fixture'
    AND x.provider='synthetic_fixture' AND x.status IN ('draft','reviewed','active')
    AND (x.effective_at IS NULL OR x.effective_at<=now()) AND (x.expires_at IS NULL OR x.expires_at>now())
    AND j.permission_epoch=s.permission_epoch
    AND (
      (j.expires_at>now() AND j.status IN ('queued','retry','running'))
      OR (j.status='completed' AND r.fixture_artifact_hash IS NOT NULL AND EXISTS(
        SELECT 1 FROM collector_image_jobs t
        JOIN listing_images i ON i.id=t.image_id AND i.source_id=t.source_id
        JOIN collector_pages p ON p.observation_id=i.observation_id AND p.source_id=i.source_id
        JOIN source_observations e ON e.id=i.observation_id AND e.source_id=i.source_id
        WHERE t.parent_job_id=j.id AND p.job_id=j.id AND t.source_id=j.source_id
          AND t.status IN ('retry','running') AND t.expires_at>now() AND t.attempts<3
          AND i.state='pending' AND i.permission_epoch=s.permission_epoch AND e.retention_until>now()
      ))
    )`;

const jsonSchema = "soldbench.collector-json-responses.v1";
const htmlSchema = "soldbench.collector-html-responses.v1";

function decodeBytes(encoded, reason) {
  if (typeof encoded !== "string") throw new Error(reason);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) throw new Error(reason);
  return bytes;
}

function jsonPage(page, binding) {
  if (!Array.isArray(page.records)) throw new Error("invalid_fixture_template");
  const records = page.records.map((row) => {
    if (
      !row?.candidate ||
      (row.candidate.sourceId !== undefined && row.candidate.sourceId !== binding.sourceId)
    )
      throw new Error("fixture_template_candidate_source_mismatch");
    return { ...row, candidate: { ...row.candidate, sourceId: binding.sourceId } };
  });
  return {
    records,
    nextCursor: page.nextCursor,
    response: fixtureResponse({
      schema: "soldbench.synthetic-page.v1",
      synthetic: true,
      sourceId: binding.sourceId,
      queryHash: binding.queryHash,
      asOf: binding.asOf,
      cursor: binding.cursor,
      nextCursor: page.nextCursor,
      records,
      empty: records.length === 0,
      ...(page.sourceReported !== undefined && { sourceReported: page.sourceReported }),
    }),
  };
}

function htmlPage(page, binding, store) {
  const bytes = decodeBytes(page.bytesBase64, "fixture_template_html_page_invalid");
  const parsed = store.parsePage(bytes, binding);
  return {
    records: parsed.records,
    nextCursor: parsed.nextCursor,
    response: { status: 200, contentType: "text/html; charset=utf-8", bytes },
  };
}

function packageTemplate(input, binding, htmlStore) {
  if (
    input?.schema !== (htmlStore ? htmlSchema : jsonSchema) ||
    input.synthetic !== true ||
    !Array.isArray(input.pages) ||
    input.pages.length < 1 ||
    input.pages.length > 200 ||
    (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 800))
  )
    throw new Error("invalid_fixture_template");
  const frames = new Map();
  const referencedImages = new Set();
  let expectedCursor = "start";
  for (const page of input.pages) {
    if (
      !page ||
      expectedCursor === null ||
      page.cursor !== expectedCursor ||
      frames.has(`page:${page.cursor}`)
    )
      throw new Error("fixture_template_page_chain_invalid");
    const pageBinding = {
      sourceId: binding.sourceId,
      queryHash: binding.queryHash,
      asOf: binding.asOf,
      cursor: page.cursor,
    };
    const { records, nextCursor, response } = htmlStore
      ? htmlPage(page, pageBinding, htmlStore)
      : jsonPage(page, pageBinding);
    for (const row of records) {
      if (row.primaryImage) referencedImages.add(row.primaryImage.url);
    }
    frames.set(`page:${page.cursor}`, [response]);
    expectedCursor = nextCursor;
  }
  if (expectedCursor !== null) throw new Error("fixture_template_page_chain_invalid");
  for (const image of input.images ?? []) {
    if (
      !referencedImages.delete(image?.url) ||
      typeof image.contentType !== "string" ||
      !image.contentType.startsWith("image/")
    )
      throw new Error("fixture_template_image_invalid");
    const bytes = decodeBytes(image.bytesBase64, "fixture_template_image_invalid");
    frames.set(`image:${image.url}`, [{ status: 200, contentType: image.contentType, bytes }]);
  }
  if (referencedImages.size) throw new Error("fixture_template_image_missing");
  return loadFixtureArtifact(
    Buffer.from(
      JSON.stringify(
        createFixtureArtifact(
          htmlStore ? { ...binding, htmlProfile: htmlStore.htmlProfile } : binding,
          frames,
        ),
      ),
    ),
  );
}

let db;
try {
  const options = new Map();
  for (const value of process.argv.slice(2)) {
    const entry = /^--(action|source|job|template|spool|limit|after)=(.+)$/.exec(value);
    if (!entry || options.has(entry[1])) throw new Error("invalid_collector_handoff_argument");
    options.set(entry[1], entry[2]);
  }
  const action = options.get("action") ?? "list";
  const sourceId = options.get("source");
  const jobId = options.get("job");
  const after = options.get("after") ?? null;
  const limit = options.get("limit") ?? "50";
  if (
    !fixtureJobId.test(sourceId ?? "") ||
    !["list", "package"].includes(action) ||
    (action === "list" &&
      (jobId ||
        options.has("template") ||
        options.has("spool") ||
        !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit) ||
        (after !== null && !fixtureJobId.test(after)))) ||
    (action === "package" &&
      (!fixtureJobId.test(jobId ?? "") || !options.has("template") || options.has("limit") || after !== null))
  )
    throw new Error("invalid_collector_handoff_argument");
  const config = loadConfig(process.env);
  const url = config.databaseUrl ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  db = database(url);
  await prepareDatabase(db, "verify");
  const shared = { mode: "offline_fixture", externalNetworkRequests: 0, onlineVerified: false, sourceId };
  if (action === "list") {
    const size = Number(limit);
    const { rows } = await db.query(`${selection} AND ($2::uuid IS NULL OR j.id>$2) ORDER BY j.id LIMIT $3`, [
      sourceId,
      after,
      size + 1,
    ]);
    const jobs = rows.slice(0, size);
    console.log(
      JSON.stringify({ ...shared, jobs, nextAfter: rows.length > size ? jobs.at(-1).jobId : null }),
    );
  } else {
    const job = (await db.query(`${selection} AND j.id=$2`, [sourceId, jobId])).rows[0];
    if (!job) throw new Error("collector_handoff_job_unavailable");
    const template = await readFixtureTemplate(resolve(options.get("template")));
    const html = template?.schema === htmlSchema;
    if (job.profileHash && !html) throw new Error("collector_handoff_requires_original_html_response");
    const htmlStore = html ? new CollectorStore(db, undefined, { htmlProfile: template.profile }) : undefined;
    if (htmlStore && (!htmlStore.htmlProfile || htmlStore.profileHash !== job.profileHash))
      throw new Error("collector_handoff_profile_mismatch");
    const loaded = packageTemplate(
      template,
      {
        sourceId,
        jobId,
        queryHash: job.queryHash,
        asOf: job.asOf.toISOString(),
      },
      htmlStore,
    );
    await intakeFixture(
      db,
      resolve(options.get("spool") ?? process.env.COLLECTOR_DEMO_DIR ?? ".local"),
      sourceId,
      loaded,
    );
    console.log(JSON.stringify({ ...shared, jobId, artifactHash: loaded.hash }));
  }
} catch (error) {
  const code =
    typeof error?.message === "string" && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "collector_handoff_failed";
  console.error(JSON.stringify({ mode: "offline_fixture", error: code }));
  process.exitCode = 1;
} finally {
  await db?.end();
}
