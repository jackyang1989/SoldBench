import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEbayCorpusCsv, parseEbayCorpusJson, runEbayUsCorpusCycle } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { loadConfig, parseProxyUrl } from "@soldbench/shared";
import { fixtureJobId } from "./collector-fixture-file.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

function parseCliArgs(argv) {
  const options = new Map();
  for (const raw of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(raw);
    if (!match || options.has(match[1])) throw new Error("invalid_ebay_daemon_argument");
    options.set(match[1], match[2]);
  }
  const allowedKeys = new Set([
    "allow-live-fetch",
    "corpus",
    "group",
    "offset",
    "limit",
    "transport",
    "layout",
    "max-pages",
    "max-details",
    "fetch-images",
    "min-interval-ms",
    "wait-for-selector",
    "origin",
    "image-origin-override",
    "allow-loopback-test-origin",
    "proxy-url",
    "source",
    "config",
    "spool",
    "out",
    "as-of",
    "cycles",
    "interval-ms",
  ]);
  for (const key of options.keys()) {
    if (!allowedKeys.has(key)) throw new Error("invalid_ebay_daemon_argument");
  }
  return options;
}

function parseBoundedInt(raw, fallback, min, max, errorCode) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(errorCode);
  const val = Number(raw);
  if (!Number.isSafeInteger(val) || val < min || val > max) throw new Error(errorCode);
  return val;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let db;
  const abort = new AbortController();
  const onStop = () => abort.abort();
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.get("allow-live-fetch") !== "true") {
      throw new Error("live_fetch_explicit_opt_in_required");
    }

    const transport = options.get("transport") ?? "auto";
    if (!["http", "browser", "auto"].includes(transport)) throw new Error("invalid_ebay_transport");
    const layout = options.get("layout") ?? "auto";
    if (!["auto", "s-item", "s-card"].includes(layout)) throw new Error("invalid_ebay_intake_layout");

    const maxPages = parseBoundedInt(options.get("max-pages"), 1, 1, 5, "invalid_ebay_max_pages");
    const maxDetails = parseBoundedInt(options.get("max-details"), 10, 0, 50, "invalid_ebay_max_details");
    const offset = parseBoundedInt(options.get("offset"), 0, 0, 10000, "invalid_ebay_daemon_offset");
    const limit = parseBoundedInt(options.get("limit"), 12, 1, 200, "invalid_ebay_daemon_limit");
    const cycles = parseBoundedInt(options.get("cycles"), 1, 1, 100, "invalid_ebay_daemon_cycles");
    const intervalMs = parseBoundedInt(
      options.get("interval-ms"),
      5000,
      0,
      3600000,
      "invalid_ebay_daemon_interval",
    );
    const minIntervalMs = options.has("min-interval-ms")
      ? parseBoundedInt(options.get("min-interval-ms"), 0, 0, 60000, "invalid_ebay_interval")
      : undefined;
    const cliProxyUrl = options.get("proxy-url");
    if (cliProxyUrl !== undefined) parseProxyUrl(cliProxyUrl);

    const fetchImages = (options.get("fetch-images") ?? "true") !== "false";
    const allowLoopback = options.get("allow-loopback-test-origin") === "true";
    const sourceArg = options.get("source");
    const configArg = options.get("config");
    if (sourceArg && !fixtureJobId.test(sourceArg)) throw new Error("invalid_ebay_daemon_argument");
    if (configArg && (!sourceArg || !fixtureJobId.test(configArg)))
      throw new Error("invalid_ebay_daemon_argument");

    const corpusPath = resolve(options.get("corpus") ?? "step0/corpus.csv");
    const corpusRaw = await readFile(corpusPath, "utf8");
    let targets =
      extname(corpusPath).toLowerCase() === ".json"
        ? parseEbayCorpusJson(corpusRaw)
        : parseEbayCorpusCsv(corpusRaw);
    const groupFilter = options.get("group");
    if (groupFilter) targets = targets.filter((t) => t.group === groupFilter);
    targets = targets.slice(offset, offset + limit);
    if (!targets.length) throw new Error("corpus_targets_empty");

    const config = loadConfig(process.env);
    const proxyUrl = cliProxyUrl ?? config.collectorProxyUrl ?? undefined;
    const url = config.databaseUrl ?? localDatabaseUrl();
    assertLocalDatabaseUrl(url, [
      resolve(".local/postgres/socket"),
      ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
    ]);
    db = database(url);
    await prepareDatabase(db, config.databaseStartup);

    const spoolDir = resolve(options.get("spool") ?? process.env.COLLECTOR_DEMO_DIR ?? ".local");
    const outDir = options.get("out") ? resolve(options.get("out")) : undefined;
    const reports = [];

    for (let cycleIndex = 0; cycleIndex < cycles; cycleIndex++) {
      if (abort.signal.aborted) break;
      const report = await runEbayUsCorpusCycle({
        db,
        targets,
        ...(sourceArg ? { sourceId: sourceArg } : {}),
        ...(configArg ? { configId: configArg } : {}),
        transport,
        layout,
        maxPages,
        maxDetails,
        fetchImages,
        ...(options.has("origin") ? { origin: options.get("origin") } : {}),
        ...(options.has("image-origin-override")
          ? { imageOriginOverride: options.get("image-origin-override") }
          : {}),
        ...(allowLoopback ? { allowLoopbackTestOrigin: true } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
        ...(options.has("wait-for-selector") ? { waitForSelector: options.get("wait-for-selector") } : {}),
        ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
        mediaRoot: config.mediaRoot,
        spoolDir,
        ...(outDir ? { outDir } : {}),
        ...(options.has("as-of") ? { asOf: options.get("as-of") } : {}),
      });
      reports.push(report);
      if (report.circuitTripped) break;
      if (cycleIndex + 1 < cycles && intervalMs > 0) {
        await delay(intervalMs, undefined, { signal: abort.signal }).catch((e) => {
          if (e.name !== "AbortError") throw e;
        });
      }
    }

    const last = reports.at(-1);
    const anyFailure = reports.some((r) => r.circuitTripped || r.failedTargets > 0);
    const output =
      cycles === 1 && last
        ? { ok: !anyFailure, ...last }
        : {
            ok: !anyFailure,
            schema: "soldbench.ebay-daemon-summary.v1",
            cyclesRequested: cycles,
            cyclesRun: reports.length,
            circuitTripped: reports.some((r) => r.circuitTripped),
            reports,
          };
    console.log(JSON.stringify(output));
    if (anyFailure) process.exitCode = 1;
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z0-9_]+$/i.test(error.message)
        ? error.message
        : "collector_ebay_daemon_failed";
    console.error(JSON.stringify({ ok: false, error: reason }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
    await db?.end();
  }
}
