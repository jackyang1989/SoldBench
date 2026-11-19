import { type Database, type Transaction, transaction } from "@soldbench/db";
import * as z from "zod";

const hasValidText = (value: string) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
const section = z.strictObject({
  title: z.string().trim().min(1).max(140).refine(hasValidText),
  body: z.string().trim().min(1).max(6000).refine(hasValidText),
});
const reason = z.string().trim().min(1).max(500);
const version = z.int().nonnegative();
export const siteContentCommand = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("draft"),
    kind: z.enum(["announcement", "faq", "guide"]),
    slug: z
      .string()
      .max(70)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    version,
    body: z.strictObject({ en: section, "zh-CN": section }),
    reason,
  }),
  z.strictObject({
    command: z.enum(["submit", "approve", "publish", "rollback", "unpublish", "cancel_schedule"]),
    entry_id: z.uuid(),
    revision: z.int().positive(),
    version,
    reason,
  }),
  z.strictObject({
    command: z.literal("schedule"),
    entry_id: z.uuid(),
    revision: z.int().positive(),
    version,
    execute_at: z.iso.datetime(),
    reason,
  }),
]);
export type SiteContentCommand = z.infer<typeof siteContentCommand>;

export async function publishContentRevision(c: Transaction, entry: string, revision: number, now: Date) {
  await c.query(
    "UPDATE site_content_revisions SET first_published_at=coalesce(first_published_at,$3) WHERE entry_id=$1 AND revision=$2",
    [entry, revision, now],
  );
  await c.query("UPDATE site_content_entries SET published_revision=$2,published_at=$3 WHERE id=$1", [
    entry,
    revision,
    now,
  ]);
}

export async function publishNextScheduledContent(db: Database, clock?: () => string) {
  return transaction(db, async (c) => {
    const now = clock ? new Date(clock()) : (await c.query("SELECT clock_timestamp() now")).rows[0].now;
    const candidate = (
      await c.query(
        `SELECT s.id,s.scheduled_by,v.reviewer_id FROM site_content_schedules s
          JOIN site_content_revisions v ON (v.entry_id,v.revision)=(s.entry_id,s.revision)
         WHERE s.status='pending' AND s.execute_at<=$1 ORDER BY s.execute_at,s.id LIMIT 1`,
        [now],
      )
    ).rows[0];
    if (!candidate) return null;
    const actors = [...new Set([candidate.scheduled_by, candidate.reviewer_id].filter(Boolean))];
    // Human commands also take user locks before entry locks.
    const operators = await c.query(
      `SELECT u.id FROM users u JOIN admin_roles a ON a.user_id=u.id AND a.role='admin'
        JOIN user_mfa m ON m.user_id=u.id AND m.state='enabled'
        WHERE u.id=ANY($1::uuid[]) AND u.status='active' ORDER BY u.id FOR SHARE OF u,a,m`,
      [actors],
    );
    const scheduled = (
      await c.query(
        `SELECT s.entry_id,s.revision,s.entry_version,v.state,v.reviewer_id,e.version,e.latest_revision,
                e.published_revision FROM site_content_schedules s JOIN site_content_entries e ON e.id=s.entry_id
          JOIN site_content_revisions v ON (v.entry_id,v.revision)=(s.entry_id,s.revision)
         WHERE s.id=$1 AND s.status='pending' FOR UPDATE OF e,s SKIP LOCKED`,
        [candidate.id],
      )
    ).rows[0];
    if (!scheduled) return null;
    let failure: "entry_changed" | "operator_access_changed" | null = null;
    if (
      scheduled.entry_version !== scheduled.version ||
      scheduled.latest_revision !== scheduled.revision ||
      scheduled.published_revision === scheduled.revision ||
      scheduled.state !== "approved"
    )
      failure = "entry_changed";
    else if (!scheduled.reviewer_id || operators.rowCount !== actors.length)
      failure = "operator_access_changed";
    if (!failure) await publishContentRevision(c, scheduled.entry_id, scheduled.revision, now);
    const state = failure ? "blocked" : "published";
    await c.query("UPDATE site_content_schedules SET status=$2,finished_at=$3,failure_code=$4 WHERE id=$1", [
      candidate.id,
      state,
      now,
      failure,
    ]);
    await c.query("UPDATE site_content_entries SET version=version+1,updated_at=$2 WHERE id=$1", [
      scheduled.entry_id,
      now,
    ]);
    await c.query(
      `INSERT INTO audit_events(actor_id,action,object_type,object_id,request_id,safe_diff,created_at)
       VALUES($1,'ops.content.scheduled_publish','site_content',$2,$3,$4,$5)`,
      [
        candidate.scheduled_by,
        scheduled.entry_id,
        candidate.id,
        { revision: scheduled.revision, state, failure_code: failure },
        now,
      ],
    );
    return { schedule_id: candidate.id, status: state };
  });
}

export async function publishedSiteContent(db: Database, kind: "announcement" | "faq" | "guide") {
  return (
    await db.query(
      `SELECT e.slug,v.body FROM site_content_entries e JOIN site_content_revisions v
       ON (v.entry_id,v.revision)=(e.id,e.published_revision)
      WHERE e.kind=$1 AND v.state='approved' ORDER BY e.published_at DESC,e.id LIMIT 40`,
      [kind],
    )
  ).rows;
}
