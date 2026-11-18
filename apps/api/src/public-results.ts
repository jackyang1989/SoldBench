import type { AuthService } from "@soldbench/auth";
import { PublicResults, type QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };
type C = Context<Env>;
const createShape = z.strictObject({
  query_id: z.uuid(),
  expires_in: z.int().min(60).max(604800).optional(),
});
const invalid = () => new AppError("invalid_parameter", 400, "Invalid share parameters.");

export function mountPublicResults(app: Hono<Env>, config: Config, auth?: AuthService, query?: QueryService) {
  const implementation = query ? new PublicResults(query) : undefined;
  const service = () => {
    if (!implementation) throw new AppError("service_unavailable", 503, "Public results are not configured.");
    return implementation;
  };
  const owner = async (c: C, write = false) => {
    if (!auth) throw new AppError("unauthenticated", 401, "A session is required.");
    if (c.req.header("Authorization"))
      throw new AppError("forbidden", 403, "Shares require a browser session.");
    const token = getCookie(c, "soldbench_session") ?? "";
    if (write) {
      if (c.req.header("Origin") !== config.origin)
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      await auth.assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
    }
    return auth.sessionIdentity(token);
  };
  const meta = (c: C) => ({ request_id: c.get("requestId"), credits_charged: 0 });
  for (const path of ["/v1/shares", "/v1/shares/*", "/share/*"]) {
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
      await next();
    });
  }
  app.use(
    "/v1/shares",
    bodyLimit({
      maxSize: 4096,
      onError: () => {
        throw new AppError("request_too_large", 413, "Share body exceeds the limit.");
      },
    }),
  );
  app.post("/v1/shares", async (c) => {
    const actor = await owner(c, true);
    if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json")
      throw new AppError("invalid_parameter", 415, "Use application/json.");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      throw invalid();
    }
    const body = createShape.safeParse(input);
    if (!body.success) throw invalid();
    const r = await service().create(
      actor,
      body.data.query_id,
      body.data.expires_in ?? 86400,
      c.req.header("Idempotency-Key"),
      config.origin,
    );
    return c.json({ data: r.data, meta: meta(c) }, r.replayed ? 200 : 201);
  });
  app.get("/v1/shares", async (c) => {
    const actor = await owner(c),
      query = new URL(c.req.url).searchParams,
      id = query.get("query_id"),
      size = query.get("page_size") ?? "20";
    if (
      [...query.keys()].some(
        (k) => !["query_id", "page_size", "cursor"].includes(k) || query.getAll(k).length !== 1,
      ) ||
      (id !== null && !z.uuid().safeParse(id).success) ||
      !/^[1-9]\d{0,2}$/.test(size) ||
      Number(size) > 100
    )
      throw invalid();
    return c.json({
      data: await service().list(actor, Number(size), id ?? undefined, query.get("cursor") ?? undefined),
      meta: meta(c),
    });
  });
  app.delete("/v1/shares/:id", async (c) => {
    const actor = await owner(c, true),
      id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw invalid();
    await service().revoke(actor, id.data);
    return c.body(null, 204);
  });
  app.get("/share/:token", async (c) =>
    c.json({ data: await service().share(c.req.param("token")), meta: meta(c) }),
  );
}
