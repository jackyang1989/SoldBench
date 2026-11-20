import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthService, localAuthSecrets, OfflineMailQueue } from "@soldbench/auth";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

let db;
try {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (mode !== "--once" && mode !== "--list" && mode !== "--preview")
    throw new Error("invalid_offline_mail_command");
  const preview = mode === "--preview";
  const message = args[1]?.match(/^--message=([a-f0-9-]{36})$/)?.[1];
  const output = args[2]?.match(/^--output=(.+)$/)?.[1];
  if (preview ? !message || !output || args.length !== 3 : args.length !== 1)
    throw new Error("invalid_offline_mail_command");
  const config = loadConfig(process.env);
  const url = config.databaseUrl ?? localDatabaseUrl();
  assertLocalDatabaseUrl(url, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
  db = database(url);
  await prepareDatabase(db, config.databaseStartup);
  const mailbox = new OfflineMailQueue(
    new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin),
  );
  if (preview) {
    const content = await mailbox.preview(message);
    const file = await open(resolve(output), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(content));
      await file.sync();
    } finally {
      await file.close();
    }
    console.log(JSON.stringify({ mode: "offline_fixture", preview_written: true, id: message }));
  } else {
    const result = mode === "--once" ? await mailbox.workOnce() : await mailbox.list();
    console.log(JSON.stringify({ mode: "offline_fixture", result }));
  }
} catch (error) {
  const reason =
    error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "offline_mail_command_failed";
  console.error(JSON.stringify({ error: reason, mode: "offline_fixture" }));
  process.exitCode = 1;
} finally {
  await db?.end();
}
