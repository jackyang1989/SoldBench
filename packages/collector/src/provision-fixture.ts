import { randomUUID } from "node:crypto";
import { canonicalJson, instant } from "@soldbench/core";
import { type Database, transaction } from "@soldbench/db";
import { COLLECTOR_VERSION, digest } from "./fixture.ts";
/** Creates an explicitly synthetic, offline-only source. Never an approved source. */
export async function provisionFixtureSource(
  db: Database,
  now: string,
  options: {
    publicAggregates?: boolean;
    retentionDays?: number;
    rateCap?: number;
    concurrency?: number;
    maxPages?: number;
    maxBytes?: number;
    dailyJobs?: number;
    dailyPages?: number;
    dailyBytes?: number;
    budgetPolicyDays?: number;
  } = {},
) {
  instant(now);
  const { publicAggregates = false, ...limits } = options;
  const settings = {
    retentionDays: 1,
    rateCap: 100,
    concurrency: 2,
    maxPages: 16,
    maxBytes: 32 * 1024 * 1024,
    dailyJobs: 100,
    dailyPages: 1000,
    dailyBytes: 128 * 1024 * 1024,
    budgetPolicyDays: 30,
    ...limits,
  };
  for (const value of Object.values(settings))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_fixture_budget");
  if (settings.retentionDays > 30) throw new Error("invalid_fixture_retention");
  if (settings.budgetPolicyDays > 30) throw new Error("invalid_fixture_policy_duration");
  return transaction(db, async (c) => {
    const clearance = randomUUID(),
      sourceId = randomUUID(),
      configId = randomUUID();
    await c.query(
      "INSERT INTO source_clearances(id,provider,dataset,revision,status,retention_days,permitted_fields) VALUES($1,'synthetic_fixture',$2,1,'draft',$3,$4)",
      [
        clearance,
        sourceId,
        settings.retentionDays,
        {
          research: [
            "identity",
            "title",
            "condition",
            "attributes",
            "description",
            "defects",
            "price",
            "shipping",
            "sold_date",
            "primary_image",
          ],
          ...(publicAggregates ? { public_share: ["aggregate"], public_cache: ["aggregate"] } : {}),
        },
      ],
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
    const from = new Date(instant(now)).toISOString(),
      until = new Date(instant(now) + settings.budgetPolicyDays * 86400000).toISOString(),
      policyHash = digest(
        canonicalJson({
          sourceId,
          jobs: settings.dailyJobs,
          pages: settings.dailyPages,
          bytes: settings.dailyBytes,
          from,
          until,
          approval: "synthetic-fixture-only",
        }),
      );
    await c.query(
      "INSERT INTO collector_daily_budget_policies(source_id,policy_hash,jobs_cap,pages_cap,bytes_cap,approval_ref,valid_from,valid_until,created_at) VALUES($1,$2,$3,$4,$5,'synthetic-fixture-only',$6,$7,$6)",
      [sourceId, policyHash, settings.dailyJobs, settings.dailyPages, settings.dailyBytes, from, until],
    );
    await c.query("UPDATE sources SET daily_budget_policy_hash=$2 WHERE id=$1", [sourceId, policyHash]);
    for (const [kind, cap] of [
      ["jobs", settings.dailyJobs],
      ["pages", settings.dailyPages],
      ["bytes", settings.dailyBytes],
    ])
      await c.query("INSERT INTO source_daily_budget(source_id,day,budget_kind,cap) VALUES($1,$2,$3,$4)", [
        sourceId,
        from.slice(0, 10),
        kind,
        cap,
      ]);
    return { sourceId, configId };
  });
}
