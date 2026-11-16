import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
    try {
      file = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(file, JSON.stringify(newAuthSecrets()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (file !== undefined) closeSync(file);
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
