import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditEbayUsHtmlPage,
  buildEbayUsSoldSearchUrl,
  CollectorStore,
  createEbayUsSoldCardHtmlProfile,
  createEbayUsSoldSearchHtmlProfile,
  createFixtureArtifact,
  detectEbayUsSoldHtmlProfile,
  digest,
  EbayUsBrowserTransport,
  EbayUsHttpTransport,
  hasEbayDetailAccessBlock,
  loadFixtureArtifact,
  OfflineCollectorWorker,
  parseEbayUsItemDetailHtml,
  provisionFixtureSource,
} from "@soldbench/collector";
import { canonicalJson, collectionQueryHash, evaluate, normalizeQuery } from "@soldbench/core";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { fixtureJobId, publishCollectorFile, readBoundedFile } from "./collector-fixture-file.mjs";
import { intakeFixture } from "./collector-intake.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const imageMimeTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function parseCliArgs(argv) {
  const options = new Map();
  const pages = [];
  for (const raw of argv) {
    const match = /^--([a-z][a-z0-9_-]*)=(.+)$/.exec(raw);
    if (!match) throw new Error("invalid_ebay_intake_argument");
    const [, key, val] = match;
    if (key === "page") {
      if (pages.length >= 20) throw new Error("ebay_intake_page_limit_exceeded");
      pages.push(val);
      continue;
    }
    if (options.has(key)) throw new Error("invalid_ebay_intake_argument");
    options.set(key, val);
  }
  const allowedKeys = new Set([
    "mode",
    "q",
    "category",
    "brand",
    "model",
    "condition",
    "sale-format",
    "min-price-cents",
    "max-price-cents",
    "window-days",
    "price-basis",
    "layout",
    "images-dir",
    "details-dir",
    "source",
    "config",
    "spool",
    "as-of",
    "max-pages",
    "out",
    "allow-live-fetch",
    "ingest",
    "fetch-images",
    "fetch-details",
    "max-details",
    "transport",
    "wait-for-selector",
    "origin",
    "image-origin-override",
    "allow-loopback-test-origin",
  ]);
  for (const key of options.keys()) {
    if (!allowedKeys.has(key) && !/^attr-[a-z][a-z0-9_-]*$/.test(key)) {
      throw new Error("invalid_ebay_intake_argument");
    }
  }
  return { options, pages };
}

function buildNormalizedQuery(options) {
  const q = options.get("q");
  if (!q) throw new Error("ebay_intake_query_required");
  const params = new URLSearchParams({ q, marketplace: "ebay_us" });
  const mappings = [
    ["category", "category"],
    ["brand", "brand"],
    ["model", "model"],
    ["condition", "condition"],
    ["sale-format", "sale_format"],
    ["min-price-cents", "min_price_cents"],
    ["max-price-cents", "max_price_cents"],
    ["window-days", "window_days"],
    ["price-basis", "price_basis"],
  ];
  for (const [cliKey, queryKey] of mappings) {
    const v = options.get(cliKey);
    if (v !== undefined) params.set(queryKey, v);
  }
  for (const [cliKey, v] of options.entries()) {
    if (cliKey.startsWith("attr-")) {
      params.set(`attr_${cliKey.slice(5).replaceAll("-", "_")}`, v);
    }
  }
  const query = normalizeQuery(params);
  return { query, queryHash: collectionQueryHash(query) };
}

function selectProfile(layout, firstPageBytes, overrides = {}) {
  if (layout === "s-item") return createEbayUsSoldSearchHtmlProfile(overrides);
  if (layout === "s-card") return createEbayUsSoldCardHtmlProfile(overrides);
  if (layout === "auto") return detectEbayUsSoldHtmlProfile(firstPageBytes, overrides);
  throw new Error("invalid_ebay_intake_layout");
}

