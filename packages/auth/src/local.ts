import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AuthCrypto, type AuthSecrets, newAuthSecrets } from "./crypto.ts";
/** Local development only: durable random secrets, never a committed default. */
export function localAuthSecrets(directory = resolve(".local")): AuthSecrets {
  if (process.env.NODE_ENV === "production") throw new Error("local_auth_secrets_forbidden");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("auth_directory_invalid");
  const path = join(directory, "auth-secrets.json");
  if (!existsSync(path)) {
    let file: number | undefined;
    const temporary = join(directory, `.auth-secrets-${randomUUID()}.tmp`);
    try {
      file = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(file, JSON.stringify(newAuthSecrets()));
      fsyncSync(file);
      closeSync(file);
      file = undefined;
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (file !== undefined) closeSync(file);
      rmSync(temporary, { force: true });
    }
  }
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const secrets = JSON.parse(readFileSync(file, "utf8"));
    new AuthCrypto(secrets);
    return secrets;
  } finally {
    closeSync(file);
  }
}
