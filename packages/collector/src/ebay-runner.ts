import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  categoryAttributeNames,
  collectionQueryHash,
  evaluate,
  normalizeQuery,
  type SoldQuery,
} from "@soldbench/core";
import type { Database } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { parseProxyUrl } from "@soldbench/shared";
import { createFixtureArtifact, loadFixtureArtifact } from "./artifact.ts";
import { EbayUsBrowserTransport } from "./ebay-browser-transport.ts";
import { hasEbayDetailAccessBlock, parseEbayUsItemDetailHtml } from "./ebay-detail.ts";
import { EbayUsHttpTransport } from "./ebay-http-transport.ts";
import { auditEbayUsHtmlPage } from "./ebay-us.ts";
import { type FixtureResponse, FixtureTransport } from "./fixture.ts";
import {
  createEbayUsSoldCardHtmlProfile,
  createEbayUsSoldSearchHtmlProfile,
  detectEbayUsSoldHtmlProfile,
  type EbayProfileOverrides,
  type HtmlProfile,
  hasHtmlAccessBlock,
} from "./html.ts";
import { provisionFixtureSource } from "./provision-fixture.ts";
import { CollectorStore } from "./store.ts";
import { OfflineCollectorWorker } from "./worker.ts";

export type EbayCorpusTarget = {
  id: string;
  group: string;
  tier?: string;
  query: SoldQuery;
  queryHash: string;
};

export type EbayCorpusCycleInput = {
  db: Database;
  targets: readonly EbayCorpusTarget[];
  sourceId?: string;
  configId?: string;
  transport?: "http" | "browser" | "auto";
  layout?: "auto" | "s-item" | "s-card";
  maxPages?: number;
  maxDetails?: number;
  fetchImages?: boolean;
  origin?: string;
  imageOriginOverride?: string;
  allowLoopbackTestOrigin?: boolean;
  proxyUrl?: string | null;
  browserExecutablePath?: string;
  waitForSelector?: string;
  minIntervalMs?: number;
  mediaRoot: string;
  spoolDir: string;
  outDir?: string;
  asOf?: string;
  clock?: () => string;
  profileOverrides?: EbayProfileOverrides;
};

export type EbayCorpusTargetOutcome = {
  id: string;
  group: string;
  query: SoldQuery;
  queryHash: string;
  ok: boolean;
  status: string;
  error?: string;
  jobId?: string;
  transportUsed: "http" | "browser";
  browserFallbackUsed: boolean;
  pageCount: number;
  truncatedPagination: boolean;
  recordEvidenceCount: number;
  availablePrimaryImages: number;
  detailsEnqueued: number;
  detailsCompleted: number;
  detailsFailed: number;
  stats: ReturnType<typeof evaluate>["stats"] | null;
};

export type EbayCorpusCycleReport = {
  schema: "soldbench.ebay-daemon-cycle.v1";
  mode: "offline_fixture";
  onlineVerified: boolean;
  sourceId: string;
  configId: string;
  transportMode: "http" | "browser" | "auto";
  asOf: string;
  startedAt: string;
  finishedAt: string;
  targetsAttempted: number;
  completedTargets: number;
  failedTargets: number;
  circuitTripped: boolean;
  stopReason: string | null;
  pagesCollected: number;
  recordsObserved: number;
  imagesStored: number;
  detailsEnqueued: number;
  detailsCompleted: number;
  detailsFailed: number;
  externalRequests: number;
  browserFallbacks: number;
  egressMode: "direct" | "explicit_proxy";
  proxyHost: string | null;
  results: EbayCorpusTargetOutcome[];
};

function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new Error("corpus_csv_unterminated_quote");
  row.push(cell);
  if (row.some((v) => v.length > 0)) rows.push(row);
  return rows;
}

