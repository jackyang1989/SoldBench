import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import { AUTH_SCOPES, type AuthService, type Identity } from "./service.ts";

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export type OAuthScope = (typeof AUTH_SCOPES)[number];

type OAuthClientRow = {
  id: string;
  client_id: string;
  name: string;
  client_type: "public" | "confidential";
  client_secret_hash: string | null;
  redirect_uris: string[];
  allowed_scopes: string[];
  status: "active" | "disabled";
  created_at: Date;
};

type AuthCodeRow = {
  id: string;
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  state_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
};

type OAuthTokenRow = {
  id: string;
  grant_id: string;
  user_id: string;
  client_id: string;
  token_family_id: string;
  access_token_hash: string;
  refresh_token_hash: string | null;
  scopes: string[];
  resource: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
};

function denyOAuth(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

function constantTimeEquals(a: string, b: string) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function validRedirectUri(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    denyOAuth("invalid_parameter", 400, "Redirect URI must be a valid URL.");
  }
  if (u.hash || raw.includes("*"))
    denyOAuth("invalid_parameter", 400, "Redirect URI cannot contain fragments or wildcards.");
  const isLoopback = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !isLoopback)
    denyOAuth("invalid_parameter", 400, "Redirect URI must use https or loopback http.");
  return u.href;
}

