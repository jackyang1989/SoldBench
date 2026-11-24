import { fileURLToPath } from "node:url";
import { provisionApprovedEbaySource } from "@soldbench/collector";
import { database, prepareDatabase } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

function parseCliArgs(argv) {
  const options = new Map();
  const allowed = new Set([
    "allow-live-provisioning",
    "access-method",
    "provider",
    "dataset",
    "document-ref",
    "document-hash",
    "reviewed-by",
    "effective-at",
    "expires-at",
    "now",
    "approval-ref",
    "retention-days",
    "rate-cap",
    "concurrency",
    "max-pages",
    "max-bytes",
    "daily-jobs",
    "daily-pages",
    "daily-bytes",
    "budget-policy-days",
    "search-summaries",
    "public-aggregates",
  ]);
  for (const raw of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(raw);
    if (!match || !allowed.has(match[1]) || options.has(match[1])) {
      throw new Error("invalid_provision_source_argument");
    }
    options.set(match[1], match[2]);
  }
  return options;
}

function parseOptionalInt(options, key) {
  const raw = options.get(key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("invalid_approved_budget");
  return Number(raw);
}

function parseOptionalBoolean(options, key) {
  const raw = options.get(key);
  if (raw === undefined) return undefined;
  if (raw !== "true" && raw !== "false") throw new Error("invalid_provision_source_argument");
  return raw === "true";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.get("allow-live-provisioning") !== "true") {
      throw new Error("live_provisioning_explicit_opt_in_required");
    }
    const config = loadConfig(process.env);
    if (!config.liveGateAcknowledged) {
      throw new Error("live_gate_acknowledgement_required");
    }
    const url = config.databaseUrl ?? localDatabaseUrl();
    assertAllowedDatabaseUrl(config, url);
    db = database(url);
    await prepareDatabase(db, config.databaseStartup);

    const provisioned = await provisionApprovedEbaySource(db, {
      accessMethod: options.get("access-method") ?? "approved_http",
      ...(options.has("provider") ? { provider: options.get("provider") } : {}),
      ...(options.has("dataset") ? { dataset: options.get("dataset") } : {}),
      documentRef: options.get("document-ref") ?? "",
      documentHash: options.get("document-hash") ?? "",
      reviewedBy: options.get("reviewed-by") ?? "",
      effectiveAt: options.get("effective-at") ?? "",
      expiresAt: options.get("expires-at") ?? "",
      ...(options.has("now") ? { now: options.get("now") } : {}),
      ...(options.has("approval-ref") ? { approvalRef: options.get("approval-ref") } : {}),
      ...(parseOptionalInt(options, "retention-days") !== undefined
        ? { retentionDays: parseOptionalInt(options, "retention-days") }
        : {}),
      ...(parseOptionalInt(options, "rate-cap") !== undefined
        ? { rateCap: parseOptionalInt(options, "rate-cap") }
        : {}),
      ...(parseOptionalInt(options, "concurrency") !== undefined
        ? { concurrency: parseOptionalInt(options, "concurrency") }
        : {}),
      ...(parseOptionalInt(options, "max-pages") !== undefined
        ? { maxPages: parseOptionalInt(options, "max-pages") }
        : {}),
      ...(parseOptionalInt(options, "max-bytes") !== undefined
        ? { maxBytes: parseOptionalInt(options, "max-bytes") }
        : {}),
      ...(parseOptionalInt(options, "daily-jobs") !== undefined
        ? { dailyJobs: parseOptionalInt(options, "daily-jobs") }
        : {}),
      ...(parseOptionalInt(options, "daily-pages") !== undefined
        ? { dailyPages: parseOptionalInt(options, "daily-pages") }
        : {}),
      ...(parseOptionalInt(options, "daily-bytes") !== undefined
        ? { dailyBytes: parseOptionalInt(options, "daily-bytes") }
        : {}),
      ...(parseOptionalInt(options, "budget-policy-days") !== undefined
        ? { budgetPolicyDays: parseOptionalInt(options, "budget-policy-days") }
        : {}),
      ...(parseOptionalBoolean(options, "search-summaries") !== undefined
        ? { searchSummaries: parseOptionalBoolean(options, "search-summaries") }
        : {}),
      ...(parseOptionalBoolean(options, "public-aggregates") !== undefined
        ? { publicAggregates: parseOptionalBoolean(options, "public-aggregates") }
        : {}),
    });

    console.log(JSON.stringify({ ok: true, mode: config.dataMode, ...provisioned }));
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z0-9_]+$/i.test(error.message)
        ? error.message
        : "collector_provision_source_failed";
    console.error(JSON.stringify({ ok: false, error: reason }));
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
