import type { AuthService } from "@soldbench/auth";
import { CardsVerticalService, type QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";

type Env = { Variables: { requestId: string } };

/**
 * Mounts V2 structured TCG & graded cards routes (`/v1/cards/products*`) with strict
 * product ID identity, raw-vs-graded isolation, and separated grading population census (`TASK-053`, `AT-070`).
 */
export function mountCardsVertical(
  app: Hono<Env>,
  _config: Config,
  auth?: AuthService,
  query?: QueryService,
  cardsVertical?: CardsVerticalService,
) {
  const svc = cardsVertical ?? (query ? new CardsVerticalService(query) : null);

  const service = () => {
    if (!query || !svc) {
      throw new AppError("service_unavailable", 503, "Cards vertical service is not configured.");
    }
    return { query, svc };
  };

  const identity = async (c: Context<Env>, scope = "sold:read") => {
    if (!auth) throw new AppError("unauthenticated", 401, "Sign in or provide an API key.");
    const bearer = c.req.header("Authorization");
    const cookie = getCookie(c, "soldbench_session");
    if (bearer && cookie) throw new AppError("invalid_parameter", 400, "Use one authentication method.");
    if (bearer) {
      const token = /^Bearer (\S+)$/.exec(bearer)?.[1];
      if (!token) throw new AppError("unauthenticated", 401, "Invalid authentication header.");
      const actor = await auth.bearerIdentity(token, scope);
      await service().query.rate(actor);
      return actor;
    }
    const actor = await auth.sessionIdentity(cookie ?? "");
    await service().query.rate(actor);
    return actor;
  };

  const meta = (c: Context<Env>) => ({
    request_id: c.get("requestId"),
    credits_charged: 0 as const,
  });

  app.get("/v1/cards/products", async (c) => {
    const items = await service().svc.listCardProducts({
      tcg_game: c.req.query("tcg_game"),
      set_code: c.req.query("set_code"),
      card_number: c.req.query("card_number"),
      edition: c.req.query("edition"),
      q: c.req.query("q"),
    });
    return c.json({ data: items, meta: meta(c) });
  });

  app.get("/v1/cards/products/:product_id/valuation", async (c) => {
    const actor = await identity(c, "sold:read");
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      if (!/^\d+$/.test(rawLimit)) {
        throw new AppError("invalid_parameter", 400, "limit must be an integer between 1 and 200.");
      }
      limit = Number(rawLimit);
    }
    const result = await service().svc.queryCardValuation(actor, {
      product_id: c.req.param("product_id"),
      grading_state: c.req.query("grading_state") ?? "graded",
      grading_company: c.req.query("grading_company"),
      grade_value: c.req.query("grade_value"),
      raw_condition: c.req.query("raw_condition"),
      edition: c.req.query("edition"),
      price_basis: c.req.query("price_basis"),
      limit,
    });
    return c.json({ data: result, meta: meta(c) });
  });
}
