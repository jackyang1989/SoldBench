import type { AuthService } from "@soldbench/auth";
import type { PaymentLifecycle, Provider } from "@soldbench/billing";
import type { Transaction } from "@soldbench/db";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };
type C = Context<Env>;
const checkoutShape = z.strictObject({
  plan_code: z.enum(["starter", "pro", "purchased_1500"]),
  offer_version: z.string().min(1).max(80),
  provider: z.enum(["stripe", "paypal"]).optional(),
});
const cancelShape = z.strictObject({ version: z.int().positive() });
const cursorShape = z.strictObject({
  id: z.uuid(),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/),
});
const disabled = () => new AppError("service_unavailable", 503, "This payment channel is not enabled.");
const invalid = () => new AppError("invalid_parameter", 400, "Invalid billing parameters.");
function jsonType(c: C) {
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new AppError("invalid_parameter", 415, "Use application/json.");
}
async function body<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> {
  jsonType(c);
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw invalid();
  }
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}

export function mountPayments(
  app: Hono<Env>,
  config: Config,
  auth?: AuthService,
  payments?: PaymentLifecycle,
) {
  const service = () => {
    if (!payments) throw disabled();
    return payments;
  };
  const owner = async (c: C, write = false) => {
    if (!auth) throw disabled();
    if (c.req.header("Authorization"))
      throw new AppError("forbidden", 403, "Billing requires a browser session.");
    const token = getCookie(c, "soldbench_session") ?? "";
    if (write) {
      if (c.req.header("Origin") !== config.origin)
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      await auth.assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
    }
    const identity = await auth.sessionIdentity(token);
    return {
      userId: identity.userId,
      assertCurrent: (transaction: Transaction, now: Date) =>
        auth.assertIdentityLocked(transaction, identity, "usage:read", now),
    };
  };
  const meta = (c: C) => ({ request_id: c.get("requestId"), credits_charged: 0 });
  const limit = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: () => {
        throw new AppError("request_too_large", 413, "Request body is too large.");
      },
    });
  app.use("/billing/*", limit(8192));
  app.use("/webhooks/*", limit(32768));
  app.post("/billing/checkout", async (c) => {
    const p = service();
    return c.json({
      data: await p.checkout(
        await owner(c, true),
        await body(c, checkoutShape),
        c.req.header("Idempotency-Key"),
      ),
      meta: meta(c),
    });
  });
  app.get("/billing/checkout/:id", async (c) => {
    const p = service(),
      userId = await owner(c),
      id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw invalid();
    return c.json({ data: await p.checkoutStatus(userId, id.data), meta: meta(c) });
  });
  app.get("/billing/subscription", async (c) =>
    c.json({ data: await service().subscription(await owner(c)), meta: meta(c) }),
  );
  app.post("/billing/cancel", async (c) =>
    c.json({
      data: await service().cancel(await owner(c, true), (await body(c, cancelShape)).version),
      meta: meta(c),
    }),
  );
  app.post("/billing/portal", async (c) =>
    c.json({ data: await service().portal(await owner(c, true)), meta: meta(c) }),
  );
  app.get("/billing/payments", async (c) => {
    const p = service(),
      actor = await owner(c);
    if (!auth) throw disabled();
    const q = new URL(c.req.url).searchParams,
      raw = q.get("cursor"),
      size = q.get("page_size") ?? "50";
    if (
      [...q.keys()].some((k) => !["cursor", "page_size"].includes(k) || q.getAll(k).length !== 1) ||
      !/^[1-9]\d{0,2}$/.test(size) ||
      Number(size) > 100
    )
      throw invalid();
    const signature = (value: string) =>
      auth.crypto.hash("billing.payment_cursor", `${actor.userId}:${value}`);
    let cursor: z.infer<typeof cursorShape> | undefined;
    if (raw !== null) {
      if (!/^[a-zA-Z0-9_-]{1,256}\.[0-9a-f]{64}$/.test(raw)) throw invalid();
      const [data, mac] = raw.split(".");
      if (!data || !mac || !auth.crypto.equal(signature(data), mac)) throw invalid();
      try {
        cursor = cursorShape.parse(JSON.parse(Buffer.from(data, "base64url").toString("utf8")));
      } catch {
        throw invalid();
      }
    }
    const result = await p.payments(actor, Number(size), cursor),
      next = result.next ? Buffer.from(JSON.stringify(result.next)).toString("base64url") : null;
    return c.json({
      data: { items: result.items, next_cursor: next ? `${next}.${signature(next)}` : null },
      meta: meta(c),
    });
  });
  const webhook = (provider: Provider) => async (c: C) => {
    const p = service();
    if (c.req.header("Host") !== new URL(config.origin).host)
      throw new AppError("forbidden", 403, "Webhook host is not allowed.");
    jsonType(c);
    await p.receive(provider, c.req.raw.headers, Buffer.from(await c.req.arrayBuffer()));
    return c.body(null, 200);
  };
  app.post("/webhooks/stripe", webhook("stripe"));
  app.post("/webhooks/paypal", webhook("paypal"));
  app.post("/webhooks/paddle", () => {
    throw disabled();
  });
  app.post("/webhooks/dodo", () => {
    throw disabled();
  });
}
