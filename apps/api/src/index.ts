import { randomUUID } from "node:crypto";
import type { AuthService } from "@soldbench/auth";
import type { PaymentLifecycle } from "@soldbench/billing";
import type { Database } from "@soldbench/db";
import type { QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import { renderHome } from "@soldbench/web";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { mountAuth } from "./auth.ts";
import { mountDeveloper } from "./developer.ts";
import { mountMcp } from "./mcp.ts";
import { mountOperations } from "./operations.ts";
import { mountPayments } from "./payments.ts";
import { mountPublicResults } from "./public-results.ts";
import { mountQueries } from "./queries.ts";

export function createApp(
  config: Config,
  db: Database,
  services: { auth?: AuthService; query?: QueryService; payments?: PaymentLifecycle } = {},
) {
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
    if (known && error.status === 429) c.header("Retry-After", String(error.details?.retry_after ?? 900));
    return c.json(
      {
        error: {
          code: known ? error.code : "service_unavailable",
          message: known ? error.message : "The service could not complete this request.",
          request_id: c.get("requestId"),
          details: known ? (error.details ?? {}) : {},
        },
      },
      (known ? error.status : 503) as ContentfulStatusCode,
    );
  });
  mountAuth(app, config, services.auth);
  app.get("/health", (c) => c.json({ status: "ok", data_mode: config.dataMode, collector_enabled: false }));
  app.get("/ready", async (c) => {
    await db.query("SELECT 1");
    return c.json({ status: "ready", data_mode: config.dataMode });
  });
  app.get("/", (c) => c.html(renderHome("en")));
  app.get("/zh-CN", (c) => c.html(renderHome("zh-CN")));
  mountQueries(app, config, services.auth, services.query);
  mountMcp(app, config, services.auth, services.query);
  mountDeveloper(app);
  mountPublicResults(app, config, services.auth, services.query);
  mountOperations(app, config, services.auth, services.query);
  mountPayments(app, config, services.auth, config.paymentFixtures ? services.payments : undefined);
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "Resource not found",
          request_id: c.get("requestId"),
          details: {},
        },
      },
      404,
    ),
  );
  return app;
}
