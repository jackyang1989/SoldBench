import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FixtureKeys } from "./payment-fixtures.ts";

export function localPaymentKeys(directory: string, create = false): FixtureKeys {
  if (process.env.NODE_ENV === "production") throw new Error("production_fixture_keys_forbidden");
  const path = join(directory, "payment-fixture-keys.json");
  if (create) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("invalid_payment_fixture_directory");
    const temp = join(directory, `.payment-fixture-${randomUUID()}.tmp`);
    try {
      writeFileSync(
        temp,
        JSON.stringify({ stripe: randomBytes(32).toString("hex"), paypal: randomBytes(32).toString("hex") }),
        { flag: "wx", mode: 0o600 },
      );
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 || stat.mode & 0o077)
      throw new Error("private_payment_fixture_keys_required");
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (
      !/^[0-9a-f]{64}$/.test(value.stripe) ||
      !/^[0-9a-f]{64}$/.test(value.paypal) ||
      value.stripe === value.paypal
    )
      throw new Error("invalid_payment_fixture_keys");
    return value;
  } finally {
    closeSync(fd);
  }
}
