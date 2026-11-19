import type { Database } from "@soldbench/db";
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
    command: z.enum(["submit", "approve", "publish", "rollback", "unpublish"]),
    entry_id: z.uuid(),
    revision: z.int().positive(),
    version,
    reason,
  }),
]);
export type SiteContentCommand = z.infer<typeof siteContentCommand>;

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