function parseScopes(scopeText: string | string[] | undefined, allowed: string[]): OAuthScope[] {
  const parts = Array.isArray(scopeText)
    ? scopeText
    : typeof scopeText === "string"
      ? scopeText.trim().split(/\s+/).filter(Boolean)
      : [];
  const unique = [...new Set(parts)];
  if (!unique.length) denyOAuth("invalid_scope", 400, "At least one valid scope is required.");
  for (const s of unique) {
    if (!AUTH_SCOPES.includes(s as OAuthScope) || !allowed.includes(s))
      denyOAuth("invalid_scope", 400, `Requested scope "${s}" is not permitted for this client.`);
  }
  return unique as OAuthScope[];
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export class OAuthService {
  constructor(readonly auth: AuthService) {}

  mcpResourceUri() {
    return `${this.auth.origin}/mcp`;
  }

  discoveryProtectedResource() {
    return {
      resource: this.mcpResourceUri(),
      authorization_servers: [this.auth.origin],
      scopes_supported: [...AUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "SoldBench Hosted MCP Server",
    };
  }

  discoveryAuthorizationServer() {
    return {
      issuer: this.auth.origin,
      authorization_endpoint: `${this.auth.origin}/oauth/authorize`,
      token_endpoint: `${this.auth.origin}/oauth/token`,
      revocation_endpoint: `${this.auth.origin}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: [...AUTH_SCOPES],
    };
  }

  async registerClient(input: {
    client_id: string;
    name: string;
    client_type: "public" | "confidential";
    redirect_uris: string[];
    allowed_scopes?: OAuthScope[];
  }) {
    if (!CLIENT_ID_RE.test(input.client_id)) denyOAuth("invalid_parameter", 400, "Invalid OAuth client_id.");
    const name = input.name.trim();
    if (!name || name.length > 120) denyOAuth("invalid_parameter", 400, "Invalid OAuth client name.");
    if (!input.redirect_uris.length || input.redirect_uris.length > 10)
      denyOAuth("invalid_parameter", 400, "Provide between 1 and 10 redirect_uris.");
    const uris = [...new Set(input.redirect_uris.map(validRedirectUri))];
    const allowedScopes = parseScopes(input.allowed_scopes ?? [...AUTH_SCOPES], [...AUTH_SCOPES]);
    const clientSecret = input.client_type === "confidential" ? this.auth.crypto.token("sb_ocsec_") : null;
    const secretHash = clientSecret ? this.auth.crypto.hash("oauth.client-secret", clientSecret) : null;

    const row = await transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      return (
        await c.query<OAuthClientRow>(
          `INSERT INTO oauth_clients(client_id,name,client_type,client_secret_hash,redirect_uris,allowed_scopes,status,created_at)
           VALUES($1,$2,$3,$4,$5,$6,'active',$7) RETURNING *`,
          [input.client_id, name, input.client_type, secretHash, JSON.stringify(uris), allowedScopes, now],
        )
      ).rows[0];
    });
    if (!row) throw new Error("oauth_client_insert_failed");
    return {
      client: {
        client_id: row.client_id,
        name: row.name,
        client_type: row.client_type,
        redirect_uris: row.redirect_uris,
        allowed_scopes: row.allowed_scopes,
        status: row.status,
      },
      client_secret: clientSecret,
    };
  }

  private async validateAuthorizeParamsLocked(
    c: Transaction,
    params: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      resource?: string;
    },
  ) {
    if (params.response_type !== "code")
      denyOAuth("unsupported_response_type", 400, "Only response_type=code is supported.");
    if (!params.client_id || !CLIENT_ID_RE.test(params.client_id))
      denyOAuth("invalid_client", 400, "Invalid OAuth client_id.");
    const client = (
      await c.query<OAuthClientRow>("SELECT * FROM oauth_clients WHERE client_id=$1", [params.client_id])
    ).rows[0];
    if (client?.status !== "active") denyOAuth("invalid_client", 400, "Unknown or inactive OAuth client.");
    if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri))
      denyOAuth("invalid_request", 400, "redirect_uri does not exactly match a registered URI.");
    if (!params.state || params.state.length < 8 || params.state.length > 256)
      denyOAuth("invalid_request", 400, "A client state parameter (8-256 characters) is required.");
    if (params.code_challenge_method !== "S256")
      denyOAuth("invalid_request", 400, "PKCE code_challenge_method must be S256.");
    if (!params.code_challenge || !CODE_CHALLENGE_RE.test(params.code_challenge))
      denyOAuth("invalid_request", 400, "Invalid PKCE code_challenge.");
    const expectedResource = this.mcpResourceUri();
    const resource = params.resource ?? expectedResource;
    if (resource !== expectedResource)
      denyOAuth("invalid_target", 400, `resource must equal ${expectedResource}.`);
    const requestedScopes = parseScopes(params.scope, client.allowed_scopes);
    return {
      client,
      redirectUri: params.redirect_uri,
      state: params.state,
      codeChallenge: params.code_challenge,
      resource,
      requestedScopes,
    };
  }

  async previewAuthorize(
    identity: Identity,
    params: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      resource?: string;
    },
  ) {
    return transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      await this.auth.assertIdentityLocked(c, identity, "sold:read", now);
      const validated = await this.validateAuthorizeParamsLocked(c, params);
      return {
        client: {
          client_id: validated.client.client_id,
          name: validated.client.name,
          client_type: validated.client.client_type,
        },
        redirect_uri: validated.redirectUri,
        scopes: validated.requestedScopes,
        resource: validated.resource,
        state: validated.state,
        code_challenge_method: "S256" as const,
        consent_required: true,
      };
    });
  }

  async approveAuthorize(
    identity: Identity,
    input: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      resource?: string;
      approved: boolean;
    },
    requestId: string,
  ) {
    return transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      const user = await this.auth.assertIdentityLocked(c, identity, "sold:read", now);
      const validated = await this.validateAuthorizeParamsLocked(c, input);
      const target = new URL(validated.redirectUri);

      if (!input.approved) {
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("state", validated.state);
        await this.auth.recordAuditLocked(
          c,
          user.id,
          "oauth.authorize_denied",
          validated.client.client_id,
          requestId,
        );
        return { approved: false as const, redirect_to: target.href, code: null, state: validated.state };
      }

      const code = this.auth.crypto.token("sb_oc_");
      const codeHash = this.auth.crypto.hash("oauth.auth-code", code);
      const stateHash = this.auth.crypto.hash("oauth.state", validated.state);
      const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_MS);
      await c.query(
        `INSERT INTO oauth_authorization_codes(
           code_hash,client_id,user_id,redirect_uri,scopes,
           code_challenge,code_challenge_method,resource,state_hash,expires_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,'S256',$7,$8,$9,$10)`,
        [
          codeHash,
          validated.client.client_id,
          user.id,
          validated.redirectUri,
          validated.requestedScopes,
          validated.codeChallenge,
          validated.resource,
          stateHash,
          expiresAt,
          now,
        ],
      );
      await this.auth.recordAuditLocked(
        c,
        user.id,
        "oauth.authorize_approved",
        validated.client.client_id,
        requestId,
      );
      target.searchParams.set("code", code);
      target.searchParams.set("state", validated.state);
      return {
        approved: true as const,
        code,
        state: validated.state,
        redirect_to: target.href,
        expires_at: expiresAt.toISOString(),
      };
    });
  }

  private assertClientAuth(client: OAuthClientRow | undefined, clientSecret?: string): OAuthClientRow {
    if (client?.status !== "active") denyOAuth("invalid_client", 401, "Invalid OAuth client.");
    if (client.client_type === "confidential") {
      if (!clientSecret || !client.client_secret_hash)
        denyOAuth("invalid_client", 401, "Client authentication is required.");
      const givenHash = this.auth.crypto.hash("oauth.client-secret", clientSecret);
      if (!constantTimeEquals(givenHash, client.client_secret_hash))
        denyOAuth("invalid_client", 401, "Invalid client credentials.");
    }
    return client;
  }

  private async revokeClientGrantAndTokensCommitted(userId: string, clientId: string, familyId?: string) {
    await transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      if (familyId) {
        await c.query("UPDATE oauth_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE token_family_id=$1", [
          familyId,
          now,
        ]);
      } else {
        await c.query(
          "UPDATE oauth_tokens SET revoked_at=COALESCE(revoked_at,$3) WHERE user_id=$1 AND client_id=$2",
          [userId, clientId, now],
        );
      }
      await c.query(
        "UPDATE oauth_grants SET status='revoked',revoked_at=COALESCE(revoked_at,$3),updated_at=$3 WHERE user_id=$1 AND client_id=$2",
        [userId, clientId, now],
      );
    });
  }

  async exchangeToken(
    input: {
      grant_type: string;
      client_id?: string;
      client_secret?: string;
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
      resource?: string;
      refresh_token?: string;
      scope?: string;
    },
    requestId: string,
  ) {
    if (input.grant_type === "authorization_code") {
      const codeVerifier = input.code_verifier;
      if (
        !input.client_id ||
        !CLIENT_ID_RE.test(input.client_id) ||
        !input.code ||
        !input.redirect_uri ||
        !codeVerifier ||
        !CODE_VERIFIER_RE.test(codeVerifier)
      )
        denyOAuth("invalid_request", 400, "Missing or invalid authorization_code grant parameters.");

      const codeHash = this.auth.crypto.hash("oauth.auth-code", input.code);
      const outcome = await transaction(this.auth.db, async (c) => {
        const now = await this.auth.now(c);
        const client = this.assertClientAuth(
          (await c.query<OAuthClientRow>("SELECT * FROM oauth_clients WHERE client_id=$1", [input.client_id]))
            .rows[0],
          input.client_secret,
        );
        const codeRow = (
          await c.query<AuthCodeRow>(
            "SELECT * FROM oauth_authorization_codes WHERE code_hash=$1 FOR UPDATE",
            [codeHash],
          )
        ).rows[0];
        if (!codeRow || codeRow.client_id !== client.client_id)
          denyOAuth("invalid_grant", 400, "Authorization code is invalid.");
        if (codeRow.consumed_at) {
          return { replay: true as const, userId: codeRow.user_id, clientId: codeRow.client_id };
        }
        if (codeRow.expires_at <= now) denyOAuth("invalid_grant", 400, "Authorization code expired.");
        if (codeRow.redirect_uri !== input.redirect_uri)
          denyOAuth("invalid_grant", 400, "redirect_uri mismatch.");
        const resource = input.resource ?? codeRow.resource;
        if (resource !== codeRow.resource) denyOAuth("invalid_target", 400, "OAuth resource mismatch.");
        if (!constantTimeEquals(pkceChallenge(codeVerifier), codeRow.code_challenge))
          denyOAuth("invalid_grant", 400, "PKCE verification failed.");

        const user = (
          await c.query<{ id: string; status: string; email_verified_at: Date | null }>(
            "SELECT id,status,email_verified_at FROM users WHERE id=$1 FOR UPDATE",
            [codeRow.user_id],
          )
        ).rows[0];
        if (user?.status !== "active" || !user.email_verified_at)
          denyOAuth("invalid_grant", 403, "User account is not eligible for OAuth tokens.");

        await c.query("UPDATE oauth_authorization_codes SET consumed_at=$2 WHERE id=$1", [codeRow.id, now]);
        const grant = (
          await c.query<{ id: string }>(
            `INSERT INTO oauth_grants(user_id,client_id,scopes,resource,status,created_at,updated_at,revoked_at)
             VALUES($1,$2,$3,$4,'active',$5,$5,NULL)
             ON CONFLICT(user_id,client_id)
             DO UPDATE SET scopes=excluded.scopes,resource=excluded.resource,status='active',updated_at=excluded.updated_at,revoked_at=NULL
             RETURNING id`,
            [codeRow.user_id, codeRow.client_id, codeRow.scopes, codeRow.resource, now],
          )
        ).rows[0];
        if (!grant) throw new Error("oauth_grant_upsert_failed");

        const familyId = randomUUID();
        const accessToken = this.auth.crypto.token("sb_oa_");
        const refreshToken = this.auth.crypto.token("sb_or_");
        const accessExp = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
        const refreshExp = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

        await c.query(
          `INSERT INTO oauth_tokens(
             grant_id,user_id,client_id,token_family_id,access_token_hash,refresh_token_hash,
             scopes,resource,access_expires_at,refresh_expires_at,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            grant.id,
            codeRow.user_id,
            codeRow.client_id,
            familyId,
            this.auth.crypto.hash("oauth.access-token", accessToken),
            this.auth.crypto.hash("oauth.refresh-token", refreshToken),
            codeRow.scopes,
            codeRow.resource,
            accessExp,
            refreshExp,
            now,
          ],
        );
        await this.auth.recordAuditLocked(
          c,
          codeRow.user_id,
          "oauth.token_issued",
          codeRow.client_id,
          requestId,
        );
        return {
          replay: false as const,
          payload: {
            access_token: accessToken,
            token_type: "Bearer" as const,
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
            refresh_token: refreshToken,
            scope: codeRow.scopes.join(" "),
            resource: codeRow.resource,
          },
        };
      });

      if (outcome.replay) {
        await this.revokeClientGrantAndTokensCommitted(outcome.userId, outcome.clientId);
        denyOAuth("invalid_grant", 400, "Authorization code replay detected; associated tokens revoked.");
      }
      return outcome.payload;
    }

    if (input.grant_type === "refresh_token") {
      if (!input.client_id || !CLIENT_ID_RE.test(input.client_id) || !input.refresh_token)
        denyOAuth("invalid_request", 400, "Missing or invalid refresh_token parameters.");
      if (!/^sb_or_[A-Za-z0-9_-]{43}$/.test(input.refresh_token))
        denyOAuth("invalid_grant", 401, "Invalid refresh token.");

      const refreshHash = this.auth.crypto.hash("oauth.refresh-token", input.refresh_token);
      const outcome = await transaction(this.auth.db, async (c) => {
        const now = await this.auth.now(c);
        const client = this.assertClientAuth(
          (await c.query<OAuthClientRow>("SELECT * FROM oauth_clients WHERE client_id=$1", [input.client_id]))
            .rows[0],
          input.client_secret,
        );
        const tokenRow = (
          await c.query<OAuthTokenRow & { grant_status: string; user_status: string }>(
            `SELECT t.*,g.status AS grant_status,u.status AS user_status
             FROM oauth_tokens t
             JOIN oauth_grants g ON g.id=t.grant_id
             JOIN users u ON u.id=t.user_id
             WHERE t.refresh_token_hash=$1 FOR UPDATE OF t`,
            [refreshHash],
          )
        ).rows[0];

        if (!tokenRow || tokenRow.client_id !== client.client_id)
          denyOAuth("invalid_grant", 401, "Refresh token is not valid for this client.");
        if (tokenRow.rotated_at) {
          return {
            replay: true as const,
            userId: tokenRow.user_id,
            clientId: tokenRow.client_id,
            familyId: tokenRow.token_family_id,
          };
        }
        if (
          tokenRow.revoked_at ||
          tokenRow.refresh_expires_at <= now ||
          tokenRow.grant_status !== "active" ||
          tokenRow.user_status !== "active"
        )
          denyOAuth("invalid_grant", 401, "Refresh token is revoked or expired.");

        const requestedScopes = input.scope
          ? parseScopes(input.scope, tokenRow.scopes)
          : (tokenRow.scopes as OAuthScope[]);
        const nextAccess = this.auth.crypto.token("sb_oa_");
        const nextRefresh = this.auth.crypto.token("sb_or_");
        const accessExp = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
        const refreshExp = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

        await c.query(
          "UPDATE oauth_tokens SET rotated_at=$2,revoked_at=COALESCE(revoked_at,$2) WHERE id=$1",
          [tokenRow.id, now],
        );
        await c.query(
          `INSERT INTO oauth_tokens(
             grant_id,user_id,client_id,token_family_id,access_token_hash,refresh_token_hash,
             scopes,resource,access_expires_at,refresh_expires_at,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            tokenRow.grant_id,
            tokenRow.user_id,
            tokenRow.client_id,
            tokenRow.token_family_id,
            this.auth.crypto.hash("oauth.access-token", nextAccess),
            this.auth.crypto.hash("oauth.refresh-token", nextRefresh),
            requestedScopes,
            tokenRow.resource,
            accessExp,
            refreshExp,
            now,
          ],
        );
        await this.auth.recordAuditLocked(
          c,
          tokenRow.user_id,
          "oauth.token_refreshed",
          tokenRow.client_id,
          requestId,
        );
        return {
          replay: false as const,
          payload: {
            access_token: nextAccess,
            token_type: "Bearer" as const,
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
            refresh_token: nextRefresh,
            scope: requestedScopes.join(" "),
            resource: tokenRow.resource,
          },
        };
      });

      if (outcome.replay) {
        await this.revokeClientGrantAndTokensCommitted(outcome.userId, outcome.clientId, outcome.familyId);
        denyOAuth("invalid_grant", 401, "Rotated refresh token replay detected; token family revoked.");
      }
      return outcome.payload;
    }

    denyOAuth(
      "unsupported_grant_type",
      400,
      "Supported grant types are authorization_code and refresh_token.",
    );
  }

  async revokeToken(input: { token: string; client_id?: string; client_secret?: string }) {
    if (!input.token || input.token.length > 256)
      denyOAuth("invalid_request", 400, "A token parameter is required.");
    await transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      if (input.client_id) {
        if (!CLIENT_ID_RE.test(input.client_id)) denyOAuth("invalid_client", 401, "Invalid client_id.");
        this.assertClientAuth(
          (await c.query<OAuthClientRow>("SELECT * FROM oauth_clients WHERE client_id=$1", [input.client_id]))
            .rows[0],
          input.client_secret,
        );
      }
      const accessHash = this.auth.crypto.hash("oauth.access-token", input.token);
      const refreshHash = this.auth.crypto.hash("oauth.refresh-token", input.token);
      const row = (
        await c.query<OAuthTokenRow>(
          "SELECT * FROM oauth_tokens WHERE access_token_hash=$1 OR refresh_token_hash=$2 FOR UPDATE",
          [accessHash, refreshHash],
        )
      ).rows[0];
      if (!row) return;
      if (input.client_id && row.client_id !== input.client_id)
        denyOAuth("invalid_client", 403, "Token belongs to a different client.");
      await c.query(
        "UPDATE oauth_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1 OR ($3 AND token_family_id=$4)",
        [row.id, now, row.refresh_token_hash === refreshHash, row.token_family_id],
      );
    });
  }

  async listGrants(identity: Identity) {
    return transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      const user = await this.auth.assertIdentityLocked(c, identity, "sold:read", now);
      return (
        await c.query<{
          id: string;
          client_id: string;
          client_name: string;
          client_type: string;
          scopes: string[];
          resource: string;
          status: string;
          created_at: Date;
          updated_at: Date;
          revoked_at: Date | null;
        }>(
          `SELECT g.id,g.client_id,cl.name AS client_name,cl.client_type,g.scopes,g.resource,g.status,
                  g.created_at,g.updated_at,g.revoked_at
           FROM oauth_grants g
           JOIN oauth_clients cl ON cl.client_id=g.client_id
           WHERE g.user_id=$1
           ORDER BY g.updated_at DESC, g.id ASC`,
          [user.id],
        )
      ).rows.map((r) => ({
        id: r.id,
        client_id: r.client_id,
        client_name: r.client_name,
        client_type: r.client_type,
        scopes: r.scopes,
        resource: r.resource,
        status: r.status,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
        revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
      }));
    });
  }

  async revokeGrant(identity: Identity, grantId: string, requestId: string) {
    await transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      const user = await this.auth.assertIdentityLocked(c, identity, "sold:read", now);
      const grant = (
        await c.query<{ id: string; client_id: string }>(
          `UPDATE oauth_grants
           SET status='revoked',revoked_at=COALESCE(revoked_at,$3),updated_at=$3
           WHERE id=$1 AND user_id=$2
           RETURNING id,client_id`,
          [grantId, user.id, now],
        )
      ).rows[0];
      if (!grant) denyOAuth("not_found", 404, "OAuth grant not found.");
      await c.query("UPDATE oauth_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE grant_id=$1", [
        grant.id,
        now,
      ]);
      await this.auth.recordAuditLocked(c, user.id, "oauth.grant_revoked", grant.client_id, requestId);
    });
  }
}
