import { isDeepStrictEqual } from "node:util";
import type { Identity } from "@soldbench/auth";
import { distribution } from "@soldbench/core";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import type { QueryService } from "./index.ts";

type SavedRow = {
  id: string;
  query_id: string;
  name: string;
  excluded_sale_event_ids: string[];
  created_at: Date;
  updated_at: Date;
  version: number;
};
type ViewMode = "authoritative" | "adjusted";
const fail = (code: string, status: number, message: string): never => {
  throw new AppError(code, status, message);
};
const columns = "id,query_id,name,excluded_sale_event_ids,created_at,updated_at,version";
const view = (row: SavedRow) => ({
  ...row,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});
const summary = (row: SavedRow) => {
  const { excluded_sale_event_ids, ...reference } = view(row);
  return { ...reference, excluded_count: excluded_sale_event_ids.length };
};
const matchScope = (filters: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(filters).filter(
      ([key]) => !["limit", "window_days", "price_basis", "allow_stale"].includes(key),
    ),
  );

export class SavedResearch {
  constructor(private readonly query: QueryService) {}

  private async owner(c: Transaction, actor: Identity) {
    if (!actor.sessionId || actor.keyId)
      fail("forbidden", 403, "Saved research requires an account session.");
    return this.query.owner(c, actor);
  }

  private async find(c: Transaction, actor: Identity, id: string) {
    const row = (
      await c.query<SavedRow>(`SELECT ${columns} FROM saved_research WHERE user_id=$1 AND id=$2`, [
        actor.userId,
        id,
      ])
    ).rows[0];
    if (!row) return fail("not_found", 404, "Saved research not found.");
    return row;
  }

  async list(actor: Identity, term: string) {
    return transaction(this.query.db, async (c) => {
      await this.owner(c, actor);
      const rows = (
        await c.query<SavedRow>(
          `SELECT ${columns} FROM saved_research WHERE user_id=$1 AND strpos(name_key,$2)>0
          ORDER BY updated_at DESC,id LIMIT 100`,
          [actor.userId, term.normalize("NFKC").toLowerCase()],
        )
      ).rows;
      return rows.map(summary);
    });
  }

  async save(actor: Identity, queryId: string, name: string, excluded: string[]) {
    return transaction(this.query.db, async (c) => {
      const now = await this.owner(c, actor);
      const { q } = await this.query.readDeliveredSnapshot(c, actor, queryId);
      const choices = [...excluded].sort();
      if (choices.length) {
        const inputs = await this.query.calculationLocked(c, q);
        const ids = new Set(inputs.items.map((item) => item.sale_event_id));
        if (choices.some((id) => !ids.has(id)))
          fail("invalid_parameter", 400, "Excluded sales must belong to the complete price input.");
      }
      const nameKey = name.normalize("NFKC").toLowerCase();
      const existing = (
        await c.query<SavedRow>(`SELECT ${columns} FROM saved_research WHERE user_id=$1 AND name_key=$2`, [
          actor.userId,
          nameKey,
        ])
      ).rows[0];
      if (existing) {
        if (
          existing.query_id !== queryId ||
          existing.name !== name ||
          !isDeepStrictEqual(existing.excluded_sale_event_ids, choices)
        )
          fail("state_conflict", 409, "This saved name is already in use.");
        return summary(existing);
      }
      const capacity = await c.query("SELECT count(*)::int AS count FROM saved_research WHERE user_id=$1", [
        actor.userId,
      ]);
      if (capacity.rows[0].count >= 100)
        fail("state_conflict", 409, "Remove a saved view before adding another.");
      const saved = (
        await c.query<SavedRow>(
          `INSERT INTO saved_research(user_id,query_id,name,name_key,excluded_sale_event_ids,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING ${columns}`,
          [actor.userId, queryId, name, nameKey, choices, now],
        )
      ).rows[0];
      if (!saved) throw new Error("saved_research_insert_missing");
      return summary(saved);
    });
  }

  async open(actor: Identity, id: string) {
    return transaction(this.query.db, async (c) => {
      await this.owner(c, actor);
      const row = await this.find(c, actor, id);
      const { q } = await this.query.readDeliveredSnapshot(c, actor, row.query_id);
      if (row.excluded_sale_event_ids.length) await this.query.calculationLocked(c, q);
      return view(row);
    });
  }

