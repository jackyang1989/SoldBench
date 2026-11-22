import type { AuthService } from "@soldbench/auth";
import {
  BestOfferVerificationService,
  MAX_BEST_OFFER_VERIFY_ITEMS,
  type QueryService,
} from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const verifyShape = z.strictObject({
  sale_event_ids: z.array(z.string().regex(UUID_RE)).min(1).max(MAX_BEST_OFFER_VERIFY_ITEMS).optional(),
  ttl_minutes: z.int().min(1).max(120).optional(),
  max_items: z.int().min(1).max(MAX_BEST_OFFER_VERIFY_ITEMS).optional(),
});

const revisionShape = z.strictObject({
  trigger_kind: z.literal("best_offer_verification").optional(),
});

/**
 * Mount V1.5 Best Offer post-lookup verification and revision endpoints (`/v1/sold/:id/best-offers*`, `/v1/sold/:id/revisions`).
 */
export function mountBestOffers(
  app: Hono<Env>,
  config: Config,
  auth?: AuthService,
  query?: QueryService,
  bestOffers?: BestOfferVerificationService,
) {
  const serviceInstance = bestOffers ?? (query ? new BestOfferVerificationService(query) : null);

  const service = () => {
    if (!query || !serviceInstance)
      throw new AppError("service_unavailable", 503, "Best Offer verification service is not configured.");
    return { query, bestOffers: serviceInstance };
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

  const id = (value: string | undefined) => {
    if (typeof value !== "string" || !UUID_RE.test(value))
      throw new AppError("invalid_parameter", 400, "Invalid identifier.");
    return value;
  };

  const parse = async <T>(c: Context<Env>, schema: z.ZodType<T>) => {
    if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json")
      throw new AppError("invalid_parameter", 415, "Use application/json.");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError("invalid_parameter", 400, "Invalid JSON.");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError("invalid_parameter", 400, "Invalid request fields.");
    return parsed.data;
  };

  app.use("/v1/sold/:id/best-offers/verify", bodyLimit({ maxSize: 32768 }));
  app.use("/v1/sold/:id/revisions", bodyLimit({ maxSize: 8192 }));

  app.get("/v1/sold/:id/best-offers", async (c) => {
    const actor = await identity(c, "sold:read", false);
    const res = await service().bestOffers.status(actor, id(c.req.param("id")));
    return c.json({
      data: res.status,
      meta: {
        request_id: c.get("requestId"),
        credits_charged: 0,
        revision_count: res.revisionCount,
        latest_revision_number: res.latestRevisionNumber,
      },
    });
  });

  app.post("/v1/sold/:id/best-offers/verify", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, verifyShape);
    const res = await service().bestOffers.requestVerification(actor, id(c.req.param("id")), body);
    return c.json(
      {
        data: res.status,
        meta: {
          request_id: c.get("requestId"),
          credits_charged: res.creditsCharged,
          queued_now: res.queuedNow,
          reused_existing: res.reusedExisting,
          revision_count: res.revisionCount,
          latest_revision_number: res.latestRevisionNumber,
        },
      },
      202,
    );
  });

  app.post("/v1/sold/:id/revisions", async (c) => {
    const actor = await identity(c, "sold:read", true);
    await parse(c, revisionShape);
    const res = await service().bestOffers.createRevision(actor, id(c.req.param("id")));
    return c.json(
      {
        data: res.revision,
        meta: {
          request_id: c.get("requestId"),
          credits_charged: res.creditsCharged,
          reused: res.reused,
        },
      },
      res.reused ? 200 : 201,
    );
  });
}
