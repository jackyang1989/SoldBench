import { randomUUID } from "node:crypto";
import { instant } from "@soldbench/core";
import { type Database, transaction } from "@soldbench/db";
import { COLLECTOR_VERSION } from "./fixture.ts";
/** Creates an explicitly synthetic, offline-only source. Never an approved source. */
export async function provisionFixtureSource(
  db: Database,
  now: string,
  options: {
    rateCap?: number;
    concurrency?: number;
    maxPages?: number;
    maxBytes?: number;
    dailyJobs?: number;
    dailyPages?: number;
    dailyBytes?: number;
  } = {},
) {
  instant(now);
  const settings = {
    rateCap: 100,
    concurrency: 2,
    maxPages: 16,
    maxBytes: 32 * 1024 * 1024,
    dailyJobs: 100,
    dailyPages: 1000,
    dailyBytes: 128 * 1024 * 1024,
    ...options,
  };
  for (const value of Object.values(settings))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_fixture_budget");
  return transaction(db, async (c) => {
    const clearance = randomUUID(),
      sourceId = randomUUID(),
      configId = randomUUID();
    await c.query(
      "INSERT INTO source_clearances(id,provider,dataset,revision,status,retention_days) VALUES($1,'synthetic_fixture',$2,1,'draft',1)",
      [clearance, sourceId],
    );
    await c.query(
      "INSERT INTO sources(id,source_clearance_id,marketplace,access_method,collector_version,entrypoint_id,status) VALUES($1,$2,'ebay_us','offline_fixture',$3,'in-memory-fixture','active')",
      [sourceId, clearance, COLLECTOR_VERSION],
    );
    await c.query(
      "INSERT INTO collector_configs(id,source_id,collector_version,allowed_entrypoints,access_method,rate_cap,concurrency_cap,max_pages,max_bytes_per_job,enabled) VALUES($1,$2,$3,'[\"in-memory-fixture\"]','offline_fixture',$4,$5,$6,$7,true)",
      [
        configId,
        sourceId,
        COLLECTOR_VERSION,
        settings.rateCap,
        settings.concurrency,
        settings.maxPages,
        settings.maxBytes,
      ],
    );
    for (const [kind, cap] of [
      ["jobs", settings.dailyJobs],
      ["pages", settings.dailyPages],
      ["bytes", settings.dailyBytes],
    ])
      await c.query("INSERT INTO source_daily_budget(source_id,day,budget_kind,cap) VALUES($1,$2,$3,$4)", [
        sourceId,
        now.slice(0, 10),
        kind,
        cap,
      ]);
    return { sourceId, configId };
  });
}
