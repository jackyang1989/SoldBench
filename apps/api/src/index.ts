import { randomUUID } from "node:crypto";
import { normalizeQuery } from "@soldbench/core";
import type { Database } from "@soldbench/db";
import { AppError, type Config } from "@soldbench/shared";
import { renderHome } from "@soldbench/web";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function createApp(config: Config, db: Database) {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", async (c, next) => {
    c.set("requestId", randomUUID());
    c.header("X-Request-ID", c.get("requestId"));
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    await next();
  });
  app.onError((error, c) => {
    const known = error instanceof AppError;
    return c.json(
      {
        error: {
          code: known ? error.code : "service_unavailable",
          message: known ? error.message : "The service could not complete this request.",
          request_id: c.get("requestId"),
          ...(known && error.details ? { details: error.details } : {}),
        },
      },
      (known ? error.status : 503) as ContentfulStatusCode,
    );
  });
  app.get("/health", (c) => c.json({ status: "ok", data_mode: config.dataMode, collector_enabled: false }));
  app.get("/ready", async (c) => {
    await db.query("SELECT 1");
    return c.json({ status: "ready", data_mode: config.dataMode });
  });
  app.get("/", (c) => c.html(renderHome("en")));
  app.get("/zh-CN", (c) => c.html(renderHome("zh-CN")));
  app.get("/v1/sold", (c) => {
    normalizeQuery(new URL(c.req.url).searchParams);
    throw new AppError("unauthenticated", 401, "Sign in or provide an API key");
  });
  app.notFound((c) =>
    c.json(
      { error: { code: "not_found", message: "Resource not found", request_id: c.get("requestId") } },
      404,
    ),
  );
  return app;
}