function parseChainAndAudit(rawPages, bindingBase, profile) {
  const frames = new Map();
  const pageAudits = [];
  const candidates = [];
  const listingIds = [];
  const seenListingIds = new Set();
  const cursors = [];
  let cursor = "start";
  let lastNextCursor = null;

  for (let i = 0; i < rawPages.length; i++) {
    const raw = rawPages[i];
    const binding = { ...bindingBase, cursor };
    const audit = auditEbayUsHtmlPage(raw, binding, profile);
    if (!audit.ok) {
      return {
        ok: false,
        failedPageIndex: i,
        cursor,
        audit,
      };
    }
    frames.set(`page:${cursor}`, [{ status: 200, contentType: "text/html; charset=utf-8", bytes: raw }]);
    cursors.push(cursor);
    pageAudits.push({ pageIndex: i, cursor, ...audit.summary });
    for (const row of audit.page.records) {
      candidates.push(row.candidate);
      if (/^\d{6,19}$/.test(row.listingId) && !seenListingIds.has(row.listingId)) {
        seenListingIds.add(row.listingId);
        listingIds.push(row.listingId);
      }
    }
    lastNextCursor = audit.page.nextCursor;
    if (i < rawPages.length - 1) {
      if (!lastNextCursor) throw new Error("ebay_intake_pagination_ended_early");
      cursor = lastNextCursor;
    }
  }

  return {
    ok: true,
    frames,
    cursors,
    listingIds,
    pageAudits,
    candidates,
    lastNextCursor,
  };
}

async function attachLocalImages(imagesDir, pageAuditsFrames, profile, bindingBase) {
  const resolvedDir = resolve(imagesDir);
  if (!lstatSync(resolvedDir).isDirectory()) throw new Error("ebay_intake_images_not_directory");
  const entries = await readdir(resolvedDir, { withFileTypes: true });
  const byStem = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    const mime = imageMimeTypes[ext];
    if (!mime) continue;
    const stem = entry.name.slice(0, -ext.length);
    byStem.set(stem, { file: join(resolvedDir, entry.name), mime });
  }
  const indexEntry = entries.find((e) => e.isFile() && e.name === "index.json");
  let indexMap = {};
  if (indexEntry) {
    const rawIndex = await readBoundedFile(
      join(resolvedDir, "index.json"),
      512 * 1024,
      "ebay_intake_images_index_invalid",
      "ebay_intake_images_index_changed",
    );
    indexMap = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawIndex));
  }
  let attached = 0;
  for (const [key, responses] of [...pageAuditsFrames.entries()]) {
    if (!key.startsWith("page:")) continue;
    const cursor = key.slice(5);
    const audit = auditEbayUsHtmlPage(responses[0].bytes, { ...bindingBase, cursor }, profile);
    if (!audit.ok) continue;
    for (const row of audit.page.records) {
      const url = row.primaryImage?.url;
      if (!url || pageAuditsFrames.has(`image:${url}`)) continue;
      const mapped = typeof indexMap[url] === "string" ? indexMap[url] : null;
      let chosen = null;
      if (mapped && !mapped.includes("/") && !mapped.includes("\\") && !mapped.includes("..")) {
        const mime = imageMimeTypes[extname(mapped).toLowerCase()];
        if (mime) chosen = { file: join(resolvedDir, mapped), mime };
      }
      chosen ??= byStem.get(row.listingId) ?? byStem.get(digest(url));
      if (!chosen) continue;
      const bytes = await readBoundedFile(
        chosen.file,
        5 * 1024 * 1024,
        "ebay_intake_image_too_large",
        "ebay_intake_image_changed",
      );
      pageAuditsFrames.set(`image:${url}`, [{ status: 200, contentType: chosen.mime, bytes }]);
      attached++;
    }
  }
  return attached;
}

async function loadLocalDetails(detailsDir, listingIds, profile) {
  const resolvedDir = resolve(detailsDir);
  if (!lstatSync(resolvedDir).isDirectory()) throw new Error("ebay_intake_details_not_directory");
  const details = new Map();
  let blocked = 0;
  let errors = 0;
  for (const listingId of listingIds) {
    const filePath = join(resolvedDir, `${listingId}.html`);
    const exists = lstatSync(filePath, { throwIfNoEntry: false });
    if (!exists?.isFile()) continue;
    const raw = await readBoundedFile(
      filePath,
      4 * 1024 * 1024,
      "html_page_too_large",
      "ebay_intake_file_changed",
    );
    if (hasEbayDetailAccessBlock(raw)) {
      blocked++;
      continue;
    }
    try {
      const detail = parseEbayUsItemDetailHtml(raw, {
        listingId,
        listingHosts: profile.listingHosts,
        imageHosts: profile.imageHosts,
      });
      details.set(listingId, detail);
    } catch {
      errors++;
    }
  }
  return { details, blocked, errors };
}

