import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AuthCrypto, type AuthSecrets } from "./crypto.ts";
import { localAuthSecrets } from "./local.ts";

const maxBundleBytes = 4096;
const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Read an assigned mount. Production never creates or searches for authentication secrets. */
export function runtimeAuthSecrets(
  localStateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthSecrets {
  const path = env.AUTH_SECRETS_FILE;
  const version = env.AUTH_SECRETS_VERSION;
  if (path === undefined && version === undefined && env.NODE_ENV !== "production")
    return localAuthSecrets(resolve(localStateRoot));
  if (!path || !isAbsolute(path) || !version || !versionPattern.test(version))
    throw new Error("auth_secrets_reference_required");

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const status = fstatSync(fd);
    // A designated read-only group is allowed for secret mounts in the container.
    if (!status.isFile() || (status.mode & 0o037) !== 0 || status.size < 1 || status.size > maxBundleBytes)
      throw new Error("auth_secrets_mount_invalid");
    const payload = Buffer.alloc(maxBundleBytes + 1);
    let length = 0;
    while (length < payload.length) {
      const read = readSync(fd, payload, length, payload.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length !== status.size) throw new Error("auth_secrets_mount_invalid");
    const bundle = JSON.parse(payload.toString("utf8", 0, length));
    if (!bundle || bundle.version !== version) throw new Error("auth_secrets_version_mismatch");
    const secrets: AuthSecrets = {
      tokenPepper: bundle.tokenPepper,
      encryptionKey: bundle.encryptionKey,
      decryptOnlyKeys: bundle.decryptOnlyKeys,
    };
    new AuthCrypto(secrets);
    return secrets;
  } catch {
    // Invalid JSON and OS errors can include payload fragments or paths. Keep startup output opaque.
    throw new Error("auth_secrets_unavailable_or_invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
