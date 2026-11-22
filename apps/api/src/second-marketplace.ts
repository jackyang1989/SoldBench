import type { AuthService } from "@soldbench/auth";
import { type QueryService, SecondMarketplaceService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";

type Env = { Variables: { requestId: string } };

/**
 * Mounts V2 second-marketplace onboarding catalog, `mercari_us` sold-vs-active preview,
 * and fail-closed private primary-image proxy routes (`TASK-052`, `AT-069`).
 */
export function mountSecondMarketplace(
  app: Hono<Env>,
  _config: Config,
  auth?: AuthService,
  query?: QueryService,
  secondMarketplace?: SecondMarketplaceService,
) {
  const svc = secondMarketplace ?? (query ? new SecondMarketplaceService(query) : null);

  const service = () => {
    if (!query || !svc) {
      throw new AppError("service_unavailable", 503, "Second marketplace service is not configured.");
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

  app.get("/v1/marketplaces", async (c) => {
    return c.json({ data: await service().svc.listMarketplaces(), meta: meta(c) });
  });

  app.get("/v1/marketplaces/:marketplace/preview", async (c) => {
    const actor = await identity(c, "sold:read");
    const q = c.req.query("q") ?? "";
    const priceBasis = c.req.query("price_basis");
    const condition = c.req.query("condition");
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      if (!/^\d+$/.test(rawLimit)) {
        throw new AppError("invalid_parameter", 400, "limit must be an integer between 1 and 200.");
      }
      limit = Number(rawLimit);
    }
    const data = await service().svc.queryMarketplace(actor, {
      marketplace: c.req.param("marketplace"),
      q,
      price_basis: priceBasis,
      condition,
      limit,
    });
    return c.json({ data, meta: meta(c) });
  });

  app.get("/v1/marketplaces/:marketplace/records/:record_id/image", async (c) => {
    const actor = await identity(c, "sold:read");
    const img = await service().svc.getRecordImage(
      actor,
      c.req.param("marketplace"),
      c.req.param("record_id"),
    );
    return c.body(new Uint8Array(img.bytes), 200, {
      "Content-Type": img.mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${img.sha256}"`,
    });
  });
}
