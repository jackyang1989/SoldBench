import type { AuthService } from "@soldbench/auth";
import {
  AlertWebhookService,
  type QueryService,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const createWatchlistShape = z.strictObject({
  name: z.string().trim().min(1).max(120),
  query: z.record(z.string(), z.unknown()).default({}),
  trigger_kind: z.enum(["price_below", "price_above", "low_credits", "job_completed"]),
  threshold_cents: z.int().nonnegative().nullable().optional(),
  low_credits_threshold: z.int().nonnegative().nullable().optional(),
  schedule_mode: z.enum(["passive_reuse", "scheduled_refresh"]),
  billing_consent_accepted: z.boolean().optional(),
  max_credits_per_month: z.int().min(0).max(1000).optional(),
  locale: z.enum(["en", "zh-CN"]).optional(),
});

const patchWatchlistShape = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "paused"]).optional(),
  locale: z.enum(["en", "zh-CN"]).optional(),
  threshold_cents: z.int().nonnegative().nullable().optional(),
  low_credits_threshold: z.int().nonnegative().nullable().optional(),
  schedule_mode: z.enum(["passive_reuse", "scheduled_refresh"]).optional(),
  billing_consent_accepted: z.boolean().optional(),
  max_credits_per_month: z.int().min(0).max(1000).optional(),
});

const unsubscribeShape = z.strictObject({
  token: z.string().min(16).max(256),
});

const createWebhookShape = z.strictObject({
  name: z.string().trim().min(1).max(120),
  target_url: z.string().min(8).max(2048),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(3),
});

const patchWebhookShape = z.strictObject({
  status: z.enum(["active", "paused", "disabled"]).optional(),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(3).optional(),
});

/**
 * Mount V1.5 saved watchlists, billing-consented alert rules, and signed webhooks (`/v1/watchlists*`, `/v1/webhooks*`, `/v1/alerts/unsubscribe`).
 */
export function mountAlerts(
  app: Hono<Env>,
  config: Config,
  auth?: AuthService,
  query?: QueryService,
  alerts?: AlertWebhookService,
) {
  const alertsService = alerts ?? (query ? new AlertWebhookService(query) : null);

  const service = () => {
    if (!query || !alertsService)
      throw new AppError("service_unavailable", 503, "Alerts and webhook service is not configured.");
    return { query, alerts: alertsService };
  };

  const identity = async (c: Context<Env>, scope = "sold:read", write = false) => {
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

  const meta = (c: Context<Env>, credits = 0) => ({
    request_id: c.get("requestId"),
    credits_charged: credits,
  });

  app.use("/v1/watchlists", bodyLimit({ maxSize: 32768 }));
  app.use("/v1/watchlists/*", bodyLimit({ maxSize: 32768 }));
  app.use("/v1/webhooks", bodyLimit({ maxSize: 16384 }));
  app.use("/v1/webhooks/*", bodyLimit({ maxSize: 16384 }));
  app.use("/v1/alerts/*", bodyLimit({ maxSize: 8192 }));

  app.get("/v1/watchlists", async (c) => {
    const actor = await identity(c, "sold:read", false);
    return c.json({ data: await service().alerts.listWatchlists(actor), meta: meta(c) });
  });

  app.post("/v1/watchlists", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, createWatchlistShape);
    const res = await service().alerts.createWatchlist(actor, body);
    return c.json(
      {
        data: { watchlist: res.watchlist, unsubscribe_token: res.unsubscribe_token },
        meta: meta(c, res.credits_charged),
      },
      201,
    );
  });

  app.patch("/v1/watchlists/:id", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, patchWatchlistShape);
    return c.json({
      data: await service().alerts.updateWatchlist(actor, id(c.req.param("id")), body),
      meta: meta(c),
    });
  });

  app.delete("/v1/watchlists/:id", async (c) => {
    const actor = await identity(c, "sold:read", true);
    await service().alerts.deleteWatchlist(actor, id(c.req.param("id")));
    return c.body(null, 204);
  });

  app.post("/v1/watchlists/:id/evaluate", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const res = await service().alerts.evaluateWatchlist(actor, id(c.req.param("id")));
    return c.json({ data: res, meta: meta(c, res.credits_charged) });
  });

  app.post("/v1/alerts/unsubscribe", async (c) => {
    const body = await parse(c, unsubscribeShape);
    return c.json({ data: await service().alerts.unsubscribeByToken(body.token), meta: meta(c) });
  });

  app.get("/v1/webhooks", async (c) => {
    const actor = await identity(c, "sold:read", false);
    return c.json({ data: await service().alerts.listWebhookEndpoints(actor), meta: meta(c) });
  });

  app.post("/v1/webhooks", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, createWebhookShape);
    const res = await service().alerts.createWebhookEndpoint(actor, {
      ...body,
      event_types: body.event_types as WebhookEventType[],
    });
    return c.json({ data: res, meta: meta(c) }, 201);
  });

  app.patch("/v1/webhooks/:id", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, patchWebhookShape);
    return c.json({
      data: await service().alerts.updateWebhookEndpoint(actor, id(c.req.param("id")), {
        ...body,
        event_types: body.event_types as WebhookEventType[] | undefined,
      }),
      meta: meta(c),
    });
  });

  app.delete("/v1/webhooks/:id", async (c) => {
    const actor = await identity(c, "sold:read", true);
    await service().alerts.deleteWebhookEndpoint(actor, id(c.req.param("id")));
    return c.body(null, 204);
  });

  app.get("/v1/webhooks/deliveries", async (c) => {
    const actor = await identity(c, "sold:read", false);
    return c.json({ data: await service().alerts.listDeliveries(actor), meta: meta(c) });
  });
}
