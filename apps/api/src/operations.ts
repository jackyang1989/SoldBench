import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AuthService } from "@soldbench/auth";
import type { PaymentLifecycle } from "@soldbench/billing";
import type { QueryService } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import { renderPage } from "@soldbench/web";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";
import { OperationsService } from "./operations-domain.ts";
import { siteContentCommand } from "./site-content.ts";

type Env = { Variables: { requestId: string } };
type C = Context<Env>;
const reason = z.string().trim().min(1).max(1000),
  id = z.uuid(),
  version = z.int().positive(),
  receiptToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  source = z.strictObject({
    command: z.enum(["suspend", "probe", "revoke"]),
    reason,
    evidence_ref: z.string().trim().min(1).max(200),
    version,
  }),
  retry = z.strictObject({ reason, version }),
  refund = z.strictObject({ reason }),
  ticket = z.strictObject({
    category: z.enum(["data_quality", "takedown", "billing", "account", "other"]),
    message: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine(
        (value) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value),
        "Message must contain valid text.",
      ),
    request_id: z.uuid().optional(),
  }),
  supportCommand = z.discriminatedUnion("command", [
    z.strictObject({
      command: z.enum(["claim", "reopen", "take_over"]),
      due_at: z.iso.datetime(),
      reason,
      version,
    }),
    z.strictObject({
      command: z.literal("resolve"),
      reply: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .refine((value) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value)),
      reason,
      version,
    }),
    z.strictObject({ command: z.literal("close"), reason, version }),
  ]);
