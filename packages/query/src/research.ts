import type { Identity } from "@soldbench/auth";
import {
  type Candidate,
  comparisonScope,
  distribution,
  evaluateSnapshot,
  isStandardCondition,
} from "@soldbench/core";
import type { Transaction } from "@soldbench/db";
import { AppError, VERSIONS } from "@soldbench/shared";
import type { QueryService } from "./index.ts";

export const researchFields = [
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
  "listing_url",
  "shipping_context",
  "seller_aggregate",
  "source_match_count",
] as const;
export type ResearchField = (typeof researchFields)[number];
export async function permissions(c: Transaction, queryId: string) {
  const rows = (
    await c.query(
      "SELECT s.id,x.permitted_fields FROM query_result_sources r JOIN sources s ON s.id=r.source_id JOIN source_clearances x ON x.id=s.source_clearance_id WHERE r.query_id=$1 ORDER BY s.id",
      [queryId],
    )
  ).rows;
  return new Map<string, Set<ResearchField>>(
    rows.map((r) => [
      r.id,
      new Set(
        Array.isArray(r.permitted_fields?.research)
          ? r.permitted_fields.research.filter((v: unknown) => researchFields.includes(v as ResearchField))
          : [],
      ),
    ]),
  );
}
export const canPrice = (p: Set<ResearchField> | undefined) =>
  ["identity", "price", "shipping", "sold_date"].every((f) => p?.has(f as ResearchField));
export const allSourcesAllow = (policy: Map<string, Set<ResearchField>>, ...required: ResearchField[]) =>
  policy.size > 0 && [...policy.values()].every((fields) => required.every((field) => fields.has(field)));
