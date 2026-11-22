import {
  createHash,
  createPublicKey,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import type { AuthContext, AuthService, Identity } from "./service.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9._-]{8,512}$/;

export type PasskeyAlgorithm = "ES256" | "Ed25519";

type PasskeyRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key_spki_pem: string;
  algorithm: PasskeyAlgorithm;
  sign_count: string | number;
  label: string;
  transports: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

type ChallengeRow = {
  id: string;
  challenge_hash: string;
  purpose: "register" | "login";
  user_id: string | null;
  rp_id: string;
  origin: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
};

function denyPasskey(code = "invalid_parameter", status = 400, message = "Invalid passkey request."): never {
  throw new AppError(code, status, message);
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value))
    denyPasskey("invalid_parameter", 400, `Malformed base64url field: ${label}.`);
  return Buffer.from(value, "base64url");
}

function parseClientData(
  raw: string,
  expectedType: "webauthn.create" | "webauthn.get",
  expectedOrigin: string,
) {
  const bytes = decodeBase64Url(raw, "clientDataJSON");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    denyPasskey("invalid_parameter", 400, "Invalid clientDataJSON.");
  }
  if (parsed.type !== expectedType) denyPasskey("unauthenticated", 401, "WebAuthn ceremony type mismatch.");
  if (parsed.origin !== expectedOrigin) denyPasskey("forbidden", 403, "WebAuthn origin mismatch.");
  if (typeof parsed.challenge !== "string" || !CHALLENGE_RE.test(parsed.challenge))
    denyPasskey("invalid_parameter", 400, "Invalid WebAuthn challenge.");
  return { bytes, challenge: parsed.challenge };
}

function parseAuthenticatorData(raw: string, expectedRpId: string) {
  const bytes = decodeBase64Url(raw, "authenticatorData");
  if (bytes.length < 37) denyPasskey("invalid_parameter", 400, "Invalid authenticatorData length.");
  const expectedHash = createHash("sha256").update(expectedRpId, "utf8").digest();
  if (!timingSafeEqual(bytes.subarray(0, 32), expectedHash))
    denyPasskey("forbidden", 403, "WebAuthn rpIdHash mismatch.");
  const flags = bytes[32] ?? 0;
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  if (!userPresent) denyPasskey("unauthenticated", 401, "Passkey user presence flag is required.");
  const signCount = bytes.readUInt32BE(33);
  return { bytes, userVerified, signCount };
}

function validateSpkiKey(pem: string, algorithm: PasskeyAlgorithm): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    denyPasskey("invalid_parameter", 400, "Invalid SPKI public key.");
  }
  if (algorithm === "ES256") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== "ec" || (curve && curve !== "prime256v1" && curve !== "P-256"))
      denyPasskey("invalid_parameter", 400, "ES256 passkey requires an EC P-256 SPKI key.");
  } else if (algorithm === "Ed25519" && key.asymmetricKeyType !== "ed25519") {
    denyPasskey("invalid_parameter", 400, "Ed25519 passkey requires an Ed25519 SPKI key.");
  }
  return key;
}

function verifyAssertionSignature(
  algorithm: PasskeyAlgorithm,
  key: KeyObject,
  authDataBytes: Buffer,
  clientDataBytes: Buffer,
  signatureB64Url: string,
): boolean {
  const clientHash = createHash("sha256").update(clientDataBytes).digest();
  const payload = Buffer.concat([authDataBytes, clientHash]);
  const sig = decodeBase64Url(signatureB64Url, "signature");
  if (algorithm === "Ed25519") return verify(null, payload, key, sig);
  if (verify("sha256", payload, key, sig)) return true;
  if (sig.length === 64) {
    return verify("sha256", payload, { key, dsaEncoding: "ieee-p1363" }, sig);
  }
  return false;
}

export class PasskeyService {
  readonly rpId: string;

  constructor(readonly auth: AuthService) {
    this.rpId = new URL(auth.origin).hostname;
  }

  private async consumeChallengeLocked(
    c: Transaction,
    challenge: string,
    purpose: "register" | "login",
    now: Date,
    userId?: string,
  ) {
    const hash = this.auth.crypto.hash(`passkey.challenge:${purpose}`, challenge);
    const row = (
      await c.query<ChallengeRow>(
        "SELECT * FROM passkey_challenges WHERE challenge_hash=$1 AND purpose=$2 FOR UPDATE",
        [hash, purpose],
      )
    ).rows[0];
    if (
      !row ||
      row.consumed_at ||
      row.expires_at <= now ||
      row.rp_id !== this.rpId ||
      row.origin !== this.auth.origin ||
      (userId !== undefined && row.user_id !== userId)
    )
      denyPasskey("token_invalid", 410, "Passkey challenge is invalid or expired.");
    await c.query("UPDATE passkey_challenges SET consumed_at=$2 WHERE id=$1", [row.id, now]);
    return row;
  }

