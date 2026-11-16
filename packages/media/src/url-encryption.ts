import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const AAD_PREFIX = "soldbench:listing_images:source_url:v1:";
const VERSION = Buffer.from("SB01");

function keyFromBase64(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error("SOURCE_URL_ENCRYPTION_KEY must be canonical base64 for exactly 32 random bytes");
  return key;
}

export function encryptImageSourceUrl(url: string, rowId: string, encodedKey: string): Buffer {
  const key = keyFromBase64(encodedKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${rowId}`));
  const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return Buffer.concat([VERSION, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptImageSourceUrl(ciphertext: Uint8Array, rowId: string, encodedKey: string): string {
  const key = keyFromBase64(encodedKey);
  const bytes = Buffer.from(ciphertext);
  if (bytes.length < 32 || !bytes.subarray(0, 4).equals(VERSION))
    throw new Error("Unsupported encrypted image URL format");
  const nonce = bytes.subarray(4, 16);
  const tag = bytes.subarray(16, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`${AAD_PREFIX}${rowId}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString("utf8");
}
