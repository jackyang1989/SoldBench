import { getConnInfo } from "@hono/node-server/conninfo";
import { AccountPrivacy, type AuthService } from "@soldbench/auth";
import { AppError, type Config, localeFrom } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

type Env = { Variables: { requestId: string } };
type C = Context<Env>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function id(value: string) {
  if (!uuid.test(value)) throw new AppError("invalid_parameter", 400, "Invalid identifier.");
  return value;
}
function sessionToken(c: C) {
  if (c.req.header("Authorization"))
    throw new AppError("forbidden", 403, "Use a browser session for account management.");
  return getCookie(c, "soldbench_session") ?? "";
}
async function body(c: C, allowed: string[], required = allowed) {
  const raw = await c.req.text();
  if (!raw) {
    if (required.length) throw new AppError("invalid_parameter", 400, "A JSON body is required.");
    return {} as Record<string, unknown>;
  }
  if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json")
    throw new AppError("invalid_parameter", 415, "Use application/json.");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError("invalid_parameter", 400, "Invalid JSON body.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new AppError("invalid_parameter", 400, "Invalid request fields.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new AppError("invalid_parameter", 400, "Expected a string.");
  return value;
}
export function mountAuth(app: Hono<Env>, config: Config, provided?: AuthService) {
  const service = () => {
      if (!provided) throw new AppError("service_unavailable", 503, "Account service is not configured.");
      return provided;
    },
    context = (c: C) => {
      let client = "offline-in-process";
      try {
        client = getConnInfo(c).remote.address ?? client;
      } catch {
        /* In-process tests have no transport peer. */
      }
      return {
        clientId: client,
        locale: localeFrom("/", c.req.header("Accept-Language")),
        requestId: c.get("requestId"),
      };
    },
    meta = (c: C) => ({ request_id: c.get("requestId"), credits_charged: 0 }),
    accepted = (c: C) =>
      c.json({ data: { status: "accepted" as const, request_id: c.get("requestId") }, meta: meta(c) }, 202),
    setSession = (c: C, result: { token: string; view: { expires_at: string } }) =>
      setCookie(c, "soldbench_session", result.token, {
        httpOnly: true,
        secure: config.origin.startsWith("https:"),
        sameSite: "Lax",
        path: "/",
        maxAge: Math.max(
          0,
          Math.floor(
            (Date.parse(result.view.expires_at) -
              Date.parse(service().clock?.() ?? new Date().toISOString())) /
              1000,
          ),
        ),
      }),
    secured = async (c: C) => {
      const token = sessionToken(c);
      await service().assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
      return token;
    };
  for (const path of ["/auth/*", "/account/*", "/v1/keys", "/v1/keys/*"]) {
    app.use(
      path,
      bodyLimit({
        maxSize: 8192,
        onError: () => {
          throw new AppError("invalid_parameter", 413, "Request body is too large.");
        },
      }),
    );
    app.use(path, async (c, next) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("Origin") !== config.origin)
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      await next();
    });
  }
  const privacy = provided ? new AccountPrivacy(provided, provided.clock) : undefined;
  const privacyService = () => {
    if (!privacy) throw new AppError("service_unavailable", 503, "Account service is not configured.");
    return privacy;
  };
  app.use("/account/deletion-requests/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.post("/account/deletion-requests", async (c) => {
    const token = await secured(c),
      input = await body(c, ["confirm", "receipt_token"]);
    if (input.confirm !== true)
      throw new AppError("invalid_parameter", 400, "Explicit account deletion confirmation is required.");
    const result = await privacyService().request(
      await service().sessionIdentity(token),
      text(input.receipt_token),
      c.get("requestId"),
    );
    deleteCookie(c, "soldbench_session", { path: "/" });
    return c.json({ data: result, meta: meta(c) }, 202);
  });
  app.get("/account/deletion-requests/by-receipt", async (c) =>
    c.json({
      data: await privacyService().status(c.req.header("X-Deletion-Receipt"), undefined),
      meta: meta(c),
    }),
  );
  app.get("/account/deletion-requests/:id", async (c) => {
    const receipt = c.req.header("X-Deletion-Receipt"),
      requested = c.req.param("id");
    const actor = receipt === undefined ? await service().sessionIdentity(sessionToken(c)) : undefined;
    return c.json({ data: await privacyService().status(receipt, requested, actor), meta: meta(c) });
  });
  app.post("/auth/register", async (c) => {
    const b = await body(c, ["email", "password", "terms_version"]);
    await service().register(
      { email: b.email, password: b.password, terms_version: b.terms_version },
      context(c),
    );
    return accepted(c);
  });
  app.post("/auth/verify-email", async (c) => {
    const b = await body(c, ["token"]);
    await service().verifyEmail(text(b.token), context(c));
    return accepted(c);
  });
  app.post("/auth/login", async (c) => {
    const b = await body(c, ["email", "password"]),
      result = await service().login(b.email, b.password, context(c));
    setSession(c, result);
    return c.json({ data: result.view, meta: meta(c) });
  });
  app.get("/auth/me", async (c) => c.json({ data: await service().me(sessionToken(c)), meta: meta(c) }));
  app.get("/web/session", async (c) =>
    c.json({ data: await service().webSession(sessionToken(c)), meta: meta(c) }),
  );
  app.post("/auth/logout", async (c) => {
    await body(c, [], []);
    const token = sessionToken(c);
    try {
      await service().assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "unauthenticated") throw error;
    }
    await service().logout(token, context(c));
    deleteCookie(c, "soldbench_session", { path: "/", sameSite: "Lax", httpOnly: true });
    return c.body(null, 204);
  });
  app.post("/auth/password-reset/request", async (c) => {
    const b = await body(c, ["email"]);
    await service().requestMail(b.email, "reset_password", context(c));
    return accepted(c);
  });
  app.post("/auth/verification/resend", async (c) => {
    const b = await body(c, ["email"]);
    await service().requestMail(b.email, "verify_email", context(c));
    return accepted(c);
  });
  app.post("/auth/password-reset/confirm", async (c) => {
    const b = await body(c, ["token", "new_password"]);
    await service().resetPassword(text(b.token), b.new_password, context(c));
    deleteCookie(c, "soldbench_session", { path: "/" });
    return c.body(null, 204);
  });
  app.post("/auth/reauthenticate", async (c) => {
    const token = await secured(c),
      b = await body(c, ["password", "totp_code"], ["password"]),
      result = await service().reauthenticate(
        token,
        b.password,
        b.totp_code === undefined ? undefined : text(b.totp_code),
        context(c),
      );
    setSession(c, result);
    return c.json({ data: result.view, meta: meta(c) });
  });
  app.post("/account/password", async (c) => {
    const token = await secured(c),
      b = await body(c, ["current_password", "new_password"]);
    await service().changePassword(token, b.current_password, b.new_password, context(c));
    deleteCookie(c, "soldbench_session", { path: "/" });
    return c.body(null, 204);
  });
  app.get("/account/sessions", async (c) =>
    c.json({ data: await service().listSessions(sessionToken(c)), meta: meta(c) }),
  );
  app.delete("/account/sessions/:id", async (c) => {
    const token = await secured(c);
    await service().revokeSession(token, id(c.req.param("id")), context(c));
    return c.body(null, 204);
  });
  app.get("/account/mfa", async (c) =>
    c.json({ data: await service().mfaStatus(sessionToken(c)), meta: meta(c) }),
  );
  app.post("/account/mfa/setup", async (c) => {
    const token = await secured(c);
    await body(c, [], []);
    return c.json({ data: await service().mfaSetup(token, context(c)), meta: meta(c) });
  });
  app.post("/account/mfa/confirm", async (c) => {
    const token = await secured(c),
      b = await body(c, ["totp_code"]),
      result = await service().mfaConfirm(token, text(b.totp_code), context(c));
    setSession(c, result);
    return c.json({
      data: { recovery_codes: result.recovery_codes, csrf_token: result.view.csrf_token },
      meta: meta(c),
    });
  });
  app.post("/auth/mfa/verify", async (c) => {
    const token = await secured(c),
      b = await body(c, ["totp_code", "recovery_code"], []),
      result = await service().mfaVerify(
        token,
        {
          totp_code: b.totp_code === undefined ? undefined : text(b.totp_code),
          recovery_code: b.recovery_code === undefined ? undefined : text(b.recovery_code),
        },
        context(c),
      );
    setSession(c, result);
    return c.json({ data: result.view, meta: meta(c) });
  });
  app.delete("/account/mfa", async (c) => {
    const token = await secured(c);
    await body(c, [], []);
    await service().mfaDisable(token, context(c));
    deleteCookie(c, "soldbench_session", { path: "/" });
    return c.body(null, 204);
  });
  app.post("/account/mfa/recovery-codes", async (c) => {
    const token = await secured(c);
    await body(c, [], []);
    return c.json({ data: await service().regenerateRecoveryCodes(token, context(c)), meta: meta(c) });
  });
  app.get("/v1/keys", async (c) =>
    c.json({ data: await service().listKeys(sessionToken(c)), meta: meta(c) }),
  );
  app.post("/v1/keys", async (c) => {
    const token = await secured(c),
      b = await body(c, ["name", "scopes"]),
      result = await service().createKey(
        token,
        { name: text(b.name), scopes: b.scopes as string[] },
        c.req.header("Idempotency-Key") ?? "",
        context(c),
      );
    return c.json(
      { data: { ...(result.key ? { key: result.key } : {}), key_info: result.key_info }, meta: meta(c) },
      result.replayed ? 200 : 201,
    );
  });
  app.post("/v1/keys/:id/rotate", async (c) => {
    const token = await secured(c),
      b = await body(c, ["name", "scopes"]),
      result = await service().createKey(
        token,
        { name: text(b.name), scopes: b.scopes as string[] },
        c.req.header("Idempotency-Key") ?? "",
        context(c),
        id(c.req.param("id")),
      );
    return c.json(
      { data: { ...(result.key ? { key: result.key } : {}), key_info: result.key_info }, meta: meta(c) },
      result.replayed ? 200 : 201,
    );
  });
  app.delete("/v1/keys/:id", async (c) => {
    const token = await secured(c);
    await service().revokeKey(token, id(c.req.param("id")), context(c));
    return c.body(null, 204);
  });
}
