import type { AuthService } from "@soldbench/auth";
import { ArchiveHistoryService, MAX_HISTORY_WINDOW_DAYS, type QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const exportHistoryShape = z.strictObject({
  format: z.enum(["csv", "json"]),
  q: z.string().min(1).max(120),
  marketplace: z.string().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  condition: z.string().optional(),
  price_basis: z.enum(["item", "item_plus_observed_shipping"]).optional(),
  sale_format: z.enum(["fixed_price", "auction", "best_offer"]).optional(),
  min_price_cents: z.int().nonnegative().optional(),
  max_price_cents: z.int().nonnegative().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  window_days: z.int().min(1).max(MAX_HISTORY_WINDOW_DAYS).optional(),
  from_date: z.string().min(1).max(64).optional(),
  to_date: z.string().min(1).max(64).optional(),
  allow_partial: z.boolean().optional(),
  granularity: z.enum(["day", "week", "month"]).optional(),
});

/**
 * Mount V1.1 approved history archive & coverage API endpoints (`/v1/history*`).
 */
export function mountHistory(app: Hono<Env>, config: Config, auth?: AuthService, query?: QueryService) {
  const history = query ? new ArchiveHistoryService(query) : null;

  const service = () => {
    if (!query || !history)
      throw new AppError("service_unavailable", 503, "History archive service is not configured.");
    return { query, history };
  };

  const identity = async (c: Context<Env>, scope = "sold:read", write = false) => {
    if (!auth) throw new AppError("unauthenticated", 401, "Sign in or provide an API key.");
    const bearer = c.req.header("Authorization");
    const cookie = getCookie(c, "soldbench_session");
    if (bearer && cookie) throw new AppError("invalid_parameter", 400, "Use one authentication method.");
    if (bearer) {
      const token = /^Bearer (\S+)$/.exec(bearer)?.[1];
      if (!token) throw new AppError("unauthenticated", 401, "Invalid authentication header.");
      const actor = await auth.keyIdentity(token, scope);
      await service().query.rate(actor);
      return actor;
    }
    if (write) {
      if (c.req.header("Origin") !== config.origin)
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      await auth.assertCsrf(cookie ?? "", c.req.header("X-CSRF-Token") ?? "");
    }
    const actor = await auth.sessionIdentity(cookie ?? "");
    await service().query.rate(actor);
    return actor;
  };

  app.get("/v1/history/coverage", async (c) => {
    const actor = await identity(c, "sold:read", false);
    const data = await service().history.coverage(actor, new URL(c.req.url).searchParams);
    return c.json({
      data,
      meta: { request_id: c.get("requestId"), credits_charged: 0 },
    });
  });

  app.get("/v1/history", async (c) => {
    const actor = await identity(c, "sold:read", false);
    const res = await service().history.search(actor, new URL(c.req.url).searchParams);
    return c.json({
      data: res.data,
      meta: { request_id: c.get("requestId"), credits_charged: 0, ...res.meta },
    });
  });

  app.use("/v1/history/export", bodyLimit({ maxSize: 32768 }));
  app.post("/v1/history/export", async (c) => {
    const actor = await identity(c, "sold:read", true);
    if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json")
      throw new AppError("invalid_parameter", 415, "Use application/json.");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError("invalid_parameter", 400, "Invalid JSON.");
    }
    const parsed = exportHistoryShape.safeParse(raw);
    if (!parsed.success) throw new AppError("invalid_parameter", 400, "Invalid history export parameters.");

    const { format, attributes, ...rest } = parsed.data;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) params.set(k, String(v));
    }
    if (attributes) {
      for (const [attr, val] of Object.entries(attributes)) {
        params.set(`attr_${attr}`, val);
      }
    }

    const exported = await service().history.export(actor, params, format);
    c.header("Content-Type", exported.contentType);
    c.header("Content-Disposition", `attachment; filename="${exported.filename}"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(exported.body);
  });
}
