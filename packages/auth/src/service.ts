import { randomBytes, randomUUID } from "node:crypto";
import { type Database, type Transaction, transaction } from "@soldbench/db";
import { AppError, type Locale } from "@soldbench/shared";
import { generateSecret, generateURI, verify } from "otplib";
import { AuthCrypto, type AuthSecrets, hashPassword, verifyPassword } from "./crypto.ts";
export const AUTH_VERSION = "1.0.0";
const scopes = ["sold:read", "jobs:read", "usage:read"];
type User = {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  credential_version: number;
  email_verified_at: Date | null;
  is_admin: boolean;
};
type Session = {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  credential_version: number;
  mfa_pending: boolean;
  expires_at: Date;
  revoked_at: Date | null;
  authenticated_at: Date;
  mfa_at: Date | null;
  created_at: Date;
  device_label: string | null;
};
export type Identity = {
  userId: string;
  sessionId: string | null;
  keyId: string | null;
  scopes: string[];
  emailVerified: boolean;
  mfaPending: boolean;
  csrfToken?: string;
};
export type AuthContext = { clientId: string; locale: Locale; requestId: string };
function deny(code = "unauthenticated", status = 401, message = "Authentication is required."): never {
  throw new AppError(code, status, message);
}
export function emailAddress(value: unknown): string {
  if (typeof value !== "string") deny("invalid_parameter", 400, "Invalid email address.");
  const email = value.trim().normalize("NFC").toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    Array.from(email).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    deny("invalid_parameter", 400, "Invalid email address.");
  return email;
}
export function passwordValue(value: unknown, create = true): string {
  if (
    typeof value !== "string" ||
    value.length < (create ? 12 : 1) ||
    value.length > 128 ||
    Buffer.byteLength(value) > 512
  )
    deny("invalid_parameter", 400, "Invalid password length.");
  return value;
}
function validToken(value: string) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) deny("token_invalid", 410, "This link is invalid or expired.");
}
export class AuthService {
  readonly crypto: AuthCrypto;
  constructor(
    readonly db: Database,
    secrets: AuthSecrets,
    readonly origin: string,
    readonly clock?: () => string,
  ) {
    this.crypto = new AuthCrypto(secrets);
  }
  async now(c: Transaction | Database = this.db): Promise<Date> {
    const time = this.clock
      ? new Date(this.clock())
      : (await c.query("SELECT clock_timestamp() t")).rows[0].t;
    if (!Number.isFinite(time.getTime())) throw new Error("invalid_auth_clock");
    return time;
  }
  private async rate(domain: string, identity: string, limit: number, seconds: number) {
    await transaction(this.db, async (c) => {
      const now = await this.now(c),
        start = new Date(Math.floor(now.getTime() / (seconds * 1000)) * seconds * 1000),
        hash = this.crypto.hash(`auth.rate:${domain}`, identity);
      const result = await c.query(
        "INSERT INTO auth_rate_windows(bucket_hash,window_start,used) VALUES($1,$2,1) ON CONFLICT(bucket_hash,window_start) DO UPDATE SET used=auth_rate_windows.used+1 WHERE auth_rate_windows.used<$3 RETURNING used",
        [hash, start, limit],
      );
      if (!result.rowCount) deny("rate_limited", 429, "Too many attempts. Try again later.");
    });
  }
  private async publicRate(action: string, email: string, context: AuthContext) {
    await this.rate(`actor:${action}`, context.clientId, 20, 900);
    await this.rate(`email:${action}`, email, 5, 900);
  }
  private async user(c: Transaction, id: string): Promise<User> {
    const user = (
      await c.query<User>(
        "SELECT u.*,EXISTS(SELECT 1 FROM admin_roles a WHERE a.user_id=u.id AND a.role='admin') AS is_admin FROM users u WHERE u.id=$1 FOR UPDATE OF u",
        [id],
      )
    ).rows[0];
    if (!user || !["pending", "active"].includes(user.status)) deny();
    return user;
  }
  private async audit(c: Transaction, userId: string, action: string, objectId: string, requestId: string) {
    await c.query(
      "INSERT INTO audit_events(actor_id,action,object_type,object_id,request_id) VALUES($1,$2,'auth',$3,$4)",
      [userId, action, objectId, requestId],
    );
  }
  private async mail(
    c: Transaction,
    user: User,
    purpose: "verify_email" | "reset_password",
    context: AuthContext,
    now: Date,
  ) {
    const count = (
      await c.query(
        "SELECT count(*)::int n,max(created_at) last FROM auth_tokens WHERE user_id=$1 AND purpose=$2 AND created_at>$3",
        [user.id, purpose, new Date(now.getTime() - 3600000)],
      )
    ).rows[0];
    if (count.n >= 5 || (count.last && now.getTime() - count.last.getTime() < 60000)) return;
    const token = this.crypto.token(purpose === "verify_email" ? "sb_v_" : "sb_r_"),
      id = randomUUID(),
      messageId = randomUUID(),
      expires = new Date(now.getTime() + (purpose === "verify_email" ? 86400000 : 1800000));
    await c.query(
      "UPDATE auth_tokens SET consumed_at=$3 WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL",
      [user.id, purpose, now],
    );
    await c.query(
      "INSERT INTO auth_tokens(id,user_id,token_hash,purpose,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [id, user.id, this.crypto.hash(`auth.token:${purpose}`, token), purpose, expires, now],
    );
    const zh = context.locale === "zh-CN",
      link = `${this.origin}${zh ? "/zh-CN" : ""}/${purpose === "verify_email" ? "verify-email" : "reset-password"}#token=${token}`,
      subject =
        purpose === "verify_email"
          ? zh
            ? "验证 SoldBench 邮箱"
            : "Verify your SoldBench email"
          : zh
            ? "重置 SoldBench 密码"
            : "Reset your SoldBench password",
      text = zh
        ? `${subject}。请打开以下链接：${link}。本地离线邮件，未真实发送。`
        : `${subject}. Open this link: ${link}. Local offline message; not sent.`;
    const payload = this.crypto.seal(
      { to: user.email, subject, text, link, expires_at: expires.toISOString() },
      `auth.mail:${messageId}`,
    );
    await c.query(
      "INSERT INTO auth_mail_outbox(id,user_id,token_id,purpose,locale,translation_revision,encrypted_payload,created_at) VALUES($1,$2,$3,$4,$5,'1',$6,$7)",
      [messageId, user.id, id, purpose, context.locale, payload, now],
    );
    await c.query(
      "INSERT INTO outbox(event_key,kind,payload,available_at) VALUES($1,'auth.mail_queued',$2,$3)",
      [
        `auth-mail:${messageId}`,
        JSON.stringify({ messageId, locale: context.locale, translationRevision: "1" }),
        now,
      ],
    );
  }
  async register(input: { email: unknown; password: unknown; terms_version: unknown }, context: AuthContext) {
    const email = emailAddress(input.email),
      password = passwordValue(input.password);
    if (
      typeof input.terms_version !== "string" ||
      !input.terms_version.trim() ||
      input.terms_version.length > 80
    )
      deny("invalid_parameter", 400, "Accept the current terms.");
    await this.publicRate("register", email, context);
    const hash = await hashPassword(password);
    await transaction(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        this.crypto.hash("auth.email-lock", email),
      ]);
      if ((await c.query("SELECT 1 FROM users WHERE lower(email)=$1", [email])).rowCount) return;
      const now = await this.now(c),
        user = (
          await c.query<User>(
            "INSERT INTO users(email,password_hash,terms_version,created_at,updated_at) VALUES($1,$2,$3,$4,$4) RETURNING *",
            [email, hash, input.terms_version, now],
          )
        ).rows[0];
      if (!user) throw new Error("auth_insert_failed");
      await this.mail(c, user, "verify_email", context, now);
      await this.audit(c, user.id, "auth.registered", user.id, context.requestId);
    });
  }
  async requestMail(emailValue: unknown, purpose: "verify_email" | "reset_password", context: AuthContext) {
    const email = emailAddress(emailValue);
    await this.publicRate(`mail:${purpose}`, email, context);
    const row = (
      await this.db.query("SELECT id FROM users WHERE lower(email)=$1 AND status IN ('pending','active')", [
        email,
      ])
    ).rows[0];
    if (!row) return;
    await transaction(this.db, async (c) => {
      const user = await this.user(c, row.id);
      if (purpose === "verify_email" && user.email_verified_at) return;
      await this.mail(c, user, purpose, context, await this.now(c));
    });
  }
  private async tokenCommand<T>(
    token: string,
    purpose: "verify_email" | "reset_password",
    work: (c: Transaction, user: User, now: Date) => Promise<T>,
  ) {
    validToken(token);
    const hash = this.crypto.hash(`auth.token:${purpose}`, token),
      found = (
        await this.db.query("SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose=$2", [
          hash,
          purpose,
        ])
      ).rows[0];
    if (!found) deny("token_invalid", 410, "This link is invalid or expired.");
    return transaction(this.db, async (c) => {
      const user = await this.user(c, found.user_id),
        now = await this.now(c),
        row = (
          await c.query(
            "SELECT * FROM auth_tokens WHERE token_hash=$1 AND user_id=$2 AND purpose=$3 FOR UPDATE",
            [hash, user.id, purpose],
          )
        ).rows[0];
      if (!row || row.consumed_at || row.expires_at <= now)
        deny("token_invalid", 410, "This link is invalid or expired.");
      await c.query("UPDATE auth_tokens SET consumed_at=$2 WHERE id=$1", [row.id, now]);
      return work(c, user, now);
    });
  }
  async verifyEmail(token: string, context: AuthContext) {
    await this.rate("verify", context.clientId, 20, 900);
    return this.tokenCommand(token, "verify_email", async (c, user, now) => {
      if (!user.email_verified_at) {
        await c.query(
          "UPDATE users SET status='active',email_verified_at=$2,free_anchor_at=$2,updated_at=$2 WHERE id=$1",
          [user.id, now],
        );
        await c.query(
          "INSERT INTO outbox(event_key,kind,payload,available_at) VALUES($1,'auth.email_verified',$2,$3) ON CONFLICT DO NOTHING",
          [`email-verified:${user.id}`, JSON.stringify({ userId: user.id, anchor: now.toISOString() }), now],
        );
      }
      await this.audit(c, user.id, "auth.email_verified", user.id, context.requestId);
    });
  }
  async resetPassword(token: string, newPassword: unknown, context: AuthContext) {
    await this.rate("reset-confirm", context.clientId, 10, 900);
    const hash = await hashPassword(passwordValue(newPassword));
    return this.tokenCommand(token, "reset_password", async (c, user, now) => {
      await c.query(
        "UPDATE users SET password_hash=$2,credential_version=credential_version+1,updated_at=$3 WHERE id=$1",
        [user.id, hash, now],
      );
      await c.query("UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL", [
        user.id,
        now,
      ]);
      await c.query(
        "UPDATE auth_tokens SET consumed_at=$2 WHERE user_id=$1 AND purpose='reset_password' AND consumed_at IS NULL",
        [user.id, now],
      );
      await this.audit(c, user.id, "auth.password_reset", user.id, context.requestId);
    });
  }
  private async session(c: Transaction, token: string, allowPending = false) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) deny();
    const hash = this.crypto.hash("auth.session", token),
      found = (await c.query("SELECT user_id FROM sessions WHERE token_hash=$1", [hash])).rows[0];
    if (!found) deny();
    const user = await this.user(c, found.user_id),
      now = await this.now(c),
      row = (
        await c.query<Session>("SELECT * FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR UPDATE", [
          hash,
          user.id,
        ])
      ).rows[0];
    if (
      !row ||
      row.revoked_at ||
      row.expires_at <= now ||
      row.credential_version !== user.credential_version ||
      (user.is_admin && now.getTime() - row.created_at.getTime() >= 43200000)
    )
      deny();
    if (user.is_admin && (!row.mfa_at || !(await this.enabledMfa(c, user.id)))) row.mfa_pending = true;
    if (!allowPending && row.mfa_pending) deny("mfa_required", 403, "Complete multi-factor authentication.");
    return { user, row, now };
  }
  private async enabledMfa(c: Transaction, userId: string) {
    return (await c.query("SELECT * FROM user_mfa WHERE user_id=$1 AND state='enabled' FOR UPDATE", [userId]))
      .rows[0];
  }
  private async sensitive(c: Transaction, user: User, row: Session, now: Date) {
    const mfa = await this.enabledMfa(c, user.id);
    if (
      now.getTime() - row.authenticated_at.getTime() > 600000 ||
      (mfa && (!row.mfa_at || now.getTime() - row.mfa_at.getTime() > 600000))
    )
      deny("reauthentication_required", 403, "Reauthenticate before this action.");
    if (user.is_admin && !mfa) deny("mfa_required", 403, "An administrator must enable MFA.");
  }
  async login(emailValue: unknown, passwordInput: unknown, context: AuthContext) {
    const email = emailAddress(emailValue),
      password = passwordValue(passwordInput, false);
    await this.publicRate("login", email, context);
    const snapshot = (await this.db.query<User>("SELECT * FROM users WHERE lower(email)=$1", [email]))
      .rows[0];
    const matches = await verifyPassword(password, snapshot?.password_hash ?? null);
    if (!snapshot || !matches) deny("unauthenticated", 401, "Invalid email or password.");
    return transaction(this.db, async (c) => {
      const user = await this.user(c, snapshot.id);
      if (user.password_hash !== snapshot.password_hash) deny();
      const now = await this.now(c),
        mfa = await this.enabledMfa(c, user.id),
        token = this.crypto.token("sb_s_"),
        csrf = this.crypto.hash("auth.csrf", token),
        expires = new Date(now.getTime() + (user.is_admin ? 43200000 : 604800000));
      await c.query(
        "UPDATE sessions SET revoked_at=$2 WHERE id IN (SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY created_at DESC,id OFFSET 19)",
        [user.id, now],
      );
      await c.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,credential_version,mfa_pending,expires_at,authenticated_at,created_at,device_label) VALUES($1,$2,$3,$4,$5,$6,$7,$7,'Web session')",
        [
          user.id,
          this.crypto.hash("auth.session", token),
          this.crypto.hash("auth.csrf-store", csrf),
          user.credential_version,
          Boolean(mfa) || user.is_admin,
          expires,
          now,
        ],
      );
      await this.audit(c, user.id, "auth.login", user.id, context.requestId);
      return {
        token,
        view: {
          user_id: user.id,
          email_verified: Boolean(user.email_verified_at),
          expires_at: expires.toISOString(),
          csrf_token: csrf,
          mfa_required: Boolean(mfa) || user.is_admin,
        },
      };
    });
  }
  async sessionIdentity(token: string, allowPending = false): Promise<Identity> {
    return transaction(this.db, async (c) => {
      const { user, row } = await this.session(c, token, allowPending);
      return {
        userId: user.id,
        sessionId: row.id,
        keyId: null,
        scopes: scopes.slice(),
        emailVerified: Boolean(user.email_verified_at),
        mfaPending: row.mfa_pending,
        csrfToken: this.crypto.hash("auth.csrf", token),
      };
    });
  }
  private async rotateSession(c: Transaction, user: User, row: Session, now: Date, mfa: boolean) {
    const token = this.crypto.token("sb_s_"),
      csrf = this.crypto.hash("auth.csrf", token);
    await c.query(
      "UPDATE sessions SET token_hash=$2,csrf_hash=$3,mfa_pending=false,mfa_at=CASE WHEN $4 THEN $5 ELSE mfa_at END WHERE id=$1",
      [row.id, this.crypto.hash("auth.session", token), this.crypto.hash("auth.csrf-store", csrf), mfa, now],
    );
    return {
      token,
      view: {
        user_id: user.id,
        email_verified: Boolean(user.email_verified_at),
        expires_at: row.expires_at.toISOString(),
        csrf_token: csrf,
        mfa_required: false,
      },
    };
  }
  async assertCsrf(token: string, csrf: string) {
    return transaction(this.db, async (c) => {
      const { row } = await this.session(c, token, true);
      if (!row.csrf_hash || !this.crypto.equal(row.csrf_hash, this.crypto.hash("auth.csrf-store", csrf)))
        deny("forbidden", 403, "Invalid CSRF token.");
    });
  }
  async me(token: string) {
    return transaction(this.db, async (c) => {
      const { user, row } = await this.session(c, token, true);
      return {
        user_id: user.id,
        email_verified: Boolean(user.email_verified_at),
        expires_at: row.expires_at.toISOString(),
        csrf_token: this.crypto.hash("auth.csrf", token),
        mfa_required: row.mfa_pending,
      };
    });
  }
  async logout(token: string, context: AuthContext) {
    try {
      await transaction(this.db, async (c) => {
        const { user, row, now } = await this.session(c, token, true);
        await c.query("UPDATE sessions SET revoked_at=$2 WHERE id=$1", [row.id, now]);
        await this.audit(c, user.id, "auth.logout", row.id, context.requestId);
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "unauthenticated") throw error;
    }
  }
  async listSessions(token: string) {
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      return (
        await c.query<Session>(
          "SELECT * FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY created_at DESC,id",
          [user.id, now],
        )
      ).rows.map((s) => ({
        id: s.id,
        device_label: s.device_label ?? "Web session",
        created_at: s.created_at.toISOString(),
        expires_at: s.expires_at.toISOString(),
        is_current: s.id === row.id,
      }));
    });
  }
  async revokeSession(token: string, id: string, context: AuthContext) {
    await transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      await this.sensitive(c, user, row, now);
      const result = await c.query(
        "UPDATE sessions SET revoked_at=$3 WHERE id=$1 AND user_id=$2 RETURNING id",
        [id, user.id, now],
      );
      if (!result.rowCount) deny("not_found", 404, "Session not found.");
      await this.audit(c, user.id, "auth.session_revoked", id, context.requestId);
    });
  }
  async reauthenticate(
    token: string,
    passwordInput: unknown,
    totpCode: string | undefined,
    context: AuthContext,
  ) {
    await this.rate("reauth", context.clientId, 10, 900);
    const identity = await this.sessionIdentity(token),
      snapshot = (await this.db.query<User>("SELECT * FROM users WHERE id=$1", [identity.userId])).rows[0];
    await this.rate("reauth-owner", identity.userId, 5, 900);
    if (!snapshot || !(await verifyPassword(passwordValue(passwordInput, false), snapshot.password_hash)))
      deny();
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      if (user.password_hash !== snapshot.password_hash) deny();
      const mfa = await this.enabledMfa(c, user.id);
      if (mfa) {
        if (!totpCode) deny("mfa_required", 403, "Enter your authenticator code.");
        await this.useMfa(c, user.id, mfa, { totp_code: totpCode }, now);
      }
      await c.query(
        "UPDATE sessions SET authenticated_at=$2,mfa_at=CASE WHEN $3 THEN $2 ELSE mfa_at END WHERE id=$1",
        [row.id, now, Boolean(mfa)],
      );
      await this.audit(c, user.id, "auth.reauthenticated", row.id, context.requestId);
      return this.rotateSession(c, user, row, now, Boolean(mfa));
    });
  }
  async changePassword(token: string, current: unknown, next: unknown, context: AuthContext) {
    await this.rate("password-change", context.clientId, 10, 900);
    const identity = await this.sessionIdentity(token),
      snapshot = (await this.db.query<User>("SELECT * FROM users WHERE id=$1", [identity.userId])).rows[0];
    await this.rate("password-change-owner", identity.userId, 5, 900);
    if (!snapshot || !(await verifyPassword(passwordValue(current, false), snapshot.password_hash))) deny();
    const hash = await hashPassword(passwordValue(next));
    await transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      if (user.password_hash !== snapshot.password_hash) deny();
      await this.sensitive(c, user, { ...row, authenticated_at: now }, now);
      await c.query(
        "UPDATE users SET password_hash=$2,credential_version=credential_version+1,updated_at=$3 WHERE id=$1",
        [user.id, hash, now],
      );
      await c.query("UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL", [
        user.id,
        now,
      ]);
      await c.query(
        "UPDATE auth_tokens SET consumed_at=$2 WHERE user_id=$1 AND purpose='reset_password' AND consumed_at IS NULL",
        [user.id, now],
      );
      await this.audit(c, user.id, "auth.password_changed", user.id, context.requestId);
    });
  }
  private async useMfa(
    c: Transaction,
    userId: string,
    mfa: Record<string, unknown>,
    proof: { totp_code?: string; recovery_code?: string },
    now: Date,
  ) {
    if (Boolean(proof.totp_code) === Boolean(proof.recovery_code))
      deny("invalid_parameter", 400, "Supply exactly one MFA proof.");
    if (proof.recovery_code) {
      const hash = this.crypto.hash(`auth.recovery:${userId}`, proof.recovery_code),
        codes = mfa.recovery_code_hashes as string[];
      if (!codes.some((x) => this.crypto.equal(x, hash))) deny("mfa_invalid", 401, "Invalid MFA proof.");
      await c.query(
        "UPDATE user_mfa SET recovery_code_hashes=array_remove(recovery_code_hashes,$2),updated_at=$3 WHERE user_id=$1",
        [userId, hash, now],
      );
      return;
    }
    if (!/^\d{6}$/.test(proof.totp_code ?? "")) deny("mfa_invalid", 401, "Invalid MFA proof.");
    const secret = this.crypto.open<{ secret: string }>(
        mfa.encrypted_secret as Uint8Array,
        `auth.mfa:${userId}`,
      ).secret,
      result = await verify({
        secret,
        token: proof.totp_code as string,
        epoch: Math.floor(now.getTime() / 1000),
        epochTolerance: 30,
        ...(mfa.last_used_step === null ? {} : { afterTimeStep: Number(mfa.last_used_step) }),
      });
    if (!result.valid || !("timeStep" in result)) deny("mfa_invalid", 401, "Invalid MFA proof.");
    await c.query("UPDATE user_mfa SET last_used_step=$2,updated_at=$3 WHERE user_id=$1", [
      userId,
      result.timeStep,
      now,
    ]);
  }
  async mfaVerify(
    token: string,
    proof: { totp_code?: string; recovery_code?: string },
    context: AuthContext,
  ) {
    await this.rate("mfa", context.clientId, 10, 900);
    const identity = await this.sessionIdentity(token, true);
    await this.rate("mfa-owner", identity.userId, 5, 900);
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token, true),
        mfa = await this.enabledMfa(c, user.id);
      if (!mfa || !row.mfa_pending) deny("invalid_parameter", 400, "No MFA challenge is pending.");
      await this.useMfa(c, user.id, mfa, proof, now);
      await c.query("UPDATE sessions SET mfa_pending=false,mfa_at=$2 WHERE id=$1", [row.id, now]);
      await this.audit(c, user.id, "auth.mfa_verified", row.id, context.requestId);
      return this.rotateSession(c, user, row, now, true);
    });
  }
  async mfaStatus(token: string) {
    return transaction(this.db, async (c) => {
      const { user } = await this.session(c, token),
        mfa = await this.enabledMfa(c, user.id);
      return {
        enabled: Boolean(mfa),
        required: user.is_admin,
        recovery_codes_remaining: mfa?.recovery_code_hashes.length ?? 0,
      };
    });
  }
  async mfaSetup(token: string, context: AuthContext) {
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token, true);
      if (now.getTime() - row.authenticated_at.getTime() > 600000)
        deny("reauthentication_required", 403, "Reauthenticate before this action.");
      if (await this.enabledMfa(c, user.id)) deny("state_conflict", 409, "MFA is already enabled.");
      const secret = generateSecret(),
        expires = new Date(now.getTime() + 600000);
      await c.query(
        "INSERT INTO user_mfa(user_id,encrypted_secret,state,pending_expires_at,updated_at) VALUES($1,$2,'pending',$3,$4) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,state='pending',pending_expires_at=excluded.pending_expires_at,last_used_step=NULL,recovery_code_hashes='{}',updated_at=excluded.updated_at",
        [user.id, this.crypto.seal({ secret }, `auth.mfa:${user.id}`), expires, now],
      );
      await this.audit(c, user.id, "auth.mfa_setup", user.id, context.requestId);
      return {
        secret,
        uri: generateURI({ issuer: "SoldBench", label: user.email, secret }),
        expires_at: expires.toISOString(),
      };
    });
  }
  private recoveryCodes() {
    return Array.from({ length: 10 }, () => randomBytes(16).toString("hex"));
  }
  async mfaConfirm(token: string, code: string, context: AuthContext) {
    await this.rate("mfa-confirm", context.clientId, 10, 900);
    const identity = await this.sessionIdentity(token, true);
    await this.rate("mfa-confirm-owner", identity.userId, 5, 900);
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token, true);
      if (now.getTime() - row.authenticated_at.getTime() > 600000)
        deny("reauthentication_required", 403, "Reauthenticate before this action.");
      const mfa = (
        await c.query("SELECT * FROM user_mfa WHERE user_id=$1 AND state='pending' FOR UPDATE", [user.id])
      ).rows[0];
      if (!mfa?.pending_expires_at || mfa.pending_expires_at <= now)
        deny("token_invalid", 410, "MFA setup has expired.");
      await this.useMfa(c, user.id, mfa, { totp_code: code }, now);
      const codes = this.recoveryCodes();
      await c.query(
        "UPDATE user_mfa SET state='enabled',enabled_at=$2,pending_expires_at=NULL,recovery_code_hashes=$3 WHERE user_id=$1",
        [user.id, now, codes.map((v) => this.crypto.hash(`auth.recovery:${user.id}`, v))],
      );
      await c.query("UPDATE sessions SET revoked_at=$3 WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL", [
        user.id,
        row.id,
        now,
      ]);
      await c.query("UPDATE sessions SET mfa_at=$2 WHERE id=$1", [row.id, now]);
      await this.audit(c, user.id, "auth.mfa_enabled", user.id, context.requestId);
      return { ...(await this.rotateSession(c, user, row, now, true)), recovery_codes: codes };
    });
  }
  async mfaDisable(token: string, context: AuthContext) {
    await transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      await this.sensitive(c, user, row, now);
      if (user.is_admin) deny("forbidden", 403, "Administrators must keep MFA enabled.");
      await c.query("DELETE FROM user_mfa WHERE user_id=$1", [user.id]);
      await c.query("UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL", [
        user.id,
        now,
      ]);
      await this.audit(c, user.id, "auth.mfa_disabled", user.id, context.requestId);
    });
  }
  async regenerateRecoveryCodes(token: string, context: AuthContext) {
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      await this.sensitive(c, user, row, now);
      if (!(await this.enabledMfa(c, user.id))) deny("mfa_required", 403, "Enable MFA first.");
      const codes = this.recoveryCodes();
      await c.query("UPDATE user_mfa SET recovery_code_hashes=$2,updated_at=$3 WHERE user_id=$1", [
        user.id,
        codes.map((v) => this.crypto.hash(`auth.recovery:${user.id}`, v)),
        now,
      ]);
      await this.audit(c, user.id, "auth.recovery_regenerated", user.id, context.requestId);
      return { recovery_codes: codes };
    });
  }
  private keyView(row: Record<string, unknown>) {
    return {
      id: row.id,
      name: row.name,
      prefix: row.key_prefix,
      scopes: row.scopes,
      created_at: (row.created_at as Date).toISOString(),
      last_used_at: (row.last_used_at as Date | null)?.toISOString() ?? null,
      revoked_at: (row.revoked_at as Date | null)?.toISOString() ?? null,
    };
  }
  async listKeys(token: string) {
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      await this.sensitive(c, user, row, now);
      if (!user.email_verified_at) deny("email_verification_required", 403, "Verify your email first.");
      return (
        await c.query("SELECT * FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 100", [
          user.id,
        ])
      ).rows.map((row) => this.keyView(row));
    });
  }
  async createKey(
    token: string,
    input: { name: string; scopes: string[] },
    idempotencyKey: string,
    context: AuthContext,
    rotateId?: string,
  ) {
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 80 ||
      !Array.isArray(input.scopes) ||
      !input.scopes.length ||
      input.scopes.length > 3 ||
      new Set(input.scopes).size !== input.scopes.length ||
      input.scopes.some((v) => !scopes.includes(v)) ||
      !/^[\x21-\x7e]{16,128}$/.test(idempotencyKey)
    )
      deny("invalid_parameter", 400, "Invalid key request.");
    return transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      if (!user.email_verified_at) deny("email_verification_required", 403, "Verify your email first.");
      await this.sensitive(c, user, row, now);
      const operation = rotateId ? `key.rotate:${rotateId}` : "key.create",
        keyHash = this.crypto.hash("auth.idempotency", idempotencyKey),
        requestHash = this.crypto.hash(
          "auth.key-request",
          JSON.stringify({
            name: input.name.trim(),
            scopes: input.scopes.slice().sort(),
            rotateId: rotateId ?? null,
          }),
        );
      const old = (
        await c.query(
          "SELECT * FROM idempotency_records WHERE owner_scope=$1 AND operation=$2 AND key_hash=$3 FOR UPDATE",
          [user.id, operation, keyHash],
        )
      ).rows[0];
      if (old && old.expires_at > now) {
        if (old.request_hash !== requestHash)
          deny("idempotency_conflict", 409, "This idempotency key was used for a different request.");
        const existing = (
          await c.query("SELECT * FROM api_keys WHERE id=$1 AND user_id=$2", [old.resource_id, user.id])
        ).rows[0];
        if (!existing) throw new Error("key_replay_missing");
        return { key_info: this.keyView(existing), replayed: true };
      }
      if (old)
        await c.query(
          "DELETE FROM idempotency_records WHERE owner_scope=$1 AND operation=$2 AND key_hash=$3",
          [user.id, operation, keyHash],
        );
      if (rotateId) {
        const result = await c.query(
          "UPDATE api_keys SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id",
          [rotateId, user.id, now],
        );
        if (!result.rowCount) deny("not_found", 404, "Key not found.");
      }
      if (
        (
          await c.query("SELECT count(*)::int n FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL", [
            user.id,
          ])
        ).rows[0].n >= 20
      )
        deny("state_conflict", 409, "Revoke an existing key first.");
      const secret = this.crypto.token("sb_k_"),
        created = (
          await c.query(
            "INSERT INTO api_keys(user_id,key_hash,key_prefix,name,scopes,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              user.id,
              this.crypto.hash("auth.api-key", secret),
              secret.slice(0, 12),
              input.name.trim(),
              input.scopes,
              now,
            ],
          )
        ).rows[0];
      await c.query(
        "INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at) VALUES($1,$2,$3,$4,$5,'committed',$6)",
        [user.id, operation, keyHash, requestHash, created.id, new Date(now.getTime() + 86400000)],
      );
      await this.audit(
        c,
        user.id,
        rotateId ? "auth.key_rotated" : "auth.key_created",
        created.id,
        context.requestId,
      );
      return { key: secret, key_info: this.keyView(created), replayed: false };
    });
  }
  async revokeKey(token: string, id: string, context: AuthContext) {
    await transaction(this.db, async (c) => {
      const { user, row, now } = await this.session(c, token);
      await this.sensitive(c, user, row, now);
      const result = await c.query(
        "UPDATE api_keys SET revoked_at=coalesce(revoked_at,$3) WHERE id=$1 AND user_id=$2 RETURNING id",
        [id, user.id, now],
      );
      if (!result.rowCount) deny("not_found", 404, "Key not found.");
      await this.audit(c, user.id, "auth.key_revoked", id, context.requestId);
    });
  }
  /** Recheck an already authenticated request inside the business owner lock. */
  async assertIdentityLocked(
    c: Transaction,
    identity: Identity,
    scope: string,
    now: Date,
    recent = false,
    allowUnverified = false,
  ) {
    const user = await this.user(c, identity.userId);
    if (!allowUnverified && (user.status !== "active" || !user.email_verified_at))
      deny("email_verification_required", 403, "Verify the account before querying.");
    if (identity.keyId) {
      if (recent) deny("forbidden", 403, "A recently authenticated session is required.");
      const key = (
        await c.query("SELECT * FROM api_keys WHERE id=$1 AND user_id=$2 FOR SHARE", [
          identity.keyId,
          user.id,
        ])
      ).rows[0];
      if (!key || key.revoked_at) deny();
      if (!key.scopes.includes(scope)) deny("forbidden", 403, "API key scope is insufficient.");
    } else if (identity.sessionId) {
      const row = (
        await c.query<Session>("SELECT * FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE", [
          identity.sessionId,
          user.id,
        ])
      ).rows[0];
      if (
        !row ||
        row.revoked_at ||
        row.expires_at <= now ||
        row.credential_version !== user.credential_version ||
        (user.is_admin && now.getTime() - row.created_at.getTime() >= 43200000) ||
        row.mfa_pending ||
        !identity.csrfToken ||
        row.csrf_hash !== this.crypto.hash("auth.csrf-store", identity.csrfToken)
      )
        deny();
      if (
        user.is_admin &&
        (!row.mfa_at ||
          !(await c.query("SELECT 1 FROM user_mfa WHERE user_id=$1 AND state='enabled'", [user.id])).rowCount)
      )
        deny("forbidden", 403, "Administrator MFA is required.");
      if (recent) await this.sensitive(c, user, row, now);
    } else deny();
    return user;
  }
  async keyIdentity(secret: string, scope: string): Promise<Identity> {
    if (!/^sb_k_[A-Za-z0-9_-]{43}$/.test(secret)) deny();
    return transaction(this.db, async (c) => {
      const hash = this.crypto.hash("auth.api-key", secret),
        found = (await c.query("SELECT user_id FROM api_keys WHERE key_hash=$1", [hash])).rows[0];
      if (!found) deny();
      const user = await this.user(c, found.user_id),
        row = (
          await c.query("SELECT * FROM api_keys WHERE key_hash=$1 AND user_id=$2 FOR UPDATE", [hash, user.id])
        ).rows[0];
      if (!row || row.revoked_at || user.status !== "active" || !user.email_verified_at) deny();
      if (!(row.scopes as string[]).includes(scope))
        deny("forbidden", 403, "This API key does not have the required scope.");
      await c.query("UPDATE api_keys SET last_used_at=$2 WHERE id=$1", [row.id, await this.now(c)]);
      return {
        userId: user.id,
        sessionId: null,
        keyId: row.id,
        scopes: row.scopes,
        emailVerified: true,
        mfaPending: false,
      };
    });
  }
}
