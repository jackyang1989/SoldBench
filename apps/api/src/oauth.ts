import { type AuthService, OAuthService } from "@soldbench/auth";
import { AppError, type Config } from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import * as z from "zod";

type Env = { Variables: { requestId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const authorizeBodyShape = z.strictObject({
  response_type: z.string().min(1).max(32),
  client_id: z.string().min(8).max(128),
  redirect_uri: z.string().min(1).max(2048),
  scope: z.string().min(1).max(256),
  state: z.string().min(8).max(256),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.string().min(1).max(16),
  resource: z.string().min(1).max(2048).optional(),
  approved: z.boolean(),
});

function parseBasicClientAuth(header: string | undefined): { client_id?: string; client_secret?: string } {
  if (!header?.startsWith("Basic ")) return {};
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx <= 0) return {};
    return {
      client_id: decodeURIComponent(decoded.slice(0, idx)),
      client_secret: decodeURIComponent(decoded.slice(idx + 1)),
    };
  } catch {
    return {};
  }
}

async function parseOAuthPayload(c: Context<Env>): Promise<Record<string, unknown>> {
  const ct = c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (ct === "application/json") {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError("invalid_request", 400, "Invalid JSON request body.");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError("invalid_request", 400, "Expected JSON object body.");
    return raw as Record<string, unknown>;
  }
  if (ct === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(await c.req.text());
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      if (k in out) throw new AppError("invalid_request", 400, `Duplicate parameter: ${k}.`);
      out[k] = v;
    }
    return out;
  }
  throw new AppError("invalid_parameter", 415, "Use application/x-www-form-urlencoded or application/json.");
}

/**
 * Mount V1.1 Hosted MCP OAuth 2.1 / PKCE discovery, consent, token/revocation, and grant management endpoints.
 */
export function mountOAuth(app: Hono<Env>, config: Config, auth?: AuthService) {
  const oauth = auth ? new OAuthService(auth) : null;

  const service = () => {
    if (!auth || !oauth) throw new AppError("service_unavailable", 503, "OAuth service is not configured.");
    return { auth, oauth };
  };

  const sessionActor = async (c: Context<Env>, write = false) => {
    const s = service();
    const token = getCookie(c, "soldbench_session") ?? "";
    if (write) {
      if (c.req.header("Origin") !== config.origin)
        throw new AppError("forbidden", 403, "Request origin is not allowed.");
      await s.auth.assertCsrf(token, c.req.header("X-CSRF-Token") ?? "");
    }
    return s.auth.sessionIdentity(token);
  };

  const meta = (c: Context<Env>) => ({ request_id: c.get("requestId"), credits_charged: 0 });

  app.use("/oauth/*", bodyLimit({ maxSize: 32768 }));
  app.use("/v1/oauth/*", bodyLimit({ maxSize: 16384 }));

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(service().oauth.discoveryProtectedResource()),
  );

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(service().oauth.discoveryAuthorizationServer()),
  );

  app.get("/oauth/authorize", async (c) => {
    const actor = await sessionActor(c, false);
    const p = new URL(c.req.url).searchParams;
    const preview = await service().oauth.previewAuthorize(actor, {
      response_type: p.get("response_type") ?? undefined,
      client_id: p.get("client_id") ?? undefined,
      redirect_uri: p.get("redirect_uri") ?? undefined,
      scope: p.get("scope") ?? undefined,
      state: p.get("state") ?? undefined,
      code_challenge: p.get("code_challenge") ?? undefined,
      code_challenge_method: p.get("code_challenge_method") ?? undefined,
      resource: p.get("resource") ?? undefined,
    });
    return c.json({ data: preview, meta: meta(c) });
  });

  app.post("/oauth/authorize", async (c) => {
    const actor = await sessionActor(c, true);
    if (c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json")
      throw new AppError("invalid_parameter", 415, "Use application/json.");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError("invalid_parameter", 400, "Invalid JSON.");
    }
    const parsed = authorizeBodyShape.safeParse(raw);
    if (!parsed.success)
      throw new AppError("invalid_parameter", 400, "Invalid authorization consent fields.");
    const result = await service().oauth.approveAuthorize(actor, parsed.data, c.get("requestId"));
    return c.json({ data: result, meta: meta(c) });
  });

  app.post("/oauth/token", async (c) => {
    const body = await parseOAuthPayload(c);
    const basic = parseBasicClientAuth(c.req.header("Authorization"));
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    const token = await service().oauth.exchangeToken(
      {
        grant_type: str(body.grant_type) ?? "",
        client_id: str(body.client_id) ?? basic.client_id,
        client_secret: str(body.client_secret) ?? basic.client_secret,
        code: str(body.code),
        redirect_uri: str(body.redirect_uri),
        code_verifier: str(body.code_verifier),
        resource: str(body.resource),
        refresh_token: str(body.refresh_token),
        scope: str(body.scope),
      },
      c.get("requestId"),
    );
    return c.json(token, 200);
  });

  app.post("/oauth/revoke", async (c) => {
    const body = await parseOAuthPayload(c);
    const basic = parseBasicClientAuth(c.req.header("Authorization"));
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    await service().oauth.revokeToken({
      token: str(body.token) ?? "",
      client_id: str(body.client_id) ?? basic.client_id,
      client_secret: str(body.client_secret) ?? basic.client_secret,
    });
    return c.json({ revoked: true }, 200);
  });

  app.get("/v1/oauth/grants", async (c) => {
    const actor = await sessionActor(c, false);
    const grants = await service().oauth.listGrants(actor);
    return c.json({ data: grants, meta: meta(c) });
  });

  app.delete("/v1/oauth/grants/:id", async (c) => {
    const actor = await sessionActor(c, true);
    const grantId = c.req.param("id");
    if (!UUID_RE.test(grantId)) throw new AppError("invalid_parameter", 400, "Invalid grant identifier.");
    await service().oauth.revokeGrant(actor, grantId, c.get("requestId"));
    return c.body(null, 204);
  });
}
