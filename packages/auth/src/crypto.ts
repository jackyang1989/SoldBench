import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "@soldbench/shared";
export type AuthSecrets = { tokenPepper: string; encryptionKey: string };
export function newAuthSecrets(): AuthSecrets {
  return {
    tokenPepper: randomBytes(32).toString("base64"),
    encryptionKey: randomBytes(32).toString("base64"),
  };
}
function key(value: string) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) throw new Error("invalid_auth_secret");
  return bytes;
}
export class AuthCrypto {
  readonly pepper: Buffer;
  readonly encryption: Buffer;
  constructor(secrets: AuthSecrets) {
    this.pepper = key(secrets.tokenPepper);
    this.encryption = key(secrets.encryptionKey);
  }
  hash(domain: string, value: string) {
    return createHmac("sha256", this.pepper).update(`${domain}\u0000${value}`).digest("hex");
  }
  token(prefix = "") {
    return prefix + randomBytes(32).toString("base64url");
  }
  equal(a: string, b: string) {
    const x = Buffer.from(a),
      y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
  seal(value: unknown, aad: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.encryption, nonce);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
  }
  open<T>(value: Uint8Array, aad: string): T {
    const bytes = Buffer.from(value);
    if (bytes.length < 29) throw new Error("invalid_auth_ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.encryption, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
  }
}
let active = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= 2) throw new AppError("service_unavailable", 503, "Authentication is busy. Retry shortly.");
  active++;
  try {
    return await new Promise((resolve, reject) =>
      scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
  } finally {
    active--;
  }
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16),
    result = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString("base64")}$${result.toString("base64")}`;
}
export async function verifyPassword(password: string, stored: string | null) {
  const parts = stored?.split("$") ?? [],
    salt = Buffer.from(parts[4] ?? "", "base64"),
    expected = Buffer.from(parts[5] ?? "", "base64");
  const valid =
    parts.length === 6 &&
    parts.slice(0, 4).join("$") === "scrypt$131072$8$1" &&
    salt.length === 16 &&
    expected.length === 64;
  const actual = await derive(password, valid ? salt : Buffer.alloc(16));
  return valid && timingSafeEqual(actual, expected);
}