  async rename(actor: Identity, id: string, name: string, version: number) {
    return transaction(this.query.db, async (c) => {
      const now = await this.owner(c, actor);
      const row = await this.find(c, actor, id);
      if (row.version !== version) fail("state_conflict", 409, "The saved view changed.");
      if (row.name === name) return summary(row);
      const nameKey = name.normalize("NFKC").toLowerCase();
      if (
        (
          await c.query("SELECT 1 FROM saved_research WHERE user_id=$1 AND name_key=$2 AND id<>$3", [
            actor.userId,
            nameKey,
            id,
          ])
        ).rowCount
      )
        fail("state_conflict", 409, "This saved name is already in use.");
      const updated = (
        await c.query<SavedRow>(
          `UPDATE saved_research SET name=$3,name_key=$4,updated_at=$5,version=version+1
          WHERE user_id=$1 AND id=$2 RETURNING ${columns}`,
          [actor.userId, id, name, nameKey, now],
        )
      ).rows[0];
      if (!updated) throw new Error("saved_research_update_missing");
      return summary(updated);
    });
  }

  async remove(actor: Identity, id: string) {
    return transaction(this.query.db, async (c) => {
      await this.owner(c, actor);
      await c.query("DELETE FROM saved_research WHERE user_id=$1 AND id=$2", [actor.userId, id]);
    });
  }

  private async side(c: Transaction, actor: Identity, row: SavedRow, mode?: ViewMode) {
    const viewMode = mode ?? (row.excluded_sale_event_ids.length ? "adjusted" : "authoritative");
    const base = { id: row.id, name: row.name, query_id: row.query_id, view: viewMode };
    try {
      const { q, state } = await this.query.readDeliveredSnapshot(c, actor, row.query_id);
      const calculation = await this.query.calculationLocked(c, q);
      const excluded = new Set(viewMode === "adjusted" ? row.excluded_sale_event_ids : []);
      const prices = calculation.items
        .filter((item) => !excluded.has(item.sale_event_id))
        .map((item) => item.price_usd_cents);
      return {
        scope: matchScope(q.filters),
        data: {
          ...base,
          available: true as const,
          marketplace: q.marketplace as string,
          currency: "USD" as const,
          price_basis: q.price_basis as string,
          window_days: q.window_days as number,
          data_as_of: q.data_as_of.toISOString() as string,
          freshness: state.freshness,
          source_scope: q.source_scope as string[],
          coverage: "unknown" as const,
          n_price_verified: prices.length,
          excluded_count: excluded.size,
          ...distribution(prices),
        },
      };
    } catch (error) {
      if (!(error instanceof AppError) || ![403, 409, 410, 503].includes(error.status)) throw error;
      return { scope: null, data: { ...base, available: false as const } };
    }
  }

  async compare(actor: Identity, leftId: string, rightId: string, leftView?: ViewMode, rightView?: ViewMode) {
    return transaction(this.query.db, async (c) => {
      await this.owner(c, actor);
      const left = await this.side(c, actor, await this.find(c, actor, leftId), leftView);
      const right = await this.side(c, actor, await this.find(c, actor, rightId), rightView);
      const a = left.data,
        b = right.data;
      const reasons =
        !a.available || !b.available
          ? ["unavailable"]
          : [
              ...(a.marketplace !== b.marketplace || a.currency !== b.currency ? ["marketplace"] : []),
              ...(a.price_basis !== b.price_basis ? ["price_basis"] : []),
              ...(a.window_days !== b.window_days ? ["window"] : []),
              ...(!isDeepStrictEqual(a.source_scope, b.source_scope) ||
              !isDeepStrictEqual(left.scope, right.scope)
                ? ["scope"]
                : []),
              ...(a.median_cents === null || b.median_cents === null ? ["sample_size"] : []),
            ];
      const delta =
        !reasons.length && a.available && b.available && a.median_cents !== null && b.median_cents !== null
          ? b.median_cents - a.median_cents
          : null;
      return { left: a, right: b, differences: reasons, median_delta_cents: delta };
    });
  }
}
