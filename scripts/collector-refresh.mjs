import { resolve } from "node:path";
import { CollectorRefresh, CollectorStore } from "@soldbench/collector";
import { instant } from "@soldbench/core";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { readRefreshProfile } from "./collector-fixture-file.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--(action|source|config|query|key|start|interval|lag|ttl|plan|clock|profile)=(.+)$/.exec(raw);
  if (!m || args.has(m[1])) throw new Error("invalid_refresh_argument");
  args.set(m[1], m[2]);
}
const action = args.get("action") ?? "cycle",
  source = args.get("source");
if (!source || !/^[a-f0-9-]{36}$/.test(source) || !["create", "retire", "cycle"].includes(action))
  throw new Error("invalid_refresh_action");
const actionArguments = {
  create: ["config", "query", "key", "start", "interval", "lag", "ttl"],
  retire: ["plan"],
  cycle: [],
};
const allowed = new Set(["action", "source", "clock", "profile", ...actionArguments[action]]);
if ([...args.keys()].some((key) => !allowed.has(key))) throw new Error("invalid_refresh_action_argument");
const config = loadConfig(process.env);
if (args.has("clock")) instant(args.get("clock"));
const url = config.databaseUrl ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const profile = args.has("profile") ? await readRefreshProfile(resolve(args.get("profile"))) : undefined;
const db = database(url);
try {
  await prepareDatabase(db, config.databaseStartup);
  const store = new CollectorStore(db, args.has("clock") ? () => args.get("clock") : undefined, {
      htmlProfile: profile,
    }),
    refresh = new CollectorRefresh(store);
  let result;
  if (action === "create") {
    if (
      !args.get("config") ||
      !args.get("query") ||
      !args.get("key") ||
      !args.get("interval") ||
      !args.get("lag")
    )
      throw new Error("refresh_create_parameters_required");
    for (const key of ["interval", "lag", "ttl"])
      if (args.has(key) && !/^\d+$/.test(args.get(key))) throw new Error("invalid_refresh_interval");
    result = {
      planId: await refresh.create({
        sourceId: source,
        configId: args.get("config"),
        query: new URLSearchParams(args.get("query")),
        key: args.get("key"),
        startAt: args.get("start"),
        intervalSeconds: Number(args.get("interval")),
        maxLagSeconds: Number(args.get("lag")),
        jobTtlSeconds: Number(args.get("ttl") ?? 3600),
      }),
    };
  } else if (action === "retire") {
    if (!args.get("plan")) throw new Error("refresh_plan_required");
    await refresh.retire(source, args.get("plan"));
    result = { retired: true };
  } else {
    const planned = await refresh.materialize(source),
      dispatch = [];
    let prioritized = 0;
    for (let i = 0; i < 100; i++) {
      if (planned.more) prioritized += await refresh.materializeNextAvailable(source);
      const r = await refresh.dispatchNext(source, { preferAvailable: true });
      if (!r) break;
      dispatch.push(r);
    }
    result = { planned, prioritized, dispatch };
  }
  console.log(
    JSON.stringify({
      mode: "offline_fixture",
      networkRequests: 0,
      onlineVerified: false,
      clock: args.has("clock") ? "explicit_simulation" : "database",
      action,
      ...result,
    }),
  );
} finally {
  await db.end();
}