const invalid = () => new AppError("invalid_parameter", 400, "Invalid operation parameters.");
const plainText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((entry) => !/[\p{Cc}\p{Cs}]/u.test(entry));
const requestApproval = z.strictObject({
  action: z.enum(["suspend", "restore"]),
  credential_version: z.int().nonnegative(),
  reason,
});
const approvalCommand = z.strictObject({
  command: z.enum(["approve", "reject", "execute", "cancel"]),
  version,
  reason,
});
const noteInput = z.strictObject({ content: plainText(1000) });
const openIncident = z.strictObject({
  component: z.enum(["api", "collector", "query", "payments", "support"]),
  title: plainText(140),
  reason,
});
const incidentCommand = z.strictObject({
  state: z.enum(["open", "monitoring", "resolved"]),
  version,
  reason,
});
async function body<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> {
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new AppError("invalid_parameter", 415, "Use application/json.");
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    throw invalid();
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function page(c: C) {
  const q = new URL(c.req.url).searchParams,
    size = q.get("page_size") ?? "20";
  if (
    [...q.keys()].some((k) => !["cursor", "page_size"].includes(k) || q.getAll(k).length !== 1) ||
    !/^[1-9]\d{0,2}$/.test(size) ||
    Number(size) > 100
  )
    throw invalid();
  return { size: Number(size), cursor: q.get("cursor") ?? undefined };
}
function resource(c: C) {
  const result = id.safeParse(c.req.param("id"));
  if (!result.success) throw invalid();
  return result.data;
}
export function mountOperations(
  app: Hono<Env>,
  config: Config,
  auth?: AuthService,
  query?: QueryService,
  payments?: PaymentLifecycle,
) {
  const ops = query ? new OperationsService(query, config.paymentFixtures ? payments : undefined) : undefined;
  const service = () => {
    if (!ops) throw new AppError("service_unavailable", 503, "Operations service is unavailable.");
    return ops;
  };
  const meta = (c: C) => ({ request_id: c.get("requestId"), credits_charged: 0 });
  const key = (c: C) => c.req.header("Idempotency-Key");
  const sameOrigin = (c: C) => {
    if (c.req.header("Origin") !== config.origin)
      throw new AppError("forbidden", 403, "Request origin is not allowed.");
  };
  const identity = async (c: C, write = false) => {
    if (!auth || c.req.header("Authorization"))
      throw new AppError("forbidden", 403, "Use an operator session.");
    const token = getCookie(c, "soldbench_session") ?? "";
    if (write) {
      sameOrigin(c);
      await auth.assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
    }
    return auth.sessionIdentity(token);
  };
  const limit = bodyLimit({
    maxSize: 18000,
    onError: () => {
      throw new AppError("request_too_large", 413, "Request body is too large.");
    },
  });
  app.use("/support/requests", limit);
  const contentLimit = bodyLimit({ maxSize: 80 * 1024 });
  app.use("/admin/*", (c, next) =>
    (c.req.path === "/admin/content/commands" ? contentLimit : limit)(c, next),
  );
  app.use("/admin/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    await next();
  });
  app.post("/support/requests", async (c) => {
    sameOrigin(c);
    const actor = getCookie(c, "soldbench_session") ? await identity(c, true) : undefined;
    if (c.req.header("Authorization")) throw new AppError("forbidden", 403, "Use the support form.");
    let peer = "fixture-in-process";
    try {
      const address = getConnInfo(c).remote.address;
      if (!address || !isIP(address))
        throw new AppError("service_unavailable", 503, "Client address is unavailable.");
      peer = address;
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
    const receipt = receiptToken.optional().safeParse(c.req.header("X-Support-Receipt"));
    if (!receipt.success) throw invalid();
    const requestId = await service().support(actor, peer, await body(c, ticket), key(c), receipt.data);
    return c.json({ data: { status: "accepted", request_id: requestId }, meta: meta(c) }, 202);
  });
  app.get("/support/receipt", async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    const receipt = receiptToken.safeParse(c.req.header("X-Support-Receipt"));
    if (!receipt.success) throw new AppError("not_found", 404, "Support receipt not found.");
    return c.json({ data: await service().supportReceipt(receipt.data), meta: meta(c) });
  });
  app.get("/admin/support", async (c) =>
    c.json({ data: await service().supportQueue(await identity(c), page(c)), meta: meta(c) }),
  );
  app.get("/admin/support/:id", async (c) =>
    c.json({
      data: await service().supportDetail(await identity(c), resource(c), c.get("requestId")),
      meta: meta(c),
    }),
  );
  app.post("/admin/support/:id/commands", async (c) => {
    const actor = await identity(c, true);
    const input = await body(c, supportCommand);
    return c.json(
      {
        data: await service().supportCommand(actor, resource(c), input, key(c), c.get("requestId")),
        meta: meta(c),
      },
      202,
    );
  });
  app.get("/admin/content", async (c) => {
    const data = await service().contentList(await identity(c));
    c.header("Vary", "Accept");
    if (c.req.header("Accept")?.includes("text/html")) {
      const url = new URL(c.req.url);
      return c.html(
        renderPage(url.searchParams.get("lang") === "zh-CN" ? "zh-CN" : "en", "/admin/content", url),
      );
    }
    return c.json({ data, meta: meta(c) });
  });
  app.post("/admin/content/commands", async (c) => {
    const actor = await identity(c, true);
    const input = await body(c, siteContentCommand);
    const data = await service().contentCommand(actor, input, key(c), c.get("requestId"));
    return c.json({ data, meta: meta(c) }, 202);
  });
  app.get("/admin/recovery", async (c) =>
    c.json({ data: await service().recovery(await identity(c), page(c)), meta: meta(c) }),
  );
  app.post("/admin/payments/events/:id/replay", async (c) => {
    const actor = await identity(c, true);
    const input = await body(
      c,
      z.strictObject({ reason, case_reference: z.string().trim().min(1).max(200) }),
    );
    return c.json(
      {
        data: await service().replayPayment(actor, resource(c), input, key(c), c.get("requestId")),
        meta: meta(c),
      },
      202,
    );
  });
  app.get("/status", async (c) => {
    c.header("Vary", "Accept");
    if (c.req.header("Accept")?.includes("text/html"))
      return c.html(renderPage("en", "/data-availability", new URL(c.req.url)));
    return c.json({ data: await service().status(), meta: meta(c) });
  });
  app.get("/admin/sources", async (c) =>
    c.json({ data: await service().sources(await identity(c)), meta: meta(c) }),
  );
  app.post("/admin/sources/:id/commands", async (c) =>
    c.json(
      {
        data: await service().sourceCommand(
          await identity(c, true),
          resource(c),
          await body(c, source),
          key(c),
          c.get("requestId"),
        ),
        meta: meta(c),
      },
      202,
    ),
  );
  app.get("/admin/jobs", async (c) =>
    c.json({ data: await service().jobs(await identity(c), page(c)), meta: meta(c) }),
  );
  app.post("/admin/jobs/:id/retry", async (c) =>
    c.json(
      {
        data: await service().retry(
          await identity(c, true),
          resource(c),
          await body(c, retry),
          key(c),
          c.get("requestId"),
        ),
        meta: meta(c),
      },
      202,
    ),
  );
  app.get("/admin/billing", async (c) =>
    c.json({ data: await service().billing(await identity(c), page(c)), meta: meta(c) }),
  );
  app.post("/admin/charges/:id/refund-credit", async (c) =>
    c.json({
      data: await service().refund(
        await identity(c, true),
        resource(c),
        (await body(c, refund)).reason,
        key(c),
        c.get("requestId"),
      ),
      meta: meta(c),
    }),
  );
  app.get("/admin/audit", async (c) =>
    c.json({ data: await service().audits(await identity(c), page(c)), meta: meta(c) }),
  );
  app.get("/admin/overview", async (c) =>
    c.json({ data: await service().overview(await identity(c)), meta: meta(c) }),
  );
  app.get("/admin/settings", async (c) => {
    const state = await service().overview(await identity(c));
    if (state.role !== "admin") throw new AppError("forbidden", 403, "Administrator permission is required.");
    return c.json({
      data: {
        as_of: state.as_of,
        data_mode: config.dataMode,
        collector_enabled: config.collectorEnabled,
        payments_mode: config.paymentsMode,
        payment_fixtures_enabled: config.paymentFixtures && Boolean(payments),
      },
      meta: meta(c),
    });
  });
  app.get("/admin/users", async (c) =>
    c.json({ data: await service().users(await identity(c), page(c)), meta: meta(c) }),
  );
  app.get("/admin/users/:id", async (c) =>
    c.json({
      data: await service().userCase(await identity(c), resource(c), c.get("requestId")),
      meta: meta(c),
    }),
  );
  app.post("/admin/users/:id/notes", async (c) =>
    c.json(
      {
        data: await service().addUserNote(
          await identity(c, true),
          resource(c),
          (await body(c, noteInput)).content,
          key(c),
          c.get("requestId"),
        ),
        meta: meta(c),
      },
      202,
    ),
  );
  app.post("/admin/users/:id/approvals", async (c) =>
    c.json(
      {
        data: await service().requestApproval(
          await identity(c, true),
          resource(c),
          await body(c, requestApproval),
          key(c),
          c.get("requestId"),
        ),
        meta: meta(c),
      },
      202,
    ),
  );
  app.get("/admin/approvals", async (c) =>
    c.json({ data: await service().approvals(await identity(c), page(c)), meta: meta(c) }),
  );
  app.post("/admin/approvals/:id/commands", async (c) =>
    c.json(
      {
        data: await service().approvalCommand(
          await identity(c, true),
          resource(c),
          await body(c, approvalCommand),
          key(c),
          c.get("requestId"),
        ),
        meta: meta(c),
      },
      202,
    ),
  );
  app.get("/admin/charges/:id", async (c) =>
    c.json({
      data: await service().chargeDetail(await identity(c), resource(c)),
      meta: meta(c),
    }),
  );
  app.get("/admin/incidents", async (c) =>
    c.json({ data: await service().incidents(await identity(c), page(c)), meta: meta(c) }),
  );
  app.post("/admin/incidents", async (c) =>
    c.json(
      {
        data: await service().incidentCommand(
          await identity(c, true),
          null,
          await body(c, openIncident),
          key(c),
          c.get("requestId"),
        ),
        meta: meta(c),
      },
      202,
    ),
  );
  app.get("/admin/incidents/:id", async (c) =>
    c.json({ data: await service().incidentDetail(await identity(c), resource(c)), meta: meta(c) }),
  );
  app.post("/admin/incidents/:id", async (c) =>
    c.json(
      {
        data: await service().incidentCommand(
          await identity(c, true),
          resource(c),
          await body(c, incidentCommand),
          key(c),
          c.get("requestId"),
        ),
        meta: meta(c),
      },
      202,
    ),
  );
}
