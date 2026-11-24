import { resolve } from "node:path";
import { collectorHealth } from "@soldbench/collector";
import { database, prepareDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--(source|from|clock|check-media|daily-days)=(.+)$/.exec(raw);
  if (!m || args.has(m[1])) throw new Error("invalid_collector_report_argument");
  args.set(m[1], m[2]);
}
if (!/^[a-f0-9-]{36}$/.test(args.get("source") ?? "")) throw new Error("source_id_required");
const checkMedia = args.get("check-media");
const daily = args.get("daily-days");
if (daily !== undefined && daily !== "7" && daily !== "14") throw new Error("invalid_collector_daily_window");
if (checkMedia !== undefined && !/^(?:[1-9]|1[0-9]|20)$/.test(checkMedia))
  throw new Error("invalid_media_probe_limit");
if (checkMedia !== undefined && args.has("clock")) throw new Error("media_probe_requires_database_clock");
const config = loadConfig(process.env);
const url = config.databaseUrl ?? localDatabaseUrl();
assertAllowedDatabaseUrl(config, url);
const db = database(url);
try {
  await prepareDatabase(db, config.databaseStartup);
  console.log(
    JSON.stringify(
      await collectorHealth(db, args.get("source"), {
        dataMode: config.dataMode,
        from: args.get("from"),
        now: args.get("clock"),
        persist: true,
        ...(daily !== undefined && { dailyDays: Number(daily) }),
        ...(checkMedia === undefined
          ? {}
          : {
              mediaProbe: {
                store: new PrivateMediaStore(resolve(config.mediaRoot)),
                limit: Number(checkMedia),
              },
            }),
      }),
    ),
  );
} finally {
  await db.end();
}