async function resolveIngestSource(db, options, asOf) {
  const sourceArg = options.get("source");
  const configArg = options.get("config");
  if (!sourceArg) {
    if (configArg) throw new Error("invalid_ebay_intake_argument");
    return await provisionFixtureSource(db, asOf, { searchSummaries: true });
  }
  if (!fixtureJobId.test(sourceArg)) throw new Error("invalid_ebay_intake_argument");
  if (configArg) {
    if (!fixtureJobId.test(configArg)) throw new Error("invalid_ebay_intake_argument");
    return { sourceId: sourceArg, configId: configArg };
  }
  const row = (
    await db.query(
      "SELECT id FROM collector_configs WHERE source_id=$1 AND enabled=true ORDER BY created_at DESC LIMIT 1",
      [sourceArg],
    )
  ).rows[0];
  if (!row?.id) throw new Error("collector_config_missing");
  return { sourceId: sourceArg, configId: row.id };
}

async function ingestRawPages({
  db,
  config,
  options,
  query,
  queryHash,
  profile,
  rawPages,
  extraImageFrames,
  extraDetails = new Map(),
}) {
  const asOfArg = options.get("as-of");
  const asOf = asOfArg ?? (await db.query("SELECT clock_timestamp() t")).rows[0].t.toISOString();
  const source = await resolveIngestSource(db, options, asOf);
  const store = new CollectorStore(db, asOfArg ? () => asOf : undefined, { htmlProfile: profile });
  const parsed = parseChainAndAudit(rawPages, { sourceId: source.sourceId, queryHash, asOf }, profile);
  if (!parsed.ok) {
    return {
      ok: false,
      mode: "ingest",
      sourceId: source.sourceId,
      query,
      queryHash,
      profileId: parsed.audit.profileId,
      profileHash: parsed.audit.profileHash,
      failedPageIndex: parsed.failedPageIndex,
      cursor: parsed.cursor,
      kind: parsed.audit.kind,
      error: parsed.audit.error,
    };
  }
  for (const [imgKey, imgResponses] of extraImageFrames) parsed.frames.set(imgKey, imgResponses);
  let attachedImages = extraImageFrames.size;
  if (options.has("images-dir")) {
    attachedImages += await attachLocalImages(options.get("images-dir"), parsed.frames, profile, {
      sourceId: source.sourceId,
      queryHash,
      asOf,
    });
  }
  const combinedDetails = new Map(extraDetails);
  let detailBlocked = 0;
  let detailErrors = 0;
  if (options.has("details-dir")) {
    const localDetails = await loadLocalDetails(options.get("details-dir"), parsed.listingIds, profile);
    detailBlocked += localDetails.blocked;
    detailErrors += localDetails.errors;
    for (const [id, detail] of localDetails.details) combinedDetails.set(id, detail);
  }
  const runKey = `ebay-intake:${randomUUID()}`;
  const jobId = await store.enqueue({
    sourceId: source.sourceId,
    configId: source.configId,
    queryHash,
    runKey,
    asOf,
  });
  const artifact = createFixtureArtifact(
    {
      sourceId: source.sourceId,
      jobId,
      queryHash,
      asOf,
      htmlProfile: profile,
    },
    parsed.frames,
  );
  const loaded = loadFixtureArtifact(Buffer.from(JSON.stringify(artifact)));
  const spool = resolve(options.get("spool") ?? process.env.COLLECTOR_DEMO_DIR ?? ".local");
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  const artifactPath = await intakeFixture(
    db,
    spool,
    source.sourceId,
    loaded,
    asOfArg ? () => asOf : undefined,
  );
  const worker = new OfflineCollectorWorker(
    store,
    loaded.transport,
    new PrivateMediaStore(resolve(config.mediaRoot)),
  );
  const runResult = await worker.runOne(source.sourceId, {
    jobId,
    maxPages: rawPages.length,
    completeAtPageLimit: true,
  });
  let enrichedDetails = 0;
  if ((runResult?.status ?? (await store.view(jobId)).status) === "completed" && combinedDetails.size) {
    for (const [listingId, detail] of combinedDetails) {
      const updated = await store.enrichRecordEvidence({
        sourceId: source.sourceId,
        jobId,
        listingId,
        detail,
      });
      if (updated.updated > 0) enrichedDetails++;
    }
  }
  const job = await store.view(jobId);
  const counts = (
    await db.query(
      "SELECT (SELECT count(*)::int FROM listing_record_evidence WHERE source_id=$1 AND observation_id IN (SELECT observation_id FROM collector_pages WHERE job_id=$2)) AS records, (SELECT count(*)::int FROM listing_images WHERE source_id=$1 AND state='available' AND observation_id IN (SELECT observation_id FROM collector_pages WHERE job_id=$2)) AS images",
      [source.sourceId, jobId],
    )
  ).rows[0];
  const stats =
    job.status === "completed"
      ? evaluate(await store.candidates(jobId), {
          sourceId: source.sourceId,
          asOf,
          days: query.window_days,
          basis: query.price_basis,
          limit: query.limit,
        }).stats
      : null;
  return {
    ok: job.status === "completed",
    mode: "ingest",
    sourceId: source.sourceId,
    configId: source.configId,
    jobId,
    query,
    queryHash,
    ebaySearchUrl: buildEbayUsSoldSearchUrl(query).href,
    profileId: profile.id,
    profileHash: store.profileHash,
    status: runResult?.status ?? job.status,
    pageCount: job.page_count,
    truncatedPagination: parsed.lastNextCursor !== null,
    nextCursor: parsed.lastNextCursor,
    recordEvidenceCount: counts.records,
    enrichedDetails,
    detailBlocked,
    detailErrors,
    attachedImages,
    availablePrimaryImages: counts.images,
    stats,
    pages: parsed.pageAudits,
    artifactPath,
    externalNetworkRequests: 0,
    onlineVerified: false,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const { options, pages } = parseCliArgs(process.argv.slice(2));
    const mode = options.get("mode") ?? "inspect";
    if (!["inspect", "ingest", "fetch"].includes(mode)) throw new Error("invalid_ebay_intake_argument");
    const layout = options.get("layout") ?? "auto";
    const { query, queryHash } = buildNormalizedQuery(options);

    if (mode === "inspect") {
      if (!pages.length) throw new Error("ebay_intake_pages_required");
      const rawPages = [];
      for (const p of pages) {
        rawPages.push(
          await readBoundedFile(
            resolve(p),
            4 * 1024 * 1024,
            "html_page_too_large",
            "ebay_intake_file_changed",
          ),
        );
      }
      const profile = selectProfile(layout, rawPages[0]);
      const sourceId = randomUUID();
      const asOf = options.get("as-of") ?? new Date().toISOString();
      const result = parseChainAndAudit(rawPages, { sourceId, queryHash, asOf }, profile);
      if (!result.ok) {
        console.error(
          JSON.stringify({
            ok: false,
            mode: "inspect",
            query,
            queryHash,
            ebaySearchUrl: buildEbayUsSoldSearchUrl(query).href,
            profileId: result.audit.profileId,
            profileHash: result.audit.profileHash,
            failedPageIndex: result.failedPageIndex,
            cursor: result.cursor,
            kind: result.audit.kind,
            error: result.audit.error,
            externalNetworkRequests: 0,
          }),
        );
        process.exitCode = 1;
      } else {
        const localDetails = options.has("details-dir")
          ? await loadLocalDetails(options.get("details-dir"), result.listingIds, profile)
          : { details: new Map(), blocked: 0, errors: 0 };
        const evaluation = evaluate(result.candidates, {
          sourceId,
          asOf,
          days: query.window_days,
          basis: query.price_basis,
          limit: query.limit,
        });
        console.log(
          JSON.stringify({
            ok: true,
            mode: "inspect",
            query,
            queryHash,
            ebaySearchUrl: buildEbayUsSoldSearchUrl(query).href,
            profileId: profile.id,
            profileHash: digest(canonicalJson(profile)),
            pageCount: result.pageAudits.length,
            truncatedPagination: result.lastNextCursor !== null,
            nextCursor: result.lastNextCursor,
            inspectedDetails: localDetails.details.size,
            detailBlocked: localDetails.blocked,
            detailErrors: localDetails.errors,
            pages: result.pageAudits,
            stats: evaluation.stats,
            externalNetworkRequests: 0,
          }),
        );
      }
    } else if (mode === "ingest") {
      if (!pages.length) throw new Error("ebay_intake_pages_required");
      const rawPages = [];
      for (const p of pages) {
        rawPages.push(
          await readBoundedFile(
            resolve(p),
            4 * 1024 * 1024,
            "html_page_too_large",
            "ebay_intake_file_changed",
          ),
        );
      }
      const config = loadConfig(process.env);
      const url = config.databaseUrl ?? localDatabaseUrl();
      assertLocalDatabaseUrl(url, [
        resolve(".local/postgres/socket"),
        ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
      ]);
      db = database(url);
      await prepareDatabase(db, config.databaseStartup);
      const profile = selectProfile(layout, rawPages[0]);
      const report = await ingestRawPages({
        db,
        config,
        options,
        query,
        queryHash,
        profile,
        rawPages,
        extraImageFrames: new Map(),
      });
      if (!report.ok) {
        console.error(JSON.stringify(report));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify(report));
      }
    } else {
      if (options.get("allow-live-fetch") !== "true") throw new Error("live_fetch_explicit_opt_in_required");
      const outDirRaw = options.get("out");
      if (!outDirRaw) throw new Error("ebay_fetch_output_dir_required");
      const maxPagesRaw = options.get("max-pages") ?? "1";
      if (!/^[1-5]$/.test(maxPagesRaw)) throw new Error("invalid_ebay_max_pages");
      const maxPages = Number(maxPagesRaw);
      const maxDetailsRaw = options.get("max-details") ?? "5";
      if (!/^(?:[1-9]|1\d|20)$/.test(maxDetailsRaw)) throw new Error("invalid_ebay_max_details");
      const maxDetails = Number(maxDetailsRaw);
      const transportKind = options.get("transport") ?? "http";
      if (!["http", "browser"].includes(transportKind)) throw new Error("invalid_ebay_transport");
      const allowLoopback = options.get("allow-loopback-test-origin") === "true";
      const origin = options.get("origin");
      const imageOriginOverride = options.get("image-origin-override");
      const waitForSelector = options.get("wait-for-selector");
      const outDir = resolve(outDirRaw);
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      const httpTransport = new EbayUsHttpTransport({
        query,
        ...(origin ? { origin } : {}),
        ...(allowLoopback ? { allowLoopbackTestOrigin: true, minIntervalMs: 0 } : {}),
        ...(imageOriginOverride ? { imageOriginOverride } : {}),
      });
      const pageTransport =
        transportKind === "browser"
          ? new EbayUsBrowserTransport({
              query,
              ...(origin ? { origin } : {}),
              ...(allowLoopback ? { allowLoopbackTestOrigin: true, minIntervalMs: 0 } : {}),
              ...(waitForSelector ? { waitForSelector } : {}),
            })
          : httpTransport;
      const asOf = options.get("as-of") ?? new Date().toISOString();
      const rawPages = [];
      const fetchedUrls = [];
      const fetchedImages = new Map();
      const fetchedDetails = new Map();
      const detailListingIds = [];
      const seenDetailIds = new Set();
      const imageUrls = new Set();
      let cursor = "start";
      let chosenProfile;
      let externalRequests = 0;

      for (let i = 0; i < maxPages; i++) {
        const res = await pageTransport.read(`page:${cursor}`);
        externalRequests++;
        fetchedUrls.push(buildEbayUsSoldSearchUrl(query, { cursor, origin: pageTransport.origin }).href);
        if (res.status === 401 || res.status === 403) throw new Error("source_access_refused");
        if (res.status !== 200) throw new Error("upstream_unavailable");
        const contentType = res.contentType.split(";")[0]?.trim().toLowerCase();
        if (contentType !== "text/html") throw new Error("page_content_type_invalid");
        chosenProfile ??= selectProfile(layout, res.bytes);
        const filePath = join(outDir, `page-${i + 1}.html`);
        await publishCollectorFile(filePath, res.bytes);
        const audit = auditEbayUsHtmlPage(
          res.bytes,
          { sourceId: randomUUID(), queryHash, cursor, asOf },
          chosenProfile,
        );
        if (!audit.ok) throw new Error(audit.error);
        rawPages.push(res.bytes);
        for (const r of audit.page.records) {
          if (
            options.get("fetch-details") === "true" &&
            detailListingIds.length < maxDetails &&
            /^\d{6,19}$/.test(r.listingId) &&
            !seenDetailIds.has(r.listingId)
          ) {
            seenDetailIds.add(r.listingId);
            detailListingIds.push(r.listingId);
          }
          if (options.get("fetch-images") === "true" && r.primaryImage?.url) {
            imageUrls.add(r.primaryImage.url);
          }
        }
        if (!audit.summary.nextCursor) break;
        cursor = audit.summary.nextCursor;
      }

      if (options.get("fetch-details") === "true" && detailListingIds.length) {
        const detailsOutDir = join(outDir, "details");
        mkdirSync(detailsOutDir, { recursive: true, mode: 0o700 });
        for (const listingId of detailListingIds) {
          const detailRes = await pageTransport.read(`detail:${listingId}`);
          externalRequests++;
          if (detailRes.status === 401 || detailRes.status === 403) throw new Error("source_access_refused");
          if (detailRes.status !== 200) continue;
          if (hasEbayDetailAccessBlock(detailRes.bytes)) throw new Error("source_access_refused");
          const detailPath = join(detailsOutDir, `${listingId}.html`);
          await publishCollectorFile(detailPath, detailRes.bytes);
          const detail = parseEbayUsItemDetailHtml(detailRes.bytes, {
            listingId,
            listingHosts: chosenProfile.listingHosts,
            imageHosts: chosenProfile.imageHosts,
          });
          fetchedDetails.set(listingId, detail);
        }
      }

      if (options.get("fetch-images") === "true") {
        for (const imgUrl of imageUrls) {
          const imgRes = await httpTransport.read(`image:${imgUrl}`);
          externalRequests++;
          if (imgRes.status === 401 || imgRes.status === 403) throw new Error("source_access_refused");
          if (imgRes.status === 200) {
            fetchedImages.set(`image:${imgUrl}`, [
              { status: 200, contentType: imgRes.contentType, bytes: imgRes.bytes },
            ]);
          }
        }
      }

      if (options.get("ingest") === "true") {
        const config = loadConfig(process.env);
        const url = config.databaseUrl ?? localDatabaseUrl();
        assertLocalDatabaseUrl(url, [
          resolve(".local/postgres/socket"),
          ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
        ]);
        db = database(url);
        await prepareDatabase(db, config.databaseStartup);
        const ingestReport = await ingestRawPages({
          db,
          config,
          options,
          query,
          queryHash,
          profile: chosenProfile,
          rawPages,
          extraImageFrames: fetchedImages,
          extraDetails: fetchedDetails,
        });
        const finalReport = {
          ...ingestReport,
          mode: "fetch",
          transport: transportKind,
          fetchedUrls,
          savedPagesDir: outDir,
          fetchedDetails: fetchedDetails.size,
          externalNetworkRequests: externalRequests,
          liveFetch: !allowLoopback,
        };
        if (!finalReport.ok) {
          console.error(JSON.stringify(finalReport));
          process.exitCode = 1;
        } else {
          console.log(JSON.stringify(finalReport));
        }
      } else {
        const inspection = parseChainAndAudit(
          rawPages,
          { sourceId: randomUUID(), queryHash, asOf },
          chosenProfile,
        );
        console.log(
          JSON.stringify({
            ok: inspection.ok,
            mode: "fetch",
            transport: transportKind,
            query,
            queryHash,
            fetchedUrls,
            savedPagesDir: outDir,
            profileId: chosenProfile.id,
            pageCount: rawPages.length,
            fetchedDetails: fetchedDetails.size,
            pages: inspection.ok ? inspection.pageAudits : [],
            externalNetworkRequests: externalRequests,
            liveFetch: !allowLoopback,
          }),
        );
        if (!inspection.ok) process.exitCode = 1;
      }
    }
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "collector_ebay_intake_failed";
    console.error(JSON.stringify({ ok: false, error: reason }));
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
