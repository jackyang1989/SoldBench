import type { Transaction } from "@soldbench/db";
import type { PrivateMediaStore } from "@soldbench/media";

export async function mediaHealth(
  c: Transaction,
  sourceId: string,
  now: Date,
  epoch: string,
  storageIdentity: string | null,
  clearanceExpiresAt: Date | null,
  mayRead: boolean,
  probe?: { store: PrivateMediaStore; limit: number },
) {
  const inventory = (
    await c.query<{
      retained_references: number;
      eligible_references: number;
      eligible_objects: number;
      samples: { object_key: string; read_until: string }[];
    }>(
      `WITH retained AS (
          SELECT i.object_key,LEAST(i.retention_until,o.retention_until,$6::timestamptz) AS read_until,
            ($4::boolean AND i.state='available' AND i.permission_epoch=$3
            AND i.retention_until>$2 AND o.retention_until>$2
            AND NOT EXISTS(SELECT 1 FROM collector_quarantines q WHERE q.affected_event_id=i.sale_event_id)
          ) AS eligible
          FROM listing_images i JOIN source_observations o ON o.id=i.observation_id AND o.source_id=i.source_id
          WHERE i.source_id=$1 AND i.object_key IS NOT NULL AND i.created_at<=$2 AND o.captured_at<=$2
        ), eligible_objects AS (
          SELECT object_key,max(read_until) AS read_until FROM retained WHERE eligible GROUP BY object_key
        )
        SELECT count(*)::int retained_references,count(*) FILTER(WHERE eligible)::int eligible_references,
          (SELECT count(*)::int FROM eligible_objects) AS eligible_objects,
          (SELECT coalesce(jsonb_agg(sample),'[]'::jsonb)
            FROM (SELECT * FROM eligible_objects ORDER BY object_key LIMIT $5) sample) AS samples
        FROM retained`,
      [sourceId, now, epoch, mayRead, probe?.limit ?? 0, clearanceExpiresAt],
    )
  ).rows[0];
  if (!inventory) throw new Error("collector_media_inventory_missing");
  const pending = (
    await c.query<{ n: number; oldest: Date | null }>(
      "SELECT count(*)::int AS n,min(available_at) AS oldest FROM outbox WHERE kind='collector.media_cleanup' AND processed_at IS NULL AND payload->>'sourceId'=$1",
      [sourceId],
    )
  ).rows[0];
  if (!pending) throw new Error("collector_cleanup_inventory_missing");
  const result = {
    status: "not_requested",
    checkedObjects: 0,
    verifiedObjects: 0,
    failedObjects: 0,
    uncheckedEligibleObjects: inventory.eligible_objects,
    expiredDuringProbe: 0,
  };
  if (probe) {
    if (!mayRead) result.status = "permission_unavailable";
    else if (!storageIdentity) result.status = "unbound";
    else {
      const localIdentity = await probe.store.storageIdentity().catch(() => null);
      if (!localIdentity) result.status = "store_unavailable";
      else if (localIdentity !== storageIdentity) result.status = "store_mismatch";
      else {
        result.status = "checked";
        for (const sample of inventory.samples) {
          const current = await c.query<{ before_deadline: boolean }>(
            "SELECT clock_timestamp()<$1::timestamptz AS before_deadline",
            [sample.read_until],
          );
          if (!current.rows[0]?.before_deadline) {
            result.expiredDuringProbe++;
            continue;
          }
          result.checkedObjects++;
          try {
            const key = sample.object_key;
            if (!key.startsWith(`${sourceId}/`)) throw new Error("unexpected_media_namespace");
            await probe.store.get(key, storageIdentity);
            result.verifiedObjects++;
          } catch {
            result.failedObjects++;
          }
        }
        result.uncheckedEligibleObjects -= result.checkedObjects;
      }
    }
  }
  return {
    storeBinding: storageIdentity ? "bound" : "unbound",
    retainedReferences: inventory.retained_references,
    eligibleReferences: inventory.eligible_references,
    excludedReferences: inventory.retained_references - inventory.eligible_references,
    eligibleObjects: inventory.eligible_objects,
    revocationCleanup: { pendingEvents: pending.n, oldestPendingAt: pending.oldest?.toISOString() ?? null },
    probe: result,
  };
}