export async function writeComparables(
  c: Transaction,
  id: string,
  hash: string,
  records: readonly { sale_event_id: string; candidate: Candidate }[],
  decisions: ReturnType<typeof evaluateSnapshot>["record_decisions"],
) {
  if (records.length !== decisions.length) throw new Error("research_decision_count_mismatch");
  for (const [i, r] of records.entries()) {
    const d = decisions[i];
    if (!d) throw new Error("research_decision_missing");
    await c.query(
      "INSERT INTO query_comparables(query_id,sale_event_id,match_rule_version,is_comparable,include_in_price_stats,primary_exclusion_reason,exclusion_reasons,outlier_candidate,candidate_set_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(query_id,sale_event_id) DO NOTHING",
      [
        id,
        r.sale_event_id,
        VERSIONS.engine,
        d.isComparable,
        d.includeInPriceStats,
        d.exclusionReasons[0] ?? null,
        JSON.stringify(d.exclusionReasons),
        d.outlierCandidate,
        hash,
      ],
    );
  }
}
function field(value: unknown, allowed: boolean) {
  return {
    state: !allowed ? "withheld" : value === null || value === undefined ? "missing" : "present",
    value: allowed ? (value ?? null) : null,
  };
}
function listingLink(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname.endsWith(".example.test") &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
      ? u.href
      : null;
  } catch {
    return null;
  }
}
const fail = (code: string, status: number, message: string): never => {
  throw new AppError(code, status, message);
};
export class ResearchService {
  constructor(readonly query: QueryService) {}
  private async decisions(c: Transaction, id: string) {
    const q = (
        await c.query(
          "SELECT q.*,r.candidate_set_hash FROM queries q JOIN query_results r ON r.query_id=q.id WHERE q.id=$1",
          [id],
        )
      ).rows[0],
      rows = (
        await c.query("SELECT * FROM query_snapshot_records WHERE query_id=$1 ORDER BY sale_event_id", [id])
      ).rows;
    const count = (await c.query("SELECT count(*)::int n FROM query_comparables WHERE query_id=$1", [id]))
      .rows[0].n;
    if (count !== rows.length) {
      const p = q.filters,
        result = evaluateSnapshot(
          rows.map((r) => r.candidate as Candidate),
          {
            sourceId:
              rows[0]?.source_id ??
              q.source_scope?.[0] ??
              (await c.query("SELECT source_id FROM query_result_sources WHERE query_id=$1", [id])).rows[0]
                .source_id,
            asOf: q.as_of.toISOString(),
            days: p.window_days,
            basis: p.price_basis,
            limit: p.limit,
            ...(p.min_price_cents === undefined ? {} : { minPriceCents: p.min_price_cents }),
            ...(p.max_price_cents === undefined ? {} : { maxPriceCents: p.max_price_cents }),
            ...(p.sale_format === undefined ? {} : { saleFormat: p.sale_format }),
          },
        );
      if (result.candidate_set_hash !== q.candidate_set_hash)
        fail("state_conflict", 409, "Snapshot diagnostic version changed.");
      await writeComparables(c, id, q.candidate_set_hash, rows, result.record_decisions);
    }
    if (
      (
        await c.query(
          "SELECT 1 FROM query_comparables WHERE query_id=$1 AND (candidate_set_hash<>$2 OR match_rule_version<>$3) LIMIT 1",
          [id, q.candidate_set_hash, VERSIONS.engine],
        )
      ).rowCount
    )
      fail("state_conflict", 409, "Snapshot diagnostic version changed.");
  }
  async diagnostics(identity: Identity, id: string, cursor?: string, size = 20) {
    return this.query.readSnapshot(identity, id, async (c, { q }) => {
      if (!Number.isSafeInteger(size) || size < 1 || size > 100)
        fail("invalid_parameter", 400, "Invalid page size.");
      await this.decisions(c, id);
      const policy = await permissions(c, id),
        after = this.query.readCursor(identity.userId, `diagnostics:${id}:${q.candidate_set_hash}`, cursor);
      const rows = (
          await c.query(
            "SELECT s.*,d.is_comparable,d.include_in_price_stats,d.primary_exclusion_reason,d.exclusion_reasons,d.outlier_candidate FROM query_snapshot_records s JOIN query_comparables d ON d.query_id=s.query_id AND d.sale_event_id=s.sale_event_id WHERE s.query_id=$1 ORDER BY s.sale_event_id",
            [id],
          )
        ).rows,
        visible = rows.filter((r) => policy.get(r.source_id)?.has("identity")),
        page = visible.filter((r) => !after || r.sale_event_id > after.id).slice(0, size + 1),
        items = page.slice(0, size).map((r) => {
          const allowed = policy.get(r.source_id) ?? new Set<ResearchField>(),
            p = r.candidate as Candidate;
          return {
            sale_event_id: r.sale_event_id,
            ...(allowed.has("title") && p.title ? { title: p.title } : {}),
            sale_price_status: p.priceStatus,
            sale_format: p.format,
            displayed_price_cents:
              allowed.has("price") && p.priceStatus === "displayed_only" && p.currency === "USD"
                ? p.itemCents
                : null,
            primary_exclusion_reason: r.primary_exclusion_reason,
            exclusion_reasons: r.exclusion_reasons,
            is_comparable: r.is_comparable,
            include_in_price_stats: r.include_in_price_stats,
            outlier_candidate: r.outlier_candidate,
          };
        });
      const last = page[size - 1];
      return {
        query_id: id,
        candidate_set_hash: q.candidate_set_hash,
        items,
        next_cursor:
          page.length > size && last
            ? this.query.makeCursor(identity.userId, `diagnostics:${id}:${q.candidate_set_hash}`, {
                id: last.sale_event_id,
                cursor_at: "2000-01-01T00:00:00.000000Z",
              })
            : null,
        withheld_count: rows.length - visible.length,
      };
    });
  }
  async detail(identity: Identity, id: string, eventId: string) {
    return this.query.readSnapshot(identity, id, async (c, { q, now, state, history }) => {
      await this.decisions(c, id);
      const r = (
          await c.query(
            "SELECT s.*,d.is_comparable,d.include_in_price_stats,d.primary_exclusion_reason,d.exclusion_reasons,d.outlier_candidate,l.external_listing_id,o.captured_at,e.evidence FROM query_snapshot_records s JOIN query_comparables d ON d.query_id=s.query_id AND d.sale_event_id=s.sale_event_id JOIN sold_listings l ON l.id=s.listing_id AND l.source_id=s.source_id JOIN source_observations o ON o.id=s.observation_id AND o.source_id=s.source_id LEFT JOIN listing_record_evidence e ON e.sale_event_id=s.sale_event_id AND e.observation_id=s.observation_id AND e.listing_id=s.listing_id AND e.source_id=s.source_id WHERE s.query_id=$1 AND s.sale_event_id=$2",
            [id, eventId],
          )
        ).rows[0],
        policy = await permissions(c, id),
        allowed = (r ? policy.get(r.source_id) : undefined) ?? new Set<ResearchField>();
      if (!r || !allowed?.has("identity")) fail("not_found", 404, "Comparable not found.");
      const p = r.candidate as Candidate,
        e = r.evidence,
        currentEvidence = e?.schema === "soldbench.record-evidence.v2" ? e : null,
        conditionStandard = isStandardCondition(p.condition) ? p.condition : null;
      return {
        query_id: id,
        candidate_set_hash: q.candidate_set_hash,
        sale_event_id: eventId,
        data_mode: "synthetic_fixture",
        verification: {
          sale_price_status: p.priceStatus,
          event_identity_verified: p.identityVerified,
          evidence_type: "synthetic_test_marker",
        },
        decision: {
          is_comparable: r.is_comparable,
          include_in_price_stats: r.include_in_price_stats,
          primary_exclusion_reason: r.primary_exclusion_reason,
          exclusion_reasons: r.exclusion_reasons,
          outlier_candidate: r.outlier_candidate,
        },
        fields: {
          identity: field({ listing_id: r.external_listing_id, sale_format: p.format }, true),
          title: field(p.title ?? null, allowed.has("title")),
          condition: field(
            e?.conditionRaw || e?.conditionId || conditionStandard
              ? {
                  standard: conditionStandard,
                  source_condition_id: e?.conditionId ?? null,
                  source_label: e?.conditionRaw ?? null,
                }
              : null,
            allowed.has("condition"),
          ),
          attributes: field(
            e?.fields?.attributes === "present" && Object.keys(e.attributes ?? {}).length
              ? e.attributes
              : null,
            allowed.has("attributes"),
          ),
          description: field(currentEvidence?.description ?? null, allowed.has("description")),
          defects: field(currentEvidence?.defects ?? null, allowed.has("defects")),
          price: field(
            p.itemCents === null
              ? null
              : { currency: p.currency, item_cents: p.itemCents, status: p.priceStatus },
            allowed.has("price"),
          ),
          shipping: field(
            p.shippingCents === null
              ? null
              : { currency: p.currency, cents: p.shippingCents, status: p.shippingStatus },
            allowed.has("shipping"),
          ),
          sold_date: field(p.time.precision === "unknown" ? null : p.time, allowed.has("sold_date")),
          listing_url: field(
            listingLink(e?.listingUrl),
            allowed.has("listing_url") && (!e?.listingUrl || listingLink(e.listingUrl) !== null),
          ),
          primary_image: field(
            allowed.has("primary_image") ? await this.query.imageView(c, id, eventId, now) : null,
            allowed.has("primary_image"),
          ),
        },
        observed_at: r.captured_at.toISOString(),
        data_as_of: q.data_as_of.toISOString(),
        evaluated_at: q.as_of.toISOString(),
        freshness_state: state.freshness,
        result_mode: history ? "history" : "current",
      };
    });
  }
  async export(identity: Identity, id: string, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("invalid_parameter", 400, "Invalid export options.");
    const input = value as {
      format: "json" | "csv";
      view: "authoritative" | "adjusted";
      excluded_sale_event_ids?: string[];
    };
    if (
      !input ||
      !["json", "csv"].includes(input.format) ||
      !["authoritative", "adjusted"].includes(input.view) ||
      Object.keys(input).some((k) => !["format", "view", "excluded_sale_event_ids"].includes(k))
    )
      fail("invalid_parameter", 400, "Invalid export options.");
    const ids = input.excluded_sale_event_ids ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > 2000 ||
      ids.some(
        (v) =>
          typeof v !== "string" ||
          !/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(v),
      ) ||
      new Set(ids).size !== ids.length ||
      (input.view === "authoritative" && ids.length)
    )
      fail("invalid_parameter", 400, "Invalid adjusted exclusions.");
    return this.query.readSnapshot(identity, id, async (c, { q, now, state, history }) => {
      const policy = await permissions(c, id),
        rows = (
          await c.query(
            `SELECT i.*,s.source_id,s.candidate,
               CASE WHEN e.evidence #>> '{fields,attributes}'='present'
                 THEN e.evidence #>> '{attributes,model}' END AS structured_model
             FROM query_calculation_inputs i JOIN query_snapshot_records s
               ON s.query_id=i.query_id AND s.sale_event_id=i.sale_event_id
             LEFT JOIN listing_record_evidence e
               ON (e.sale_event_id,e.listing_id,e.source_id,e.observation_id)=(s.sale_event_id,s.listing_id,s.source_id,s.observation_id)
             WHERE i.query_id=$1 ORDER BY i.sale_event_id`,
            [id],
          )
        ).rows;
      if (rows.length > 2000) fail("export_too_large", 422, "Export exceeds the synchronous row limit.");
      if (rows.some((r) => !canPrice(policy.get(r.source_id))))
        fail("forbidden", 403, "Current field rights do not allow complete export.");
      const valid = new Set(rows.map((r) => r.sale_event_id));
      if (ids.some((v) => !valid.has(v)))
        fail("invalid_parameter", 400, "An excluded event is not in the complete price input.");
      const excluded = new Set(ids),
        selected = rows.filter((r) => !excluded.has(r.sale_event_id)),
        items = selected.map((r) => {
          const p = r.candidate as Candidate,
            a = policy.get(r.source_id) ?? new Set<ResearchField>();
          return {
            sale_event_id: r.sale_event_id,
            title: a.has("title") ? (p.title ?? null) : null,
            condition: a.has("condition") && isStandardCondition(p.condition) ? p.condition : null,
            item_price_cents: p.currency === "USD" ? p.itemCents : (p.usdConversion?.itemCents ?? null),
            observed_shipping_cents:
              p.currency === "USD" ? p.shippingCents : (p.usdConversion?.shippingCents ?? null),
            price_usd_cents: Number(r.price_usd_cents),
            currency: "USD",
            sale_format: r.sale_format,
            sold_at: p.time.precision === "unknown" ? null : p.time.value,
            sold_date_precision: p.time.precision,
          };
        });
      const document = {
        schema: "soldbench.research-export.v1",
        query_id: id,
        candidate_set_hash: q.candidate_set_hash,
        view: input.view,
        user_modified: input.view === "adjusted",
        excluded_sale_event_ids: ids,
        data_mode: "synthetic_fixture",
        currency: "USD",
        price_basis: q.price_basis,
        as_of: q.as_of.toISOString(),
        data_as_of: q.data_as_of.toISOString(),
        exported_at: now.toISOString(),
        freshness_state: state.freshness,
        result_mode: history ? "history" : "current",
        versions: {
          engine: q.engine_version,
          cleaner: q.cleaner_version,
          normalizer: q.normalizer_version,
          billing: q.billing_policy_version,
        },
        completeness: {
          is_complete: true,
          original_price_input_count: rows.length,
          exported_count: items.length,
          presentation_limit: q.requested_limit,
          market_coverage: "unknown",
        },
        price_summary: {
          n_price_verified: items.length,
          ...distribution(items.map((r) => r.price_usd_cents)),
        },
        ...(allSourcesAllow(policy, "attributes")
          ? { comparison_scope: comparisonScope(selected.map((r) => r.structured_model)) }
          : {}),
        original_stats: q.stats,
        columns: {
          price_usd_cents: "USD integer cents at the selected price_basis",
          observed_shipping_cents: "Observed source shipping, not tax or destination shipping quotes",
          sold_at: "Original frozen sold time, never replaced with collection time",
        },
        items,
      };
      let body: string;
      if (input.format === "json") body = JSON.stringify(document);
      else {
        const { items: _items, ...metadata } = document,
          columns = [
            "query_id",
            "candidate_set_hash",
            "view",
            "user_modified",
            "sale_event_id",
            "title",
            "condition",
            "item_price_cents",
            "observed_shipping_cents",
            "price_usd_cents",
            "currency",
            "sale_format",
            "sold_at",
            "sold_date_precision",
            "metadata_json",
          ];
        const data = items.length ? items : [null];
        body = `${[
          columns.map(csv).join(","),
          ...data.map((r) =>
            columns
              .map((k) =>
                csv(
                  k === "metadata_json"
                    ? JSON.stringify(metadata)
                    : k in document
                      ? document[k as keyof typeof document]
                      : r?.[k as keyof typeof r],
                ),
              )
              .join(","),
          ),
        ].join("\r\n")}\r\n`;
      }
      if (Buffer.byteLength(body) > 5 * 1024 * 1024)
        fail("export_too_large", 422, "Export exceeds the synchronous byte limit.");
      return {
        body,
        contentType: input.format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        filename: `soldbench-${id}-${input.view}.${input.format}`,
      };
    });
  }
}
export function csv(value: unknown) {
  const s = String(value ?? "");
  let index = 0,
    control = false;
  for (; index < s.length; index++) {
    const char = s[index] ?? "",
      code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      control = true;
      continue;
    }
    if (/\s/u.test(char)) continue;
    break;
  }
  return `"${(control || /^[=+\-@]/.test(s.slice(index)) ? "'" : "") + s.replaceAll('"', '""')}"`;
}
