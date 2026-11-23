import type { AuthService } from "@soldbench/auth";
import { type BillingService, PromoOfferService } from "@soldbench/billing";
import type { Transaction } from "@soldbench/db";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };
type C = Context<Env>;

const redeemShape = z.strictObject({
  code: z.string().min(1).max(64),
});

const invalid = () => new AppError("invalid_parameter", 400, "Invalid promo request parameters.");
const disabled = () =>
  new AppError("service_unavailable", 503, "Promo & offer versioning service is not configured.");

function requireJson(c: C) {
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AppError("invalid_parameter", 415, "Use application/json.");
  }
}

async function parseJson<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> {
  requireJson(c);
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw invalid();
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/**
 * Mounts promo campaign redemption and versioned pricing offer catalog routes (`TASK-062`, `AT-081`).
 */
export function mountPromoOffers(
  app: Hono<Env>,
  config: Config,
  auth?: AuthService,
  billing?: BillingService,
  promoService?: PromoOfferService,
) {
  const service = () => {
    const resolved = promoService ?? (billing ? new PromoOfferService(billing.db, billing) : null);
    if (!auth || !resolved) throw disabled();
    return resolved;
  };

  const browserOwner = async (c: C, write = false) => {
    if (!auth) throw disabled();
    if (c.req.header("Authorization")) {
      throw new AppError("forbidden", 403, "Promo and offer endpoints require a browser session.");
    }
    const token = getCookie(c, "soldbench_session") ?? "";
    if (write) {
      if (c.req.header("Origin") !== config.origin) {
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      }
      await auth.assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
    }
    const identity = await auth.sessionIdentity(token);
    return {
      userId: identity.userId,
      assertCurrent: (transaction: Transaction, now: Date) =>
        auth.assertIdentityLocked(transaction, identity, "usage:read", now),
    };
  };

  const meta = (c: C) => ({ request_id: c.get("requestId"), credits_charged: 0 as const });

  app.use(
    "/v1/billing/*",
    bodyLimit({
      maxSize: 4096,
      onError: () => {
        throw new AppError("request_too_large", 413, "Request body is too large.");
      },
    }),
  );

  app.post("/v1/billing/promos/redeem", async (c) => {
    const svc = service();
    const actor = await browserOwner(c, true);
    const body = await parseJson(c, redeemShape);
    return c.json({
      data: await svc.redeemPromo(actor, {
        code: body.code,
        idempotencyKey: c.req.header("Idempotency-Key"),
      }),
      meta: meta(c),
    });
  });

  app.get("/v1/billing/promos/redemptions", async (c) => {
    const svc = service();
    const actor = await browserOwner(c, false);
    return c.json({
      data: await svc.listRedemptions(actor),
      meta: meta(c),
    });
  });

  app.get("/v1/billing/offer-versions", async (c) => {
    const svc = service();
    await browserOwner(c, false);
    return c.json({
      data: await svc.listOfferVersions(),
      meta: meta(c),
    });
  });
}
