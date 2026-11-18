import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { assertLocalDatabaseUrl, database, migrate, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const directory = resolve(process.env.COLLECTOR_DEMO_DIR ?? process.env.LOCAL_STATE_ROOT ?? ".local"),
  config = loadConfig({
    ...process.env,
    LOCAL_STATE_ROOT: directory,
    MEDIA_ROOT: resolve(process.env.MEDIA_ROOT ?? join(directory, "collector-media")),
  }),
  url = process.env.DATABASE_URL ?? localDatabaseUrl();
const research = process.argv.length === 3 && process.argv[2] === "--research";
if ((process.argv.length > 2 && !research) || process.env.NODE_ENV === "production")
  throw new Error("offline_developer_demo_only");
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (lstatSync(directory).isSymbolicLink()) throw new Error("invalid_demo_directory");
const lock = join(directory, ".developer-demo.lock"),
  lockFd = openSync(
    lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ),
  temporary = join(directory, `.developer-demo-${randomUUID()}.tmp`),
  target = join(directory, "developer-demo.env"),
  db = database(url);

function legacyDemoKeyHash(auth) {
  let fd;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0)
      throw new Error("invalid_demo_environment_file");
    const key = parseEnv(readFileSync(fd, "utf8")).SOLDBENCH_API_KEY;
    return /^sb_k_[A-Za-z0-9_-]{43}$/.test(key ?? "") ? auth.crypto.hash("auth.api-key", key) : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
try {
  const args = ["scripts/collector-html-demo.mjs", "--http", ...(research ? ["--research"] : [])];
  const run = await promisify(execFile)(process.execPath, args, {
    env: { ...process.env, DATABASE_URL: url, COLLECTOR_DEMO_DIR: directory, MEDIA_ROOT: config.mediaRoot },
    timeout: 60000,
    maxBuffer: 1048576,
  });
  const report = JSON.parse(run.stdout.trim());
  if (report.status !== "completed") throw new Error("demo_collection_not_completed");
  await migrate(db);
  const auth = new AuthService(db, localAuthSecrets(directory), config.origin),
    token = auth.crypto.token("sb_k_"),
    hash = auth.crypto.hash("auth.api-key", token),
    keyName = `offline-developer-demo-${auth.crypto.hash("demo.profile", realpathSync(directory)).slice(0, 20)}`,
    legacy = legacyDemoKeyHash(auth);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const values = {
      SOLDBENCH_BASE_URL: `${config.origin}/v1`,
      SOLDBENCH_API_KEY: token,
      SOLDBENCH_KEYWORD: report.query,
      LOCAL_STATE_ROOT: directory,
      MEDIA_ROOT: config.mediaRoot,
      DATABASE_URL: url,
      PORT: String(config.port),
      HOST: config.host,
      APP_ORIGIN: config.origin,
    };
    writeFileSync(
      fd,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${quote(value)}`)
        .join("\n")}\n`,
    );
  } finally {
    closeSync(fd);
  }
  await transaction(db, async (c) => {
    // Reserved synthetic fixture identities, no password/session/email flow or real customer record.
    if (legacy)
      await c.query(
        `UPDATE api_keys SET name=$1
         WHERE name='offline-developer-demo' AND key_hash=$2 AND revoked_at IS NULL
           AND user_id IN (SELECT id FROM users WHERE email LIKE 'developer-demo-%@example.test' AND password_hash='synthetic-non-loginable')`,
        [keyName, legacy],
      );
    const user = (
      await c.query(
        "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'synthetic-non-loginable','active',clock_timestamp(),clock_timestamp()) RETURNING id",
        [`developer-demo-${randomUUID()}@example.test`],
      )
    ).rows[0].id;
    await c.query("INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,$2,$3,$4,$5)", [
      user,
      keyName,
      hash,
      token.slice(0, 12),
      ["sold:read", "jobs:read", "usage:read"],
    ]);
  });
  try {
    renameSync(temporary, target);
  } catch (error) {
    await db.query("UPDATE api_keys SET revoked_at=clock_timestamp() WHERE key_hash=$1", [hash]);
    throw error;
  }
  await db.query(
    `UPDATE api_keys SET revoked_at=clock_timestamp()
     WHERE name=$1 AND key_hash<>$2 AND revoked_at IS NULL
       AND user_id IN (SELECT id FROM users WHERE email LIKE 'developer-demo-%@example.test' AND password_hash='synthetic-non-loginable')`,
    [keyName, hash],
  );
  console.log(
    JSON.stringify({
      data_mode: "synthetic_fixture",
      scenario: report.scenario,
      query: report.query,
      environment_file: target,
      mode: "0600",
      api_origin: config.origin,
      records: report.recordEvidenceCount,
      images: report.availablePrimaryImages,
      collector_enabled: false,
      payments_mode: "offline",
      instructions:
        "Export the private environment file before starting npm run dev; it supplies matching auth/media/database configuration. No key is printed.",
    }),
  );
} finally {
  await db.end();
  closeSync(lockFd);
  rmSync(lock);
  rmSync(temporary, { force: true });
}
