import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AuthCrypto, newAuthSecrets, runtimeAuthSecrets } from "@soldbench/auth";
import { collectorHealth, provisionFixtureSource } from "@soldbench/collector";
import { assertRuntimeDatabaseUrl, database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { pgBinaries } from "../scripts/local-db.mjs";

const run = promisify(execFile);
const previous = "0047_mail_delivery_attempts.sql";
const latest = "0048_live_runtime_modes.sql";
const rehearsal = {
  ...process.env,
  NODE_ENV: "production",
  SOLDBENCH_ISOLATED_DEPLOYMENT: "true",
  SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "false",
  COLLECTOR_ENABLED: "false",
  DATA_MODE: "offline_fixture",
  PAYMENTS_MODE: "offline",
  PAYMENT_FIXTURES: "false",
  MAIL_TRANSPORT: "offline",
  HOST: "127.0.0.1",
};

test("production auth selects a private versioned file and rotates ciphertext without changing credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sb-auth-bundle-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, "v2.json");
  const oldKeys = newAuthSecrets();
  const old = new AuthCrypto(oldKeys);
  const currentSecret = newAuthSecrets().encryptionKey;
  await writeFile(
    file,
    JSON.stringify({
      version: "v2",
      tokenPepper: oldKeys.tokenPepper,
      encryptionKey: currentSecret,
      decryptOnlyKeys: [oldKeys.encryptionKey],
    }),
    { mode: 0o600 },
  );
  const env = { NODE_ENV: "production", AUTH_SECRETS_FILE: file, AUTH_SECRETS_VERSION: "v2" };
  const rotated = new AuthCrypto(runtimeAuthSecrets(directory, env));
  const former = old.seal({ secret: "offline-test" }, "mfa");
  assert.deepEqual(rotated.open(former, "mfa"), { secret: "offline-test" });
  assert.throws(() => rotated.open(former, "mail"), /invalid_auth_ciphertext/);
  assert.equal(rotated.hash("auth.session", "test"), old.hash("auth.session", "test"));
  const newBlob = rotated.seal({ works: true }, "mfa");
  assert.throws(() => old.open(newBlob, "mfa"), /invalid_auth_ciphertext/);
  assert.deepEqual(new AuthCrypto({ ...oldKeys, decryptOnlyKeys: [currentSecret] }).open(newBlob, "mfa"), {
    works: true,
  });
  assert.throws(() => runtimeAuthSecrets(directory, { NODE_ENV: "production" }), /reference_required/);
  assert.throws(() => runtimeAuthSecrets(directory, { ...env, AUTH_SECRETS_VERSION: "v1" }), /invalid/);
  await chmod(file, 0o644);
  assert.throws(() => runtimeAuthSecrets(directory, env), /invalid/);
  await chmod(file, 0o600);
  const alias = join(directory, "alias");
  await symlink(file, alias);
  assert.throws(() => runtimeAuthSecrets(directory, { ...env, AUTH_SECRETS_FILE: alias }), /invalid/);
  await writeFile(file, '{"log-marker-do-not-echo": bad json');
  assert.throws(
    () => runtimeAuthSecrets(directory, env),
    (error) => error.message === "auth_secrets_unavailable_or_invalid",
  );
});

