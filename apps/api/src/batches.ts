import type { AuthService } from "@soldbench/auth";
import { BatchQueryService, MAX_BATCH_ITEMS, type QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const previewShape = z
  .strictObject({
    items: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_BATCH_ITEMS).optional(),
    csv: z.string().min(1).max(65536).optional(),
  })
  .refine((v) => (v.items !== undefined) !== (v.csv !== undefined));

const createShape = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    items: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_BATCH_ITEMS).optional(),
    csv: z.string().min(1).max(65536).optional(),
  })
  .refine((v) => (v.items !== undefined) !== (v.csv !== undefined));

const cancelShape = z.strictObject({
  version: z.int().positive(),
});

const claimShape = z.strictObject({
  item_indices: z
    .array(
      z
        .int()
        .min(0)
        .max(MAX_BATCH_ITEMS - 1),
    )
    .min(1)
    .max(MAX_BATCH_ITEMS)
    .optional(),
});

const exportShape = z.strictObject({
  format: z.enum(["csv", "json"]),
});

/**
 * Mount V1.1 merchant batch lookup & CSV workbench endpoints (`/v1/batches*`).
 */
export function mountBatches(app: Hono<Env>, config: Config, auth?: AuthService, query?: QueryService) {
  const batches = query ? new BatchQueryService(query) : null;

  const service = () => {
    if (!query || !batches)
      throw new AppError("service_unavailable", 503, "Batch query service is not configured.");
    return { query, batches };
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

  const meta = (c: Context<Env>, credits = 0) => ({
    request_id: c.get("requestId"),
    credits_charged: credits,
  });

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
    if (!parsed.success) throw new AppError("invalid_parameter", 400, "Invalid batch request fields.");
    return parsed.data;
  };

  app.use("/v1/batches", bodyLimit({ maxSize: 65536 }));
  app.use("/v1/batches/*", bodyLimit({ maxSize: 65536 }));

  app.post("/v1/batches/preview", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, previewShape);
    return c.json({ data: await service().batches.preview(actor, body), meta: meta(c) });
  });

  app.post("/v1/batches", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, createShape);
    const result = await service().batches.create(actor, body, c.req.header("Idempotency-Key"));
    return c.json(
      {
        data: result.batch,
        meta: { ...meta(c), reused: result.replayed },
      },
      202,
    );
  });

  app.get("/v1/batches", async (c) => {
    const p = new URL(c.req.url).searchParams;
    if ([...p.keys()].some((k) => !["cursor", "page_size"].includes(k) || p.getAll(k).length !== 1))
      throw new AppError("invalid_parameter", 400, "Invalid pagination fields.");
    const size = p.get("page_size") ?? "20";
    if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 100)
      throw new AppError("invalid_parameter", 400, "Invalid page size.");
    const actor = await identity(c, "jobs:read");
    return c.json({
      data: await service().batches.list(actor, p.get("cursor") ?? undefined, Number(size)),
      meta: meta(c),
    });
  });

  app.get("/v1/batches/:id", async (c) => {
    const actor = await identity(c, "jobs:read");
    return c.json({ data: await service().batches.get(actor, id(c.req.param("id"))), meta: meta(c) });
  });

  app.post("/v1/batches/:id/cancel", async (c) => {
    const actor = await identity(c, "jobs:read", true);
    const body = await parse(c, cancelShape);
    return c.json({
      data: await service().batches.cancel(
        actor,
        id(c.req.param("id")),
        body.version,
        c.req.header("Idempotency-Key"),
      ),
      meta: meta(c),
    });
  });

  app.post("/v1/batches/:id/claim", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, claimShape);
    const result = await service().batches.claim(
      actor,
      id(c.req.param("id")),
      body,
      c.req.header("Idempotency-Key"),
      c.get("requestId"),
    );
    return c.json({
      data: result,
      meta: meta(c, result.credits_charged_now),
    });
  });

  app.post("/v1/batches/:id/export", async (c) => {
    const actor = await identity(c, "sold:read", true);
    const body = await parse(c, exportShape);
    const exported = await service().batches.export(actor, id(c.req.param("id")), body.format);
    c.header("Content-Type", exported.contentType);
    c.header("Content-Disposition", `attachment; filename="${exported.filename}"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(exported.body);
  });
}
