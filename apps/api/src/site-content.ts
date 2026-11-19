import { type Database, type Transaction, transaction } from "@soldbench/db";
import * as z from "zod";

const hasValidText = (value: string) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
const section = z.strictObject({
  title: z.string().trim().min(1).max(140).refine(hasValidText),
  body: z.string().trim().min(1).max(6000).refine(hasValidText),
});
const reason = z.string().trim().min(1).max(500);
const version = z.int().nonnegative();
const slug = z
  .string()
  .max(70)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const copy = z.string().trim().min(1).max(120).refine(hasValidText);
const position = z.int().min(0).max(1000).optional();
const target = z.enum([
  "/",
  "/search",
  "/research",
  "/pricing",
  "/categories",
  "/guides",
  "/blog",
  "/faq",
  "/methodology",
  "/data-availability",
  "/support",
  "/docs",
  "/agents",
  "/about",
  "/changelog",
]);
const reference = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  });
const article = z.strictObject({ author: copy.optional(), related: z.array(slug).max(6).optional() });
const policy = z.strictObject({ policy_version: copy, reference: reference.optional() });
const ordered = z.strictObject({ position });
const empty = z.strictObject({});
const metadataByKind = {
  announcement: empty,
  faq: empty,
  guide: article,
  blog: article,
  home: z.strictObject({ position, target: target.optional() }),
  navigation: z.strictObject({ position, target }),
  footer: z.strictObject({ position, target }),
  pricing_copy: ordered,
  billing_copy: ordered,
  offer_copy: z.strictObject({ position, reference_key: slug }),
  category_copy: ordered,
  comparison: z.strictObject({ position, reference }),
  changelog: z.strictObject({ reference: reference.optional() }),
  status_copy: ordered,
  status_component: z.strictObject({ position, reference_key: slug }),
  status_incident: z.strictObject({ reference_key: slug }),
  about: empty,
  terms: policy,
  privacy: policy,
};
const contentKind = z.enum(
  Object.keys(metadataByKind) as [keyof typeof metadataByKind, ...(keyof typeof metadataByKind)[]],
);
export type SiteContentKind = z.infer<typeof contentKind>;
export const requiresPolicyRelease = (kind: SiteContentKind) => kind === "terms" || kind === "privacy";

export const siteContentCommand = z
  .discriminatedUnion("command", [
    z.strictObject({
      command: z.literal("draft"),
      kind: contentKind,
      slug,
      version,
      body: z.strictObject({ en: section, "zh-CN": section }),
      metadata: z.record(z.string(), z.unknown()).optional(),
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
  ])
  .superRefine((input, context) => {
    if (input.command !== "draft") return;
    const fields = metadataByKind[input.kind].safeParse(input.metadata ?? {});
    if (!fields.success) {
      for (const issue of fields.error.issues)
        context.addIssue({ ...issue, path: ["metadata", ...issue.path] });
    }
  });
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
        `SELECT s.entry_id,s.revision,s.entry_version,v.state,v.reviewer_id,e.kind,e.version,e.latest_revision,
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
      scheduled.state !== "approved" ||
      requiresPolicyRelease(scheduled.kind)
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

export type PublishedSiteContent = {
  kind: SiteContentKind;
  slug: string;
  revision: number;
  published_at: Date;
  body: Record<"en" | "zh-CN", { title: string; body: string }>;
  metadata: {
    author?: string;
    related?: string[];
    target?: z.infer<typeof target>;
    position?: number;
    reference?: string;
    reference_key?: string;
    policy_version?: string;
  };
};

export async function publishedSiteContent(
  db: Database,
  requestedKinds: SiteContentKind | readonly SiteContentKind[],
  slug?: string,
) {
  const kinds = (typeof requestedKinds === "string" ? [requestedKinds] : requestedKinds).filter(
    (kind) => !requiresPolicyRelease(kind),
  );
  if (!kinds.length) return [];
  return (
    await db.query<PublishedSiteContent>(
      `SELECT content.* FROM unnest($1::text[]) AS requested(kind)
       CROSS JOIN LATERAL (
         SELECT e.kind,e.slug,v.revision,e.published_at,v.body,v.metadata
         FROM site_content_entries e JOIN site_content_revisions v
           ON (v.entry_id,v.revision)=(e.id,e.published_revision)
         WHERE e.kind=requested.kind AND e.published_revision IS NOT NULL
           AND v.state='approved' AND ($2::text IS NULL OR e.slug=$2)
         ORDER BY (v.metadata->'position') NULLS LAST,e.published_at DESC,e.slug LIMIT 40
       ) AS content
       ORDER BY content.kind,(content.metadata->'position') NULLS LAST,content.published_at DESC,content.slug`,
      [[...new Set(kinds)], slug ?? null],
    )
  ).rows;
}
