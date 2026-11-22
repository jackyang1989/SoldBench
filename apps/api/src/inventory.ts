import type { AuthService } from "@soldbench/auth";
import { InventoryValuationService, MAX_INVENTORY_ITEMS, type QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const previewShape = z
  .strictObject({
    items: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_INVENTORY_ITEMS).optional(),
    csv: z.string().min(1).max(65536).optional(),
  })
  .refine((v) => (v.items !== undefined) !== (v.csv !== undefined));

const createShape = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    items: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_INVENTORY_ITEMS).optional(),
    csv: z.string().min(1).max(65536).optional(),
    billing_consent_accepted: z.boolean().optional(),
  })
  .refine((v) => (v.items !== undefined) !== (v.csv !== undefined));

const cancelShape = z.strictObject({
  version: z.int().positive(),
});

const revalueShape = z.strictObject({
  billing_consent_accepted: z.boolean(),
  name: z.string().trim().min(1).max(120).optional(),
  window_days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).optional(),
});

const exportShape = z.strictObject({
  format: z.enum(["csv", "json"]),
});

/**
 * Mount V1.5 inventory valuation endpoints (`/v1/inventory/valuations*`).
 */
export function mountInventory(
  app: Hono<Env>,
  config: Config,
  auth?: AuthService,
  query?: QueryService,
  inventory?: InventoryValuationService,
) {
  const serviceInstance = inventory ?? (query ? new InventoryValuationService(query) : null);

  const service = () => {
    if (!query || !serviceInstance)
      throw new AppError("service_unavailable", 503, "Inventory valuation service is not configured.");
    return { query, inventory: serviceInstance };
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

  app.use("/v1/inventory/valuations", bodyLimit({ maxSize: 65536 }));
  app.use("/v1/inventory/valuations/*", bodyLimit({ maxSize: 65536 }));

  app.post("/v1/inventory/valuations/preview", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, previewShape);
    return c.json({ data: await service().inventory.preview(actor, body), meta: meta(c, 0) });
  });

  app.post("/v1/inventory/valuations", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, createShape);
    const res = await service().inventory.createValuation(actor, body, c.req.header("Idempotency-Key"));
    return c.json({ data: res, meta: meta(c, 0) }, 201);
  });

  app.get("/v1/inventory/valuations", async (c) => {
    const actor = await identity(c, "sold:read", false);
    return c.json({ data: await service().inventory.listValuations(actor), meta: meta(c, 0) });
  });

  app.get("/v1/inventory/valuations/:id", async (c) => {
    const actor = await identity(c, "sold:read", false);
    return c.json({
      data: await service().inventory.getValuation(actor, id(c.req.param("id"))),
      meta: meta(c, 0),
    });
  });

  app.post("/v1/inventory/valuations/:id/claim", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const res = await service().inventory.claimValuation(
      actor,
      id(c.req.param("id")),
      c.req.header("Idempotency-Key"),
      c.get("requestId"),
    );
    return c.json({ data: res, meta: meta(c, res.claim.credits_charged_now) });
  });

  app.post("/v1/inventory/valuations/:id/cancel", async (c) => {
    const actor = await identity(c, "jobs:read", true);
    const body = await parse(c, cancelShape);
    const updated = await service().inventory.cancelValuation(
      actor,
      id(c.req.param("id")),
      body.version,
      c.req.header("Idempotency-Key"),
    );
    return c.json({ data: updated, meta: meta(c, 0) });
  });

  app.post("/v1/inventory/valuations/:id/revalue", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, revalueShape);
    const res = await service().inventory.revalueValuation(
      actor,
      id(c.req.param("id")),
      body,
      c.req.header("Idempotency-Key"),
    );
    return c.json({ data: res, meta: meta(c, 0) }, 201);
  });

  app.post("/v1/inventory/valuations/:id/export", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, exportShape);
    const file = await service().inventory.exportValuation(actor, id(c.req.param("id")), body.format);
    c.header("Cache-Control", "private, no-store");
    c.header("Content-Disposition", `attachment; filename="${file.filename}"`);
    return c.body(file.body, 200, { "Content-Type": file.contentType });
  });
}
