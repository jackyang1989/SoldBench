import { type AuthService, PasskeyService } from "@soldbench/auth";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const registerOptionsShape = z.strictObject({
  label: z.string().trim().min(1).max(80).optional(),
});

const registerVerifyShape = z.strictObject({
  credential_id: z.string().min(8).max(512),
  public_key_spki_pem: z.string().min(32).max(2048),
  algorithm: z.enum(["ES256", "Ed25519"]),
  label: z.string().trim().min(1).max(80).optional(),
  transports: z.array(z.string().min(1).max(32)).max(6).optional(),
  client_data_json: z.string().min(16).max(4096),
  authenticator_data: z.string().min(32).max(2048),
});

const loginOptionsShape = z.strictObject({
  email: z.string().min(3).max(254).optional(),
});

const loginVerifyShape = z.strictObject({
  credential_id: z.string().min(8).max(512),
  client_data_json: z.string().min(16).max(4096),
  authenticator_data: z.string().min(32).max(2048),
  signature: z.string().min(16).max(512),
});

/**
 * Mount V1.1 WebAuthn Passkey management and authentication endpoints.
 */
export function mountPasskeys(app: Hono<Env>, config: Config, auth?: AuthService) {
  const passkeys = auth ? new PasskeyService(auth) : null;

  const service = () => {
    if (!auth || !passkeys)
      throw new AppError("service_unavailable", 503, "Passkey service is not configured.");
    return { auth, passkeys };
  };

  const meta = (c: Context<Env>) => ({ request_id: c.get("requestId"), credits_charged: 0 });

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
    if (!parsed.success) throw new AppError("invalid_parameter", 400, "Invalid passkey request fields.");
    return parsed.data;
  };

  const sessionActor = async (c: Context<Env>, write = false) => {
    const s = service();
    const token = getCookie(c, "soldbench_session") ?? "";
    if (write) {
      if (c.req.header("Origin") !== config.origin)
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      await s.auth.assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
    }
    return { token, actor: await s.auth.sessionIdentity(token) };
  };

  app.use("/v1/auth/passkeys", bodyLimit({ maxSize: 16384 }));
  app.use("/v1/auth/passkeys/*", bodyLimit({ maxSize: 16384 }));

  app.get("/v1/auth/passkeys", async (c) => {
    const { actor } = await sessionActor(c, false);
    const items = await service().passkeys.listPasskeys(actor);
    return c.json({ data: items, meta: meta(c) });
  });

  app.post("/v1/auth/passkeys/register/options", async (c) => {
    const { token, actor } = await sessionActor(c, true);
    const body = await parse(c, registerOptionsShape);
    const options = await service().passkeys.beginRegistration(actor, token, body.label);
    return c.json({ data: options, meta: meta(c) });
  });

  app.post("/v1/auth/passkeys/register/verify", async (c) => {
    const { token, actor } = await sessionActor(c, true);
    const body = await parse(c, registerVerifyShape);
    const created = await service().passkeys.completeRegistration(actor, token, body, c.get("requestId"));
    return c.json({ data: created, meta: meta(c) }, 201);
  });

  app.delete("/v1/auth/passkeys/:id", async (c) => {
    const { token, actor } = await sessionActor(c, true);
    const passkeyId = c.req.param("id");
    if (!UUID_RE.test(passkeyId)) throw new AppError("invalid_parameter", 400, "Invalid passkey identifier.");
    await service().passkeys.revokePasskey(actor, token, passkeyId, c.get("requestId"));
    return c.body(null, 204);
  });

  app.post("/auth/passkeys/login/options", async (c) => {
    if (c.req.header("Origin") !== config.origin)
      throw new AppError("forbidden", 403, "Request origin is not allowed.");
    const body = await parse(c, loginOptionsShape);
    const options = await service().passkeys.beginLogin(body.email);
    return c.json({ data: options, meta: meta(c) });
  });

  app.post("/auth/passkeys/login/verify", async (c) => {
    if (c.req.header("Origin") !== config.origin)
      throw new AppError("forbidden", 403, "Request origin is not allowed.");
    const body = await parse(c, loginVerifyShape);
    const res = await service().passkeys.completeLogin(body, {
      clientId: "offline-in-process",
      locale: c.req.header("Accept-Language")?.toLowerCase().startsWith("zh") ? "zh-CN" : "en",
      requestId: c.get("requestId"),
    });
    setCookie(c, "soldbench_session", res.token, {
      httpOnly: true,
      secure: config.origin.startsWith("https:"),
      sameSite: "Lax",
      path: "/",
      expires: new Date(res.view.expires_at),
    });
    return c.json({ data: res.view, meta: meta(c) });
  });
}