test("isolated production mode keeps external operations closed and connects to native local PostgreSQL", () => {
  const config = loadConfig({ ...rehearsal, APP_ORIGIN: "http://soldbench.test:8080" });
  assert.equal(config.liveGateAcknowledged, false);
  assert.doesNotThrow(() =>
    assertRuntimeDatabaseUrl("postgresql://soldbench_runtime@127.0.0.1/soldbench", config),
  );
  const tempSocket = "postgresql://soldbench_runtime@localhost/soldbench?host=%2Ftmp%2Fsoldbench-test";
  assert.doesNotThrow(() => assertRuntimeDatabaseUrl(tempSocket, config, "/tmp/soldbench-test"));
  assert.throws(() => assertRuntimeDatabaseUrl(tempSocket, config), /database_target_must_be_local/);
  assert.throws(
    () => assertRuntimeDatabaseUrl("postgresql://soldbench_runtime@unapproved.test/soldbench", config),
    /database_target_must_be_local/,
  );
  for (const override of [
    { SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true" },
    { COLLECTOR_ENABLED: "true" },
    { MAIL_TRANSPORT: "resend" },
    { PAYMENTS_MODE: "stripe_paypal_live" },
    { PAYMENT_FIXTURES: "true" },
    { APP_ORIGIN: "https://soldbench.com" },
    { HOST: "0.0.0.0" },
  ])
    assert.throws(() => loadConfig({ ...rehearsal, ...override }));
});

test("bootstrap, migrate, ready, worker, and backup work on empty and previous PG16 under separated roles", async (t) => {
  const bootstrapUrl = new URL(process.env.DATABASE_URL);
  const bootstrap = database(bootstrapUrl.href);
  const upgradedUrl = new URL(bootstrapUrl);
  upgradedUrl.pathname = "/soldbench_v1_upgrade";
  await bootstrap.query("CREATE DATABASE soldbench_v1_upgrade");
  t.after(async () => {
    await bootstrap.query("DROP DATABASE soldbench_v1_upgrade WITH (FORCE)");
    await bootstrap.end();
  });

  const output = await mkdtemp(join(tmpdir(), "sb-runtime-test-"));
  t.after(() => rm(output, { force: true, recursive: true }));
  const bundle = join(output, "auth-v1.json");
  const keys = newAuthSecrets();
  await writeFile(bundle, JSON.stringify({ version: "v1", ...keys }), { mode: 0o600 });
  const passwordEnv = Object.fromEntries(
    ["MIGRATOR", "RUNTIME", "COLLECTOR", "BACKUP"].map((name) => [
      `SOLD_${name}_PASSWORD`,
      newAuthSecrets().tokenPepper,
    ]),
  );
  const withRole = (url, role) => {
    const next = new URL(url);
    next.username = `soldbench_${role}`;
    return next.href;
  };
  for (const source of [bootstrapUrl, upgradedUrl]) {
    const isLegacy = source === upgradedUrl;
    const admin = database(source.href);
    try {
      if (isLegacy) {
        await migrate(admin, previous);
        await admin.query(
          "INSERT INTO outbox(kind,event_key,payload,available_at) VALUES('auth.mail_queued','legacy-mail','{}',now())",
        );
      }
      const psql = join(pgBinaries(), "psql");
      await run(
        psql,
        ["-X", "--set", "ON_ERROR_STOP=1", "--dbname", source.href, "--file", "infra/db/provision.sql"],
        {
          env: { ...process.env, ...passwordEnv },
        },
      );
      await run(
        psql,
        ["-X", "--set", "ON_ERROR_STOP=1", "--dbname", source.href, "--file", "infra/db/provision.sql"],
        {
          env: { ...process.env, ...passwordEnv },
        },
      );
      const env = {
        ...rehearsal,
        DATABASE_URL: withRole(source, "migrator"),
        DB_STARTUP_MODE: "migrate",
        AUTH_SECRETS_FILE: bundle,
        AUTH_SECRETS_VERSION: "v1",
      };
      const migrated = await run(process.execPath, ["scripts/deploy-db.mjs"], { env });
      assert.equal(JSON.parse(migrated.stdout).runtimeGrants, "applied");
      if (isLegacy) assert.deepEqual(JSON.parse(migrated.stdout).applied, [latest]);
      else assert.ok(JSON.parse(migrated.stdout).applied.includes(latest));
      const runtime = database(withRole(source, "runtime"));
      const collector = database(withRole(source, "collector"));
      const backup = database(withRole(source, "backup"));
      try {
        const {
          rows: [role],
        } = await runtime.query(
          "SELECT current_user name, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname=current_user",
        );
        assert.deepEqual(role, {
          name: "soldbench_runtime",
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
        });
        for (const query of [
          "CREATE TABLE denied(id int)",
          "UPDATE soldbench_migrations SET name=name",
          "DELETE FROM credit_ledger",
        ])
          await assert.rejects(runtime.query(query), { code: "42501" });
        for (const query of [
          "SELECT id FROM users",
          "SELECT id FROM credit_ledger",
          "SELECT id FROM auth_mail_outbox",
        ])
          await assert.rejects(collector.query(query), { code: "42501" });
        await assert.rejects(backup.query("UPDATE outbox SET processed_at=now()"), { code: "42501" });
        await collector.query(
          "INSERT INTO outbox(kind,event_key,payload,available_at) VALUES('collector.page_committed','test-page','{}',now())",
        );
        await assert.rejects(
          collector.query(
            "INSERT INTO outbox(kind,event_key,payload,available_at) VALUES('auth.mail_queued','denied','{}',now())",
          ),
          { code: "42501" },
        );
        assert.deepEqual((await collector.query("SELECT kind FROM outbox")).rows, [
          { kind: "collector.page_committed" },
        ]);
        assert.equal((await backup.query("SELECT * FROM outbox")).rowCount, isLegacy ? 2 : 1);

        const listener = createServer();
        listener.listen(0, "127.0.0.1");
        await once(listener, "listening");
        const port = listener.address().port;
        await new Promise((done) => listener.close(done));
        const origin = `http://127.0.0.1:${port}`;
        const runtimeEnv = {
          ...env,
          APP_ORIGIN: origin,
          PORT: String(port),
          DATABASE_URL: withRole(source, "runtime"),
          DB_STARTUP_MODE: "verify",
          MEDIA_ROOT: output,
        };
        const missing = { ...runtimeEnv, AUTH_SECRETS_FILE: join(output, "missing.json") };
        for (const args of [["apps/api/dist/server.js"], ["scripts/query-worker.mjs", "--once"]]) {
          await assert.rejects(
            run(process.execPath, args, { env: missing }),
            /auth_secrets_unavailable_or_invalid/,
          );
          await assert.rejects(
            run(process.execPath, args, { env: { ...runtimeEnv, DATABASE_URL: source.href } }),
            /deployment_runtime_role_invalid/,
          );
          await assert.rejects(
            run(process.execPath, args, { env: { ...runtimeEnv, DB_STARTUP_MODE: "migrate" } }),
            /deployment_runtime_requires_verify_mode/,
          );
        }
        const api = spawn(process.execPath, ["apps/api/dist/server.js"], { env: runtimeEnv, stdio: "pipe" });
        const exit = once(api, "exit");
        let stderr = "";
        api.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        api.stdout.resume();
        try {
          let response;
          for (let attempt = 0; attempt < 76; attempt++) {
            response = await fetch(`${origin}/ready`).catch(() => null);
            if (response || api.exitCode !== null) break;
            await delay(40);
          }
          assert.equal(response?.status, 200, stderr);
          assert.equal((await response.json()).data_mode, "offline_fixture");
          const registered = await fetch(`${origin}/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: origin },
            body: JSON.stringify({
              email: "deployment-test@example.test",
              password: "Unique rehearsal passphrase!",
              terms_version: "offline-v1",
            }),
          });
          assert.equal(registered.status, 202, await registered.text());
          const worker = await run(process.execPath, ["scripts/query-worker.mjs", "--once"], {
            env: runtimeEnv,
          });
          assert.equal(worker.stderr, "");
          assert.equal((await runtime.query("SELECT * FROM auth_mail_outbox")).rowCount, 1);
        } finally {
          api.kill("SIGTERM");
          const [code] = await exit;
          assert.equal(code, 0, stderr);
        }
        const { sourceId } = await provisionFixtureSource(admin, new Date().toISOString());
        const sampler = await run(
          process.execPath,
          ["scripts/collector-supervisor.mjs", `--source=${sourceId}`, `--spool=${output}`],
          {
            env: {
              ...runtimeEnv,
              DATABASE_URL: withRole(source, "collector"),
              AUTH_SECRETS_FILE: "",
              AUTH_SECRETS_VERSION: "",
            },
          },
        );
        assert.equal(sampler.stderr, "");
        const cycle = JSON.parse(sampler.stdout.trim().split("\n").at(-1));
        assert.equal(cycle.externalNetworkRequests, 0);
        assert.equal(cycle.state, "ready");
        const report = await collectorHealth(collector, sourceId, { persist: true, automatic: true });
        assert.equal(report.networkRequests, 0);
        const health = await collector.query("SELECT 1 FROM collector_health_snapshots WHERE source_id=$1", [
          sourceId,
        ]);
        assert.equal(health.rowCount, 1);
        const destination = join(output, isLegacy ? "legacy-backup" : "empty-backup");
        await run(resolve("infra/backup-restore.sh"), ["backup", withRole(source, "backup"), destination]);
        await run(resolve("infra/backup-restore.sh"), ["verify", destination]);
      } finally {
        await Promise.all([runtime.end(), collector.end(), backup.end()]);
      }
    } finally {
      await admin.end();
    }
  }
});
