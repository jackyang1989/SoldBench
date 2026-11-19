import { availability, categoryAttributeNames, offlineQueryWindows } from "@soldbench/core";
import { type Database, transaction } from "@soldbench/db";
import type { QueryService } from "@soldbench/query";
import { AppError } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import * as z from "zod";

const attribute = z.strictObject({
  name: z.string(),
  type: z.literal("string"),
  allowed_values: z.array(z.string().min(1).max(120)).max(100),
  required_for_comparability: z.boolean(),
});

type Env = { Variables: { requestId: string } };

export function readCatalog(db: Database, query?: QueryService) {
  return transaction(db, async (c) => {
    const now: Date = query
      ? await query.now(c)
      : (await c.query("SELECT clock_timestamp() AS now")).rows[0].now;
    const rows = (
      await c.query(
        `SELECT t.category_path,t.name,t.supported_windows,t.attribute_schema,
              projected.last_at,projected.collector_status,projected.paused,
              EXISTS(SELECT 1 FROM data_availability a WHERE a.category_path=t.category_path) AS had_status
         FROM category_taxonomy t
         LEFT JOIN LATERAL (
           SELECT CASE WHEN a.last_successful_observation_at<=$1 THEN a.last_successful_observation_at END AS last_at,a.collector_status,
                  EXISTS(SELECT 1 FROM collector_circuits k WHERE k.source_id=s.id
                           AND k.category_key IN ('*',t.category_path) AND k.status<>'closed') AS paused
             FROM data_availability a JOIN sources s ON s.id=a.source_id
                  JOIN source_clearances x ON x.id=s.source_clearance_id
            WHERE a.category_path=t.category_path AND a.freshness_state<>'forbidden'
              AND s.marketplace=t.marketplace AND s.access_method='offline_fixture' AND s.status='active'
              AND x.provider='synthetic_fixture' AND x.status IN ('draft','reviewed','active')
              AND (x.effective_at IS NULL OR x.effective_at<=$1)
              AND (x.expires_at IS NULL OR x.expires_at>$1)
              AND x.permitted_fields->'public_cache' @> '["aggregate"]'::jsonb
            ORDER BY last_at DESC NULLS LAST,s.id LIMIT 1
         ) projected ON true
        WHERE t.active AND t.marketplace='ebay_us' ORDER BY t.category_path`,
        [now],
      )
    ).rows;
    return rows.flatMap((row) => {
      const names = categoryAttributeNames(row.category_path);
      if (!names) return [];
      const asOf = row.last_at?.toISOString() ?? null;
      const rights = row.had_status && row.collector_status === null ? "revoked" : "allowed";
      const verified = availability({
        now: now.toISOString(),
        dataAsOf: asOf,
        currentRights: rights,
        snapshotExists: asOf !== null,
        verifiedSamples: 0,
        allowStale: false,
      });
      const freshness = verified.freshness === "unknown" ? "never_observed" : verified.freshness;
      const status = {
        category: row.category_path,
        data_as_of: asOf,
        freshness_state: freshness,
        collector_status: row.paused
          ? "paused"
          : ["running", "paused", "stopped"].includes(row.collector_status)
            ? row.collector_status
            : "unknown",
        evaluated_at: now.toISOString(),
        incident_message: null,
      };
      const attributes = new Map();
      for (const value of Array.isArray(row.attribute_schema) ? row.attribute_schema : []) {
        const parsed = attribute.safeParse(value);
        if (parsed.success && names.includes(parsed.data.name)) attributes.set(parsed.data.name, parsed.data);
      }
      return [
        {
          status,
          category: {
            id: row.category_path,
            name: row.name,
            marketplace: "ebay_us",
            supported_windows: offlineQueryWindows.filter((days) => row.supported_windows.includes(days)),
            supported_attributes: Array.from(attributes.values()),
            quality_status: "unverified",
            availability: freshness,
          },
        },
      ];
    });
  });
}

export function mountCatalog(app: Hono<Env>, db: Database, query?: QueryService) {
  const response = async (c: Context<Env>, path: "categories" | "data-status") => {
    if (new URL(c.req.url).searchParams.size)
      throw new AppError("invalid_parameter", 400, "Unknown catalog parameter.");
    const rows = await readCatalog(db, query);
    c.header("X-SoldBench-Data-Mode", "synthetic_fixture");
    const data =
      path === "categories"
        ? rows.filter((row) => row.status.freshness_state !== "forbidden").map((row) => row.category)
        : rows.map((row) => row.status);
    return c.json({ data, meta: { request_id: c.get("requestId"), credits_charged: 0 } });
  };
  app.get("/v1/categories", (c) => response(c, "categories"));
  app.get("/v1/data-status", (c) => response(c, "data-status"));
}
