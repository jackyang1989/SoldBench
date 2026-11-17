import type { AuthService, Identity } from "@soldbench/auth";
import { normalizeQuery } from "@soldbench/core";
import {
  type QueryService,
  type RequestAudit,
  RequestAuditService,
  type RequestOperation,
  ResearchService,
} from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";

type Env = { Variables: { requestId: string; queryTrace?: Partial<RequestAudit> & { actor?: Identity } } };
export function mountQueries(app: Hono<Env>, config: Config, auth?: AuthService, query?: QueryService) {
  const audit = query ? new RequestAuditService(query) : null,
    research = query ? new ResearchService(query) : null;
  const routes: [string, RegExp, RequestOperation][] = [
    ["GET", /^\/v1\/sold$/, "sold_search"],
    ["POST", /^\/web\/search$/, "sold_search"],
    ["GET", /^\/v1\/sold\/[^/]+$/, "sold_result"],
    ["POST", /^\/v1\/sold\/[^/]+\/claim$/, "sold_claim"],
    ["GET", /^\/v1\/sold\/[^/]+\/calculation-inputs$/, "sold_calculation"],
    ["GET", /^\/v1\/sold\/[^/]+\/diagnostics$/, "sold_diagnostics"],
    ["GET", /^\/v1\/sold\/[^/]+\/comps\/[^/]+$/, "sold_detail"],
    ["POST", /^\/v1\/sold\/[^/]+\/export$/, "sold_export"],
    ["GET", /^\/v1\/jobs\/[^/]+$/, "job_get"],
    ["POST", /^\/v1\/jobs\/[^/]+\/cancel$/, "job_cancel"],
    ["GET", /^\/v1\/usage$/, "usage_get"],
    ["GET", /^\/v1\/queries$/, "history_get"],
    ["GET", /^\/v1\/media\/[^/]+$/, "media_get"],
  ];
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname,
      operation = routes.find((r) => r[0] === c.req.method && r[1].test(path))?.[2];
    if (!operation || !audit) return next();
    const started = performance.now(),
      trace: Partial<RequestAudit> & { actor?: Identity } = {
        operation,
        channel: path.startsWith("/web/") ? "web" : "api",
        creditsCharged: 0,
      };
    const resource = /^\/v1\/(sold|jobs)\/([a-f0-9-]{36})(?:\/|$)/.exec(path);
    if (resource) trace[resource[1] === "sold" ? "queryId" : "jobId"] = resource[2];
    c.set("queryTrace", trace);
    await next();
    if (trace.actor)
      try {
        await audit.record(trace.actor, {
          requestId: c.get("requestId"),
          operation,
          channel: trace.channel ?? "api",
          queryId: trace.queryId,
          jobId: trace.jobId,
          status: c.res.status,
          errorCode: c.error instanceof AppError ? c.error.code : c.error ? "service_unavailable" : undefined,
          durationMs: Math.min(2147483647, Math.max(0, Math.round(performance.now() - started))),
          creditsCharged: trace.creditsCharged ?? 0,
          reused: trace.reused,
          stale: trace.stale,
        });
      } catch {
        console.error("soldbench_request_audit_write_failed");
      }
  });
  const traceActor = (c: Context<Env>, actor: Identity) => {
    const t = c.get("queryTrace");
    if (t) t.actor = actor;
  };
  const result = async (c: Context<Env>, claim = false) => {
    const r = await service().result(
        await identity(c, "sold:read", claim),
        id(c.req.param("id")),
        c.get("requestId"),
        claim,
        claim ? c.req.header("Idempotency-Key") : undefined,
      ),
      t = c.get("queryTrace");
    if (t) {
      t.queryId = r.data.query_id;
      t.creditsCharged = r.meta.credits_charged;
      t.reused = r.meta.reused;
      t.stale = r.meta.stale;
    }
    return c.json(r);
  };
  const service = () => {
    if (!query) throw new AppError("service_unavailable", 503, "Query service is not configured.");
    return query;
  };
  const identity = async (c: Context<Env>, scope = "sold:read", write = false) => {
    if (!auth) throw new AppError("unauthenticated", 401, "Sign in or provide an API key.");
    const bearer = c.req.header("Authorization"),
      cookie = getCookie(c, "soldbench_session");
    if (bearer && cookie) throw new AppError("invalid_parameter", 400, "Use one authentication method.");
    if (bearer) {
      const token = /^Bearer (\S+)$/.exec(bearer)?.[1];
      if (!token) throw new AppError("unauthenticated", 401, "Invalid authentication header.");
      const actor = await auth.keyIdentity(token, scope);
      traceActor(c, actor);
      await service().rate(actor);
      return actor;
    }
    if (write) {
      if (c.req.header("Origin") !== config.origin)
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      await auth.assertCsrf(cookie ?? "", c.req.header("X-CSRF-Token") ?? "");
    }
    const actor = await auth.sessionIdentity(cookie ?? "");
    traceActor(c, actor);
    await service().rate(actor);
    return actor;
  };
  const id = (value: string | undefined) => {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    )
      throw new AppError("invalid_parameter", 400, "Invalid identifier.");
    return value;
  };
  const meta = (c: Context<Env>) => ({ request_id: c.get("requestId"), credits_charged: 0 });
  async function start(c: Context<Env>, params: URLSearchParams) {
    const normalized = normalizeQuery(params),
      actor = await identity(c, "sold:read", true),
      r = await service().submit(actor, normalized);
    const trace = c.get("queryTrace");
    if (trace) {
      trace.queryId = r.queryId;
      trace.jobId = r.jobId;
      trace.reused = r.reused;
    }
    return c.json(
      {
        data: {
          job_id: r.jobId,
          query_id: r.queryId,
          status: r.status,
          status_url: `/v1/jobs/${r.jobId}`,
          expires_at: r.expiresAt,
        },
        meta: meta(c),
      },
      202,
    );
  }
  app.get("/v1/sold", (c) => start(c, new URL(c.req.url).searchParams));
  app.use("/web/search", bodyLimit({ maxSize: 8192 }));
  app.post("/web/search", async (c) => {
    if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json")
      throw new AppError("invalid_parameter", 415, "Use application/json.");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError("invalid_parameter", 400, "Invalid JSON.");
    }
    if (
      !body ||
      Array.isArray(body) ||
      typeof body !== "object" ||
      Object.keys(body).some(
        (k) =>
          ![
            "q",
            "marketplace",
            "category",
            "brand",
            "model",
            "condition",
            "window_days",
            "price_basis",
            "limit",
            "allow_stale",
            "min_price_cents",
            "max_price_cents",
            "sale_format",
            "attributes",
          ].includes(k),
      )
    )
      throw new AppError("invalid_parameter", 400, "Invalid search parameters.");
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (key === "attributes") {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new AppError("invalid_parameter", 400, "Invalid attributes.");
        for (const [attribute, text] of Object.entries(value)) {
          if (typeof text !== "string")
            throw new AppError("invalid_parameter", 400, "Invalid attribute value.");
          parameters.set(`attr_${attribute}`, text);
        }
      } else {
        const expected =
          key === "allow_stale"
            ? "boolean"
            : ["window_days", "limit", "min_price_cents", "max_price_cents"].includes(key)
              ? "number"
              : "string";
        if (typeof value !== expected || (expected === "number" && !Number.isSafeInteger(value)))
          throw new AppError("invalid_parameter", 400, "Invalid parameter type.");
        parameters.set(key, String(value));
      }
    }
    return start(c, parameters);
  });
  app.get("/v1/sold/:id", (c) => result(c));
  app.post("/v1/sold/:id/claim", (c) => result(c, true));
  app.get("/v1/sold/:id/calculation-inputs", async (c) =>
    c.json({ data: await service().calculation(await identity(c), id(c.req.param("id"))), meta: meta(c) }),
  );
  app.get("/v1/jobs/:id", async (c) =>
    c.json({
      data: await service().job(await identity(c, "jobs:read"), id(c.req.param("id"))),
      meta: meta(c),
    }),
  );
  app.use("/v1/jobs/:id/cancel", bodyLimit({ maxSize: 1024 }));
  app.post("/v1/jobs/:id/cancel", async (c) => {
    const actor = await identity(c, "jobs:read", true);
    let b: Record<string, unknown>;
    try {
      b = await c.req.json();
    } catch {
      throw new AppError("invalid_parameter", 400, "Invalid JSON.");
    }
    if (
      !b ||
      Object.keys(b).length !== 1 ||
      !Number.isSafeInteger(b.version) ||
      typeof b.version !== "number" ||
      b.version < 1
    )
      throw new AppError("invalid_parameter", 400, "A job version is required.");
    await service().cancel(actor, id(c.req.param("id")), b.version as number);
    return c.body(null, 204);
  });
  const page = (c: Context<Env>) => {
    const p = new URL(c.req.url).searchParams;
    if ([...p.keys()].some((k) => !["cursor", "page_size"].includes(k) || p.getAll(k).length !== 1))
      throw new AppError("invalid_parameter", 400, "Invalid pagination fields.");
    const size = p.get("page_size") ?? "20";
    if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 100)
      throw new AppError("invalid_parameter", 400, "Invalid page size.");
    return { cursor: p.get("cursor") ?? undefined, size: Number(size) };
  };
  app.get("/v1/usage", async (c) => {
    const p = page(c);
    return c.json({
      data: await service().usage(await identity(c, "usage:read"), p.cursor, p.size),
      meta: meta(c),
    });
  });
  app.get("/v1/queries", async (c) => {
    const p = page(c);
    return c.json({ data: await service().history(await identity(c), p.cursor, p.size), meta: meta(c) });
  });

  app.get("/v1/sold/:id/diagnostics", async (c) => {
    const p = page(c);
    if (!research) throw new AppError("service_unavailable", 503, "Research service is not configured.");
    return c.json({
      data: await research.diagnostics(await identity(c), id(c.req.param("id")), p.cursor, p.size),
      meta: meta(c),
    });
  });
  app.get("/v1/sold/:id/comps/:event_id", async (c) => {
    if (!research) throw new AppError("service_unavailable", 503, "Research service is not configured.");
    return c.json({
      data: await research.detail(await identity(c), id(c.req.param("id")), id(c.req.param("event_id"))),
      meta: meta(c),
    });
  });
  app.use("/v1/sold/:id/export", bodyLimit({ maxSize: 100000 }));
  app.post("/v1/sold/:id/export", async (c) => {
    const actor = await identity(c, "sold:read", true);
    if (!research) throw new AppError("service_unavailable", 503, "Research service is not configured.");
    if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json")
      throw new AppError("invalid_parameter", 415, "Use application/json.");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError("invalid_parameter", 400, "Invalid JSON.");
    }
    const r = await research.export(actor, id(c.req.param("id")), body);
    c.header("Content-Type", r.contentType);
    c.header("Content-Disposition", `attachment; filename="${r.filename}"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(r.body);
  });
  app.get("/v1/requests", async (c) => {
    const p = new URL(c.req.url).searchParams;
    if (
      [...p.keys()].some(
        (k) =>
          !["cursor", "page_size", "channel", "operation", "status"].includes(k) || p.getAll(k).length !== 1,
      )
    )
      throw new AppError("invalid_parameter", 400, "Invalid request log filters.");
    const size = p.get("page_size") ?? "20",
      status = p.get("status");
    if (!/^\d+$/.test(size) || (status !== null && !/^\d{3}$/.test(status)))
      throw new AppError("invalid_parameter", 400, "Invalid request log filters.");
    if (!audit) throw new AppError("service_unavailable", 503, "Audit service is not configured.");
    return c.json({
      data: await audit.list(await identity(c, "usage:read"), {
        cursor: p.get("cursor") ?? undefined,
        size: Number(size),
        channel: p.get("channel") ?? undefined,
        operation: p.get("operation") ?? undefined,
        status: status === null ? undefined : Number(status),
      }),
      meta: meta(c),
    });
  });
  app.get("/v1/media/:id", async (c) => {
    const bytes = await service().image(await identity(c), id(c.req.param("id")));
    c.header("Content-Type", "image/webp");
    return c.body(new Uint8Array(bytes));
  });
}
