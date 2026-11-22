import type { AuthService } from "@soldbench/auth";
import { AuctionsVerticalService, type QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";

type Env = { Variables: { requestId: string } };

/**
 * Mounts V2 auction sales vertical routes (`/v1/auctions/*`) keeping hammer price,
 * buyer's premium, and all-in totals strictly separated and traceable (`TASK-054`, `AT-071`).
 */
export function mountAuctionsVertical(
  app: Hono<Env>,
  _config: Config,
  auth?: AuthService,
  query?: QueryService,
  auctionsVertical?: AuctionsVerticalService,
) {
  const svc = auctionsVertical ?? (query ? new AuctionsVerticalService(query) : null);

  const service = () => {
    if (!query || !svc) {
      throw new AppError("service_unavailable", 503, "Auctions vertical service is not configured.");
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

  app.get("/v1/auctions/houses", async (c) => {
    return c.json({ data: await service().svc.listAuctionHouses(), meta: meta(c) });
  });

  app.get("/v1/auctions/:house/lots", async (c) => {
    const actor = await identity(c, "sold:read");
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      if (!/^\d+$/.test(rawLimit)) {
        throw new AppError("invalid_parameter", 400, "limit must be an integer between 1 and 200.");
      }
      limit = Number(rawLimit);
    }
    const data = await service().svc.queryAuctionLots(actor, {
      house: c.req.param("house"),
      q: c.req.query("q") ?? "",
      price_basis: c.req.query("price_basis"),
      grading_company: c.req.query("grading_company"),
      grade_value: c.req.query("grade_value"),
      limit,
    });
    return c.json({ data, meta: meta(c) });
  });

  app.get("/v1/auctions/:house/lots/:lot_id/image", async (c) => {
    const actor = await identity(c, "sold:read");
    const img = await service().svc.getLotImage(actor, c.req.param("house"), c.req.param("lot_id"));
    return c.body(new Uint8Array(img.bytes), 200, {
      "Content-Type": img.mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${img.sha256}"`,
    });
  });
}