  async beginRegistration(identity: Identity, sessionToken: string, labelInput?: string) {
    const label = (labelInput ?? "Hardware or platform passkey").trim();
    if (!label || label.length > 80)
      denyPasskey("invalid_parameter", 400, "Passkey label must be 1 to 80 characters.");

    return transaction(this.auth.db, async (c) => {
      const { user, now } = await this.auth.assertRecentSessionLocked(c, sessionToken);
      if (user.id !== identity.userId) denyPasskey("forbidden", 403, "Session owner mismatch.");
      const existing = (
        await c.query<{ credential_id: string; transports: string[] }>(
          "SELECT credential_id,transports FROM user_passkeys WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC",
          [user.id],
        )
      ).rows;
      const challenge = randomBytes(32).toString("base64url");
      const hash = this.auth.crypto.hash("passkey.challenge:register", challenge);
      const expires = new Date(now.getTime() + CHALLENGE_TTL_MS);
      await c.query(
        "INSERT INTO passkey_challenges(challenge_hash,purpose,user_id,rp_id,origin,expires_at,created_at) VALUES($1,'register',$2,$3,$4,$5,$6)",
        [hash, user.id, this.rpId, this.auth.origin, expires, now],
      );
      return {
        challenge,
        rp: { id: this.rpId, name: "SoldBench" },
        user: {
          id: Buffer.from(user.id, "utf8").toString("base64url"),
          name: user.email,
          displayName: user.email,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -8 },
        ],
        excludeCredentials: existing.map((item) => ({
          type: "public-key",
          id: item.credential_id,
          transports: item.transports,
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        timeout: CHALLENGE_TTL_MS,
        label,
      };
    });
  }

  async completeRegistration(
    identity: Identity,
    sessionToken: string,
    input: {
      credential_id: string;
      public_key_spki_pem: string;
      algorithm: PasskeyAlgorithm;
      label?: string;
      transports?: string[];
      client_data_json: string;
      authenticator_data: string;
    },
    requestId: string,
  ) {
    if (!CREDENTIAL_ID_RE.test(input.credential_id))
      denyPasskey("invalid_parameter", 400, "Invalid credential_id.");
    const label = (input.label ?? "Hardware or platform passkey").trim();
    if (!label || label.length > 80)
      denyPasskey("invalid_parameter", 400, "Passkey label must be 1 to 80 characters.");
    validateSpkiKey(input.public_key_spki_pem, input.algorithm);
    const { challenge } = parseClientData(input.client_data_json, "webauthn.create", this.auth.origin);
    const { signCount } = parseAuthenticatorData(input.authenticator_data, this.rpId);

    return transaction(this.auth.db, async (c) => {
      const { user, now } = await this.auth.assertRecentSessionLocked(c, sessionToken);
      if (user.id !== identity.userId) denyPasskey("forbidden", 403, "Session owner mismatch.");
      await this.consumeChallengeLocked(c, challenge, "register", now, user.id);

      const conflict = await c.query("SELECT 1 FROM user_passkeys WHERE credential_id=$1", [
        input.credential_id,
      ]);
      if (conflict.rowCount) denyPasskey("conflict", 409, "Credential ID is already registered.");

      const transports = [...new Set((input.transports ?? []).slice(0, 6))];
      const created = (
        await c.query<PasskeyRow>(
          `INSERT INTO user_passkeys(user_id,credential_id,public_key_spki_pem,algorithm,sign_count,label,transports,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            user.id,
            input.credential_id,
            input.public_key_spki_pem,
            input.algorithm,
            signCount,
            label,
            transports,
            now,
          ],
        )
      ).rows[0];
      if (!created) throw new Error("passkey_insert_failed");
      await this.auth.recordAuditLocked(c, user.id, "auth.passkey_registered", created.id, requestId);
      return {
        id: created.id,
        credential_id: created.credential_id,
        algorithm: created.algorithm,
        label: created.label,
        sign_count: Number(created.sign_count),
        transports: created.transports,
        created_at: created.created_at.toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
    });
  }

  async beginLogin(email?: string) {
    return transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      const normalizedEmail = email?.trim().toLowerCase();
      const allowCredentials = normalizedEmail
        ? (
            await c.query<{ credential_id: string; transports: string[] }>(
              `SELECT p.credential_id,p.transports
               FROM user_passkeys p
               JOIN users u ON u.id=p.user_id
               WHERE lower(u.email)=$1 AND u.status='active' AND p.revoked_at IS NULL
               ORDER BY p.created_at DESC`,
              [normalizedEmail],
            )
          ).rows.map((r) => ({ type: "public-key", id: r.credential_id, transports: r.transports }))
        : [];
      const challenge = randomBytes(32).toString("base64url");
      const hash = this.auth.crypto.hash("passkey.challenge:login", challenge);
      const expires = new Date(now.getTime() + CHALLENGE_TTL_MS);
      await c.query(
        "INSERT INTO passkey_challenges(challenge_hash,purpose,user_id,rp_id,origin,expires_at,created_at) VALUES($1,'login',NULL,$2,$3,$4,$5)",
        [hash, this.rpId, this.auth.origin, expires, now],
      );
      return {
        challenge,
        rpId: this.rpId,
        timeout: CHALLENGE_TTL_MS,
        userVerification: "preferred" as const,
        allowCredentials,
      };
    });
  }

  async completeLogin(
    input: {
      credential_id: string;
      client_data_json: string;
      authenticator_data: string;
      signature: string;
    },
    context: AuthContext,
  ) {
    if (!CREDENTIAL_ID_RE.test(input.credential_id))
      denyPasskey("unauthenticated", 401, "Invalid passkey credential.");
    const { bytes: clientDataBytes, challenge } = parseClientData(
      input.client_data_json,
      "webauthn.get",
      this.auth.origin,
    );
    const {
      bytes: authDataBytes,
      userVerified,
      signCount,
    } = parseAuthenticatorData(input.authenticator_data, this.rpId);

    return transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      await this.consumeChallengeLocked(c, challenge, "login", now);
      const keyRow = (
        await c.query<PasskeyRow>(
          "SELECT * FROM user_passkeys WHERE credential_id=$1 AND revoked_at IS NULL FOR UPDATE",
          [input.credential_id],
        )
      ).rows[0];
      if (!keyRow) denyPasskey("unauthenticated", 401, "Passkey credential is unknown or revoked.");

      const storedCount = Number(keyRow.sign_count);
      if ((storedCount > 0 || signCount > 0) && signCount <= storedCount)
        denyPasskey("unauthenticated", 401, "Passkey sign_count replay rejected.");

      const publicKey = validateSpkiKey(keyRow.public_key_spki_pem, keyRow.algorithm);
      const ok = verifyAssertionSignature(
        keyRow.algorithm,
        publicKey,
        authDataBytes,
        clientDataBytes,
        input.signature,
      );
      if (!ok) denyPasskey("unauthenticated", 401, "Passkey signature verification failed.");

      await c.query("UPDATE user_passkeys SET sign_count=$2,last_used_at=$3 WHERE id=$1", [
        keyRow.id,
        signCount,
        now,
      ]);
      return this.auth.createPasskeySessionLocked(
        c,
        keyRow.user_id,
        context.requestId,
        `Passkey (${keyRow.label})`,
        userVerified,
      );
    });
  }

  async listPasskeys(identity: Identity) {
    return transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      const user = await this.auth.assertIdentityLocked(c, identity, "sold:read", now);
      return (
        await c.query<PasskeyRow>(
          "SELECT * FROM user_passkeys WHERE user_id=$1 ORDER BY created_at DESC, id ASC",
          [user.id],
        )
      ).rows.map((r) => ({
        id: r.id,
        credential_id: r.credential_id,
        algorithm: r.algorithm,
        label: r.label,
        sign_count: Number(r.sign_count),
        transports: r.transports,
        created_at: r.created_at.toISOString(),
        last_used_at: r.last_used_at ? r.last_used_at.toISOString() : null,
        revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
      }));
    });
  }

  async revokePasskey(identity: Identity, sessionToken: string, passkeyId: string, requestId: string) {
    await transaction(this.auth.db, async (c) => {
      const { user, now } = await this.auth.assertRecentSessionLocked(c, sessionToken);
      if (user.id !== identity.userId) denyPasskey("forbidden", 403, "Session owner mismatch.");
      const updated = await c.query(
        "UPDATE user_passkeys SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND user_id=$2 RETURNING id",
        [passkeyId, user.id, now],
      );
      if (!updated.rowCount) denyPasskey("not_found", 404, "Passkey not found.");
      await this.auth.recordAuditLocked(c, user.id, "auth.passkey_revoked", passkeyId, requestId);
    });
  }
}
