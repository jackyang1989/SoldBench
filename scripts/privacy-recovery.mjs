import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AccountPrivacy, AuthService, localAuthSecrets } from "@soldbench/auth";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const [action, path, ...rest] = process.argv.slice(2);
if (!["export", "replay"].includes(action) || !path || rest.length)
  throw new Error("usage_privacy_recovery_export_or_replay_file");
if (action === "replay" && process.env.PRIVACY_RESTORE_ISOLATED !== "true")
  throw new Error("require_isolated_restore_database");
const config = loadConfig(process.env),
  url = config.databaseUrl ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url);
try {
  await migrate(db);
  const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin),
    privacy = new AccountPrivacy(auth);
  if (action === "export") {
    const manifest = await privacy.exportManifest();
    await writeFile(path, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ data_mode: "offline_fixture", exported: true }));
  } else {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let manifest;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024 || stat.mode & 0o077)
        throw new Error("privacy_manifest_must_be_private_regular_file");
      manifest = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
    const restored = await privacy.replayManifest(manifest);
    let batches = 0;
    for (; batches < 1000; batches++) if (!(await privacy.workOnce())) break;
    if (batches === 1000) throw new Error("privacy_recovery_pending_continue_before_opening_readers");
    console.log(JSON.stringify({ data_mode: "offline_fixture", ...restored, batches }));
  }
} finally {
  await db.end();
}
