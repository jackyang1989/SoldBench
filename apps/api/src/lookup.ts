import type { AuthService } from "@soldbench/auth";
import { BARCODE_FORMATS, LookupInputService, type QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const createImageLookupShape = z.strictObject({
  image_base64: z.string().min(1).max(8_000_000),
  mime_type: z.string().trim().min(3).max(80).optional(),
  filename: z.string().trim().min(1).max(160).optional(),
  retention_hours: z.int().min(1).max(24).optional(),
});

const createBarcodeLookupShape = z.strictObject({
  barcode: z.string().trim().min(4).max(32),
  format: z.enum(BARCODE_FORMATS).optional(),
  retention_hours: z.int().min(1).max(24).optional(),
});

const confirmLookupShape = z.strictObject({
  candidate_id: z.string().regex(UUID_RE).optional(),
  override_q: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(60).nullable().optional(),
  brand: z.string().trim().min(1).max(120).nullable().optional(),
  model: z.string().trim().min(1).max(120).nullable().optional(),
  condition: z.string().trim().min(1).max(40).nullable().optional(),
  window_days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).optional(),
  price_basis: z.enum(["item", "item_plus_observed_shipping"]).optional(),
  limit: z.int().min(1).max(200).optional(),
  allow_stale: z.boolean().optional(),
  sale_format: z.enum(["fixed_price", "auction", "best_offer"]).optional(),
});

/**
 * Mount V1.5 image upload & barcode lookup identification and confirmation routes (`/v1/lookup/*`).
 */
export function mountLookup(
  app: Hono<Env>,
  config: Config,
  auth?: AuthService,
  query?: QueryService,
  lookup?: LookupInputService,
) {
  const lookupService = lookup ?? (query ? new LookupInputService(query) : null);

  const service = () => {
    if (!query || !lookupService)
      throw new AppError("service_unavailable", 503, "Image and barcode lookup service is not configured.");
    return { query, lookup: lookupService };
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

  app.use("/v1/lookup/image", bodyLimit({ maxSize: 8 * 1024 * 1024 }));
  app.use("/v1/lookup/barcode", bodyLimit({ maxSize: 32768 }));
  app.use("/v1/lookup/sessions/*", bodyLimit({ maxSize: 65536 }));

  app.post("/v1/lookup/image", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, createImageLookupShape);
    const session = await service().lookup.createImageLookup(actor, body);
    return c.json({ data: session, meta: meta(c, 0) }, 201);
  });

  app.post("/v1/lookup/barcode", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, createBarcodeLookupShape);
    const session = await service().lookup.createBarcodeLookup(actor, body);
    return c.json({ data: session, meta: meta(c, 0) }, 201);
  });

  app.get("/v1/lookup/sessions", async (c) => {
    const actor = await identity(c, "sold:read", false);
    const sessions = await service().lookup.listSessions(actor);
    return c.json({ data: sessions, meta: meta(c, 0) });
  });

  app.get("/v1/lookup/sessions/:id", async (c) => {
    const actor = await identity(c, "sold:read", false);
    const session = await service().lookup.getSession(actor, id(c.req.param("id")));
    return c.json({ data: session, meta: meta(c, 0) });
  });

  app.post("/v1/lookup/sessions/:id/confirm", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
    const body = await parse(c, confirmLookupShape);
    const confirmed = await service().lookup.confirmSession(
      actor,
      id(c.req.param("id")),
      body,
      idempotencyKey,
    );
    return c.json(
      {
        data: {
          session: confirmed.session,
          submission: {
            query_id: confirmed.submission.queryId,
            job_id: confirmed.submission.jobId,
            reused: confirmed.submission.reused,
            status: confirmed.submission.status,
            expires_at: confirmed.submission.expiresAt,
          },
          replayed: confirmed.replayed,
        },
        meta: meta(c, 0),
      },
      confirmed.submission.status === "completed" ? 200 : 202,
    );
  });

  app.delete("/v1/lookup/sessions/:id", async (c) => {
    const actor = await identity(c, "sold:read", true);
    await service().lookup.deleteSession(actor, id(c.req.param("id")));
    return c.body(null, 204);
  });
}