/** Parses CSV corpus definitions such as `step0/corpus.csv` into canonical eBay US targets. */
export function parseEbayCorpusCsv(raw: string, options: { mapCategory?: boolean } = {}): EbayCorpusTarget[] {
  const rows = parseCsvRows(raw);
  if (rows.length < 2) throw new Error("corpus_csv_empty");
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const idIdx = header.indexOf("id");
  const groupIdx = header.indexOf("group");
  const keywordIdx = header.indexOf("keyword");
  const tierIdx = header.indexOf("tier");
  if (idIdx < 0 || groupIdx < 0 || keywordIdx < 0) throw new Error("corpus_csv_missing_columns");

  const targets: EbayCorpusTarget[] = [];
  const seenIds = new Set<string>();
  for (const cols of rows.slice(1)) {
    const id = cols[idIdx]?.trim();
    const group = cols[groupIdx]?.trim();
    const keyword = cols[keywordIdx]?.trim();
    const tier = tierIdx >= 0 ? cols[tierIdx]?.trim() : undefined;
    if (!id || !group || !keyword) throw new Error("corpus_csv_invalid_row");
    if (seenIds.has(id)) throw new Error("corpus_duplicate_target_id");
    seenIds.add(id);

    const params = new URLSearchParams({ q: keyword, marketplace: "ebay_us" });
    if (options.mapCategory) {
      if (group === "cards" && !/\braw\b/i.test(keyword)) params.set("category", "cards_graded");
      else if (categoryAttributeNames(group)) params.set("category", group);
    }
    const query = normalizeQuery(params);
    targets.push({
      id,
      group,
      ...(tier ? { tier } : {}),
      query,
      queryHash: collectionQueryHash(query),
    });
  }
  return targets;
}

/** Parses structured JSON corpus target definitions (including category, condition, and strong attributes). */
export function parseEbayCorpusJson(raw: string): EbayCorpusTarget[] {
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { targets?: unknown }).targets)
      ? (parsed as { targets: unknown[] }).targets
      : null;
  if (!list?.length) throw new Error("corpus_json_empty");

  const targets: EbayCorpusTarget[] = [];
  const seenIds = new Set<string>();
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("corpus_json_invalid_item");
    }
    const row = entry as Record<string, unknown>;
    const q = typeof row.q === "string" ? row.q.trim() : "";
    if (!q) throw new Error("corpus_json_query_required");
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `target-${index + 1}`;
    if (seenIds.has(id)) throw new Error("corpus_duplicate_target_id");
    seenIds.add(id);
    const group =
      typeof row.group === "string" && row.group.trim()
        ? row.group.trim()
        : typeof row.category === "string" && row.category.trim()
          ? row.category.trim()
          : "general";

    const params = new URLSearchParams({ q, marketplace: "ebay_us" });
    for (const key of [
      "category",
      "brand",
      "model",
      "condition",
      "window_days",
      "price_basis",
      "limit",
      "allow_stale",
      "min_price_cents",
      "max_price_cents",
      "sale_format",
    ]) {
      const val = row[key];
      if (val !== undefined && val !== null) params.set(key, String(val));
    }
    if (row.attributes !== undefined) {
      if (!row.attributes || typeof row.attributes !== "object" || Array.isArray(row.attributes)) {
        throw new Error("corpus_json_invalid_attributes");
      }
      for (const [k, v] of Object.entries(row.attributes as Record<string, unknown>)) {
        if (v !== undefined && v !== null) params.set(`attr_${k}`, String(v));
      }
    }
    const query = normalizeQuery(params);
    targets.push({
      id,
      group,
      ...(typeof row.tier === "string" && row.tier.trim() ? { tier: row.tier.trim() } : {}),
      query,
      queryHash: collectionQueryHash(query),
    });
  });
  return targets;
}

async function atomicWriteFile(filePath: string, data: Uint8Array | string) {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
  await rename(tmp, filePath);
}

function selectProfile(
  layout: "auto" | "s-item" | "s-card",
  firstPage: Uint8Array,
  overrides: EbayProfileOverrides,
): HtmlProfile {
  if (layout === "s-item") return createEbayUsSoldSearchHtmlProfile(overrides);
  if (layout === "s-card") return createEbayUsSoldCardHtmlProfile(overrides);
  return detectEbayUsSoldHtmlProfile(firstPage, overrides);
}

function isHttpAccessBlockedPage(raw: Uint8Array): boolean {
  return (
    hasHtmlAccessBlock(raw, createEbayUsSoldCardHtmlProfile()) ||
    hasHtmlAccessBlock(raw, createEbayUsSoldSearchHtmlProfile())
  );
}

async function resolveTargetSource(
  db: Database,
  asOf: string,
  sourceId?: string,
  configId?: string,
): Promise<{ sourceId: string; configId: string }> {
  if (!sourceId) {
    if (configId) throw new Error("invalid_corpus_source_args");
    return await provisionFixtureSource(db, asOf, { searchSummaries: true });
  }
  if (configId) return { sourceId, configId };
  const row = (
    await db.query<{ id: string }>(
      "SELECT id FROM collector_configs WHERE source_id=$1 AND enabled=true ORDER BY created_at DESC LIMIT 1",
      [sourceId],
    )
  ).rows[0];
  if (!row?.id) throw new Error("collector_config_missing");
  return { sourceId, configId: row.id };
}

