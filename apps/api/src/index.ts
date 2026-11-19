import { randomUUID } from "node:crypto";
import type { AuthService } from "@soldbench/auth";
import type { PaymentLifecycle } from "@soldbench/billing";
import { type Database, isDatabaseConnectionError } from "@soldbench/db";
import type { QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import { operationsPanels, renderPage, webClient, webCss, webPages } from "@soldbench/web";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { mountAuth } from "./auth.ts";
import { mountCatalog } from "./catalog.ts";
import { mountDeveloper } from "./developer.ts";
import { editorialNotFound, mountEditorial, siteBlocks } from "./editorial.ts";
import { mountMcp } from "./mcp.ts";
import { mountOperations } from "./operations.ts";
import { mountPayments } from "./payments.ts";
import { mountPublicResults } from "./public-results.ts";
import { mountQueries } from "./queries.ts";
import { publishedSiteContent } from "./site-content.ts";

export { publishNextScheduledContent } from "./site-content.ts";

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
    const retry = known ? error.details?.retry_after : undefined;
    if (known && error.status === 429) c.header("Retry-After", String(retry ?? 900));
    else if (!known && isDatabaseConnectionError(error)) c.header("Retry-After", "2");
    else if (
      known &&
      error.status === 503 &&
      typeof retry === "number" &&
      Number.isSafeInteger(retry) &&
      retry > 0
    )
      c.header("Retry-After", String(retry));
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
  mountCatalog(app, db, services.query);
  app.get("/health", (c) => c.json({ status: "ok", data_mode: config.dataMode, collector_enabled: false }));
  app.get("/ready", async (c) => {
    const { rows } = await db.query<{ query_worker: string; query_queue: string }>(
      `SELECT coalesce((SELECT CASE WHEN last_cycle_at >= now() - interval '30 seconds' THEN 'recent'
          ELSE 'stale' END FROM worker_heartbeats WHERE worker_kind='query'), 'unobserved') AS query_worker,
        CASE WHEN EXISTS (SELECT 1 FROM query_jobs WHERE status='queued' AND expires_at>now()
          AND available_at<=now() - interval '15 seconds') THEN 'delayed' ELSE 'within_budget' END AS query_queue`,
    );
    return c.json({ status: "ready", data_mode: config.dataMode, ...rows[0] });
  });
  app.get("/assets/soldbench.css", (c) => c.body(webCss, 200, { "Content-Type": "text/css; charset=utf-8" }));
  app.get("/assets/soldbench.js", (c) =>
    c.body(webClient, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );
  for (const [locale, prefix] of [
    ["en", ""],
    ["zh-CN", "/zh-CN"],
  ] as const) {
    for (const page of webPages) {
      if (page === "/guides") continue;
      const path = page === "/" ? prefix || "/" : prefix + page;
      app.get(path, async (c) => {
        const kind = page === "/" ? "announcement" : page === "/faq" ? "faq" : null;
        const rows =
          kind && services.query
            ? await publishedSiteContent(
                db,
                page === "/"
                  ? [kind, "home", "navigation", "footer", "blog"]
                  : [kind, "navigation", "footer"],
              )
            : [];
        const sections = rows
          .filter((row) => row.kind === kind)
          .map((row) => ({ slug: row.slug, ...row.body[locale] }));
        if (kind) c.header("Cache-Control", "no-store");
        return c.html(
          renderPage(
            locale,
            page,
            new URL(c.req.url),
            undefined,
            undefined,
            undefined,
            sections,
            siteBlocks(rows, locale),
          ),
        );
      });
      if (page === "/" && prefix)
        app.get(`${prefix}/`, (c) => c.redirect(prefix + new URL(c.req.url).search, 308));
    }
    app.get(`${prefix}/results/:id`, (c) => {
      const id = c.req.param("id");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return c.notFound();
      return c.html(renderPage(locale, "/results", new URL(c.req.url), id));
    });
    for (const panel of operationsPanels) {
      app.get(`${prefix}/operations/${panel}`, (c) => {
        c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
        return c.html(renderPage(locale, "/operations", new URL(c.req.url)));
      });
    }
  }
  mountQueries(app, config, services.auth, services.query);
  mountMcp(app, config, services.auth, services.query);
  mountEditorial(app, db, services.query);
  mountDeveloper(app);
  mountPublicResults(app, config, services.auth, services.query);
  mountOperations(app, config, services.auth, services.query, services.payments);
  mountPayments(app, config, services.auth, config.paymentFixtures ? services.payments : undefined);
  app.notFound((c) => {
    const chinese = /^\/zh-CN(?:\/|$)/.test(c.req.path);
    const path = chinese ? c.req.path.slice("/zh-CN".length) : c.req.path;
    if (
      c.req.method === "GET" &&
      c.req.header("Accept")?.includes("text/html") &&
      !/^\/(?:v1|web|billing|webhooks|admin|assets|mcp|\.well-known)(?:\/|$)/.test(path)
    )
      return editorialNotFound(c, chinese ? "zh-CN" : "en");
    return c.json(
      {
        error: {
          code: "not_found",
          message: "Resource not found",
          request_id: c.get("requestId"),
          details: {},
        },
      },
      404,
    );
  });
  return app;
}