/**
 * Executes one bounded corpus collection + detail enrichment cycle against HTTP / self-hosted Chrome,
 * persisting search pages, primary images, and `collector_detail_jobs` in PostgreSQL 16.
 */
export async function runEbayUsCorpusCycle(input: EbayCorpusCycleInput): Promise<EbayCorpusCycleReport> {
  if (!input.targets.length || input.targets.length > 200) throw new Error("invalid_corpus_target_count");
  const transportMode = input.transport ?? "auto";
  const layout = input.layout ?? "auto";
  const maxPages = input.maxPages ?? 1;
  const maxDetails = input.maxDetails ?? 10;
  const fetchImages = input.fetchImages ?? true;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5)
    throw new Error("invalid_ebay_max_pages");
  if (!Number.isSafeInteger(maxDetails) || maxDetails < 0 || maxDetails > 50)
    throw new Error("invalid_ebay_max_details");

  const startedAt = new Date().toISOString();
  const asOf = input.asOf ?? (await input.db.query("SELECT clock_timestamp() t")).rows[0].t.toISOString();
  const clock = input.clock ?? (() => asOf);
  const { sourceId, configId } = await resolveTargetSource(input.db, asOf, input.sourceId, input.configId);
  const spoolDir = resolve(input.spoolDir);
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const mediaStore = new PrivateMediaStore(resolve(input.mediaRoot));
  const outDir = input.outDir ? resolve(input.outDir) : null;
  if (outDir) await mkdir(outDir, { recursive: true, mode: 0o700 });

  const results: EbayCorpusTargetOutcome[] = [];
  let completedTargets = 0;
  let failedTargets = 0;
  let circuitTripped = false;
  let stopReason: string | null = null;
  let pagesCollected = 0;
  let recordsObserved = 0;
  let imagesStored = 0;
  let detailsEnqueued = 0;
  let detailsCompleted = 0;
  let detailsFailed = 0;
  let externalRequests = 0;
  let browserFallbacks = 0;
  const overrides = input.profileOverrides ?? {};
  const parsedProxy =
    typeof input.proxyUrl === "string"
      ? parseProxyUrl(input.proxyUrl)
      : input.proxyUrl
        ? parseProxyUrl(input.proxyUrl)
        : null;

  for (const target of input.targets) {
    if (circuitTripped) break;
    const httpTransport = new EbayUsHttpTransport({
      query: target.query,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.allowLoopbackTestOrigin ? { allowLoopbackTestOrigin: true } : {}),
      ...(input.imageOriginOverride ? { imageOriginOverride: input.imageOriginOverride } : {}),
      ...(parsedProxy && input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
      ...(input.minIntervalMs !== undefined ? { minIntervalMs: input.minIntervalMs } : {}),
    });
    let browserTransport: EbayUsBrowserTransport | null = null;
    const getBrowser = () => {
      browserTransport ??= new EbayUsBrowserTransport({
        query: target.query,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.allowLoopbackTestOrigin ? { allowLoopbackTestOrigin: true } : {}),
        ...(parsedProxy && input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
        ...(input.browserExecutablePath ? { executablePath: input.browserExecutablePath } : {}),
        ...(input.waitForSelector ? { waitForSelector: input.waitForSelector } : {}),
        ...(input.minIntervalMs !== undefined ? { minIntervalMs: input.minIntervalMs } : {}),
      });
      return browserTransport;
    };
    const tripStop = async (reason: string) => {
      const guardStore = new CollectorStore(input.db, clock);
      await guardStore.stop(sourceId, reason);
      circuitTripped = true;
      stopReason = reason;
    };

    let transportUsed: "http" | "browser" = transportMode === "browser" ? "browser" : "http";
    let browserFallbackUsed = false;

    try {
      const rawPages: Array<{ cursor: string; bytes: Uint8Array }> = [];
      const frames = new Map<string, FixtureResponse[]>();
      const imageUrls = new Set<string>();
      let chosenProfile: HtmlProfile | undefined;
      let truncatedPagination = false;
      let cursor = "start";
      let targetError: string | undefined;

      for (let i = 0; i < maxPages; i++) {
        let activeUseBrowser = transportMode === "browser";
        let pageRes = await (activeUseBrowser ? getBrowser() : httpTransport).read(`page:${cursor}`);
        externalRequests++;

        if (pageRes.status === 401 || pageRes.status === 403) {
          await tripStop("source_access_refused");
          targetError = "source_access_refused";
          break;
        }
        if (pageRes.status !== 200) {
          targetError = pageRes.status === 429 ? "upstream_rate_limited" : "upstream_unavailable";
          break;
        }
        let ct = pageRes.contentType.split(";")[0]?.trim().toLowerCase();
        if (ct !== "text/html") {
          targetError = "page_content_type_invalid";
          break;
        }
        if (isHttpAccessBlockedPage(pageRes.bytes)) {
          await tripStop("source_access_refused");
          targetError = "source_access_refused";
          break;
        }

        let probeProfile = chosenProfile ?? selectProfile(layout, pageRes.bytes, overrides);
        let audit = auditEbayUsHtmlPage(
          pageRes.bytes,
          { sourceId, queryHash: target.queryHash, cursor, asOf },
          probeProfile,
        );

        // In "auto" mode, retry once via headless Chromium ONLY for unblocked JS shells missing the result root.
        if (
          !activeUseBrowser &&
          transportMode === "auto" &&
          !audit.ok &&
          audit.kind === "structure_invalid" &&
          audit.error === "html_page_binding_invalid" &&
          !isHttpAccessBlockedPage(pageRes.bytes)
        ) {
          activeUseBrowser = true;
          transportUsed = "browser";
          browserFallbackUsed = true;
          browserFallbacks++;
          pageRes = await getBrowser().read(`page:${cursor}`);
          externalRequests++;
          if (pageRes.status === 401 || pageRes.status === 403) {
            await tripStop("source_access_refused");
            targetError = "source_access_refused";
            break;
          }
          if (pageRes.status !== 200) {
            targetError = pageRes.status === 429 ? "upstream_rate_limited" : "upstream_unavailable";
            break;
          }
          ct = pageRes.contentType.split(";")[0]?.trim().toLowerCase();
          if (ct !== "text/html") {
            targetError = "page_content_type_invalid";
            break;
          }
          if (isHttpAccessBlockedPage(pageRes.bytes)) {
            await tripStop("source_access_refused");
            targetError = "source_access_refused";
            break;
          }
          probeProfile = chosenProfile ?? selectProfile(layout, pageRes.bytes, overrides);
          audit = auditEbayUsHtmlPage(
            pageRes.bytes,
            { sourceId, queryHash: target.queryHash, cursor, asOf },
            probeProfile,
          );
        }

        if (!audit.ok) {
          targetError = audit.error;
          break;
        }
        chosenProfile ??= probeProfile;
        rawPages.push({ cursor, bytes: pageRes.bytes });
        frames.set(`page:${cursor}`, [
          { status: 200, contentType: "text/html; charset=utf-8", bytes: pageRes.bytes },
        ]);
        if (fetchImages) {
          for (const rec of audit.page.records) {
            if (rec.primaryImage?.url) imageUrls.add(rec.primaryImage.url);
          }
        }
        if (outDir) {
          const targetDir = join(outDir, target.id);
          await mkdir(targetDir, { recursive: true, mode: 0o700 });
          await atomicWriteFile(join(targetDir, `page-${i + 1}.html`), pageRes.bytes);
        }
        truncatedPagination = audit.page.nextCursor !== null;
        if (!audit.page.nextCursor) break;
        cursor = audit.page.nextCursor;
      }

      if (targetError || !rawPages.length || !chosenProfile) {
        failedTargets++;
        results.push({
          id: target.id,
          group: target.group,
          query: target.query,
          queryHash: target.queryHash,
          ok: false,
          status: circuitTripped ? "circuit_open" : "failed",
          error: targetError ?? "ebay_corpus_no_pages",
          transportUsed,
          browserFallbackUsed,
          pageCount: 0,
          truncatedPagination: false,
          recordEvidenceCount: 0,
          availablePrimaryImages: 0,
          detailsEnqueued: 0,
          detailsCompleted: 0,
          detailsFailed: 0,
          stats: null,
        });
        continue;
      }

      for (const imgUrl of imageUrls) {
        if (circuitTripped) break;
        const imgRes = await httpTransport.read(`image:${imgUrl}`);
        externalRequests++;
        if (imgRes.status === 401 || imgRes.status === 403) {
          await tripStop("source_access_refused");
          targetError = "source_access_refused";
          break;
        }
        if (imgRes.status === 200) {
          frames.set(`image:${imgUrl}`, [
            { status: 200, contentType: imgRes.contentType, bytes: imgRes.bytes },
          ]);
        }
      }
      if (targetError) {
        failedTargets++;
        results.push({
          id: target.id,
          group: target.group,
          query: target.query,
          queryHash: target.queryHash,
          ok: false,
          status: "circuit_open",
          error: targetError,
          transportUsed,
          browserFallbackUsed,
          pageCount: 0,
          truncatedPagination: false,
          recordEvidenceCount: 0,
          availablePrimaryImages: 0,
          detailsEnqueued: 0,
          detailsCompleted: 0,
          detailsFailed: 0,
          stats: null,
        });
        continue;
      }

      const store = new CollectorStore(input.db, clock, { htmlProfile: chosenProfile });
      const jobId = await store.enqueue({
        sourceId,
        configId,
        queryHash: target.queryHash,
        runKey: `ebay-daemon:${target.id}:${randomUUID()}`,
        asOf,
      });
      const artifact = createFixtureArtifact(
        { sourceId, jobId, queryHash: target.queryHash, asOf, htmlProfile: chosenProfile },
        frames,
      );
      const artifactJson = `${JSON.stringify(artifact)}\n`;
      const loaded = loadFixtureArtifact(Buffer.from(artifactJson));
      const artifactPath = join(spoolDir, `collector-html-fixture-${jobId}.json`);
      await atomicWriteFile(artifactPath, artifactJson);
      await store.bindFixtureArtifact({
        jobId,
        sourceId,
        queryHash: target.queryHash,
        asOf,
        hash: loaded.hash,
        pageHashes: loaded.pageHashes,
      });
      const worker = new OfflineCollectorWorker(store, loaded.transport, mediaStore);
      const runResult = await worker.runOne(sourceId, {
        jobId,
        maxPages: rawPages.length,
        completeAtPageLimit: true,
      });

      let targetDetailsEnqueued = 0;
      let targetDetailsCompleted = 0;
      let targetDetailsFailed = 0;

      if (runResult?.status === "completed" && maxDetails > 0) {
        const queued = await store.enqueuePendingDetails({ sourceId, jobId, maxDetails });
        targetDetailsEnqueued = queued.enqueued;
        detailsEnqueued += queued.enqueued;

        if (queued.externalListingIds.length) {
          const detailFrames = new Map<string, FixtureResponse[]>();
          for (const listingId of queued.externalListingIds) {
            if (circuitTripped) break;
            let useBrowserDetail = transportUsed === "browser";
            let dRes = await (useBrowserDetail ? getBrowser() : httpTransport).read(`detail:${listingId}`);
            externalRequests++;
            if (dRes.status === 401 || dRes.status === 403) {
              await tripStop("source_access_refused");
              break;
            }
            if (dRes.status === 200 && hasEbayDetailAccessBlock(dRes.bytes)) {
              await tripStop("source_access_refused");
              break;
            }
            if (
              !useBrowserDetail &&
              transportMode === "auto" &&
              dRes.status === 200 &&
              dRes.contentType.split(";")[0]?.trim().toLowerCase() === "text/html"
            ) {
              try {
                parseEbayUsItemDetailHtml(dRes.bytes, {
                  listingId,
                  listingHosts: chosenProfile.listingHosts,
                  imageHosts: chosenProfile.imageHosts,
                });
              } catch (detailErr) {
                if (detailErr instanceof Error && detailErr.message === "detail_structure_invalid") {
                  useBrowserDetail = true;
                  browserFallbackUsed = true;
                  browserFallbacks++;
                  dRes = await getBrowser().read(`detail:${listingId}`);
                  externalRequests++;
                  if (dRes.status === 401 || dRes.status === 403) {
                    await tripStop("source_access_refused");
                    break;
                  }
                  if (dRes.status === 200 && hasEbayDetailAccessBlock(dRes.bytes)) {
                    await tripStop("source_access_refused");
                    break;
                  }
                }
              }
            }
            if (outDir && dRes.status === 200 && !hasEbayDetailAccessBlock(dRes.bytes)) {
              const detailsOutDir = join(outDir, target.id, "details");
              await mkdir(detailsOutDir, { recursive: true, mode: 0o700 });
              await atomicWriteFile(join(detailsOutDir, `${listingId}.html`), dRes.bytes);
            }
            detailFrames.set(`detail:${listingId}`, [dRes]);
          }

          if (!circuitTripped && detailFrames.size) {
            const detailWorker = new OfflineCollectorWorker(
              store,
              new FixtureTransport(detailFrames),
              mediaStore,
            );
            const detailOutcomes = await detailWorker.runDetails(sourceId, {
              parentJobId: jobId,
              maxTasks: maxDetails,
            });
            for (const o of detailOutcomes) {
              if (o.status === "completed") targetDetailsCompleted++;
              else targetDetailsFailed++;
            }
            detailsCompleted += targetDetailsCompleted;
            detailsFailed += targetDetailsFailed;
          }
        }
      }

      const counts = (
        await input.db.query<{ records: number; images: number }>(
          `SELECT
             (SELECT count(*)::int FROM listing_record_evidence WHERE source_id=$1 AND observation_id IN (SELECT observation_id FROM collector_pages WHERE job_id=$2)) AS records,
             (SELECT count(*)::int FROM listing_images WHERE source_id=$1 AND state='available' AND observation_id IN (SELECT observation_id FROM collector_pages WHERE job_id=$2)) AS images`,
          [sourceId, jobId],
        )
      ).rows[0] ?? { records: 0, images: 0 };

      const job = await store.view(jobId);
      const ok = job.status === "completed" && !circuitTripped;
      const stats =
        job.status === "completed" && !circuitTripped
          ? evaluate(await store.candidates(jobId), {
              sourceId,
              asOf,
              days: target.query.window_days,
              basis: target.query.price_basis,
              limit: target.query.limit,
            }).stats
          : null;

      pagesCollected += job.page_count;
      recordsObserved += counts.records;
      imagesStored += counts.images;
      if (ok) completedTargets++;
      else failedTargets++;

      results.push({
        id: target.id,
        group: target.group,
        query: target.query,
        queryHash: target.queryHash,
        ok,
        status: circuitTripped ? "circuit_open" : (runResult?.status ?? job.status),
        jobId,
        transportUsed,
        browserFallbackUsed,
        pageCount: job.page_count,
        truncatedPagination,
        recordEvidenceCount: counts.records,
        availablePrimaryImages: counts.images,
        detailsEnqueued: targetDetailsEnqueued,
        detailsCompleted: targetDetailsCompleted,
        detailsFailed: targetDetailsFailed,
        stats,
      });
    } catch (error) {
      const reason =
        error instanceof Error && /^[a-z0-9_]+$/i.test(error.message)
          ? error.message
          : "ebay_corpus_target_failed";
      if (reason === "source_access_refused" || reason === "source_circuit_open") {
        circuitTripped = true;
        stopReason ??= reason;
      }
      failedTargets++;
      results.push({
        id: target.id,
        group: target.group,
        query: target.query,
        queryHash: target.queryHash,
        ok: false,
        status: circuitTripped ? "circuit_open" : "failed",
        error: reason,
        transportUsed,
        browserFallbackUsed,
        pageCount: 0,
        truncatedPagination: false,
        recordEvidenceCount: 0,
        availablePrimaryImages: 0,
        detailsEnqueued: 0,
        detailsCompleted: 0,
        detailsFailed: 0,
        stats: null,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const report: EbayCorpusCycleReport = {
    schema: "soldbench.ebay-daemon-cycle.v1",
    mode: "offline_fixture",
    onlineVerified: !input.allowLoopbackTestOrigin,
    sourceId,
    configId,
    transportMode,
    asOf,
    startedAt,
    finishedAt,
    targetsAttempted: results.length,
    completedTargets,
    failedTargets,
    circuitTripped,
    stopReason,
    pagesCollected,
    recordsObserved,
    imagesStored,
    detailsEnqueued,
    detailsCompleted,
    detailsFailed,
    externalRequests,
    browserFallbacks,
    egressMode: parsedProxy ? "explicit_proxy" : "direct",
    proxyHost: parsedProxy ? parsedProxy.summary.host : null,
    results,
  };
  if (outDir) {
    await appendFile(join(outDir, "stability-cycles.jsonl"), `${JSON.stringify(report)}\n`, {
      mode: 0o600,
    });
  }
  return report;
}
