import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createApp } from "@soldbench/api";
import {
  AccountPrivacy,
  AuthService,
  localAuthSecrets,
  newAuthSecrets,
  OfflineMailQueue,
} from "@soldbench/auth";
import { database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";

const db = database(process.env.DATABASE_URL);
const config = loadConfig({});
const execute = promisify(execFile);
const password = "Local-only transactional mail test 419!";
before(() => migrate(db));
after(() => db.end());

function setup(clock, secrets = newAuthSecrets()) {
  const auth = new AuthService(db, secrets, config.origin, clock);
  const mailbox = new OfflineMailQueue(auth);
  const app = createApp(config, db, { auth });
  const email = `mail-${randomUUID()}@example.test`;
  const post = (path, body, locale = "en") =>
    app.request(path, {
      method: "POST",
      headers: { Origin: config.origin, "Content-Type": "application/json", "Accept-Language": locale },
      body: JSON.stringify(body),
    });
  const register = (locale) =>
    post("/auth/register", { email, password, terms_version: "offline-v1" }, locale);
  const messages = async (purpose) =>
    (
      await db.query(
        `SELECT m.* FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id
     WHERE u.email=$1 AND m.purpose=$2 ORDER BY m.created_at,m.id`,
        [email, purpose],
      )
    ).rows;
  return { auth, mailbox, email, post, register, messages };
}
const tokenFrom = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get("token");

test("real query worker and local CLI deliver a localized preview without logging contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "soldbench-mail-"));
  const env = {
    ...process.env,
    LOCAL_STATE_ROOT: root,
    MEDIA_ROOT: join(root, "media"),
    DB_STARTUP_MODE: "verify",
  };
  const run = (entry, ...args) =>
    execute(process.execPath, ["--import", "./scripts/test-network.mjs", entry, ...args], {
      encoding: "utf8",
      env,
      timeout: 5000,
    });
  const x = setup(undefined, localAuthSecrets(root));
  try {
    assert.equal((await x.register("zh-CN")).status, 202);
    const [pending] = await x.messages("verify_email");
    assert.equal(pending.status, "queued_offline");
    const task = await run("scripts/query-worker.mjs", "--once");
    assert.doesNotMatch(task.stdout, /example\.test|sb_v_|#token=/);
    const ids = JSON.parse((await run("scripts/offline-mail.mjs", "--list")).stdout).result;
    assert.deepEqual(
      ids.map(({ id, locale }) => [id, locale]),
      [[pending.id, "zh-CN"]],
    );
    const path = join(root, "private-preview.json"),
      args = ["--preview", `--message=${pending.id}`, `--output=${path}`];
    const receipt = await run("scripts/offline-mail.mjs", ...args);
    assert.doesNotMatch(receipt.stdout, /example\.test|sb_v_|#token=/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const preview = JSON.parse(await readFile(path, "utf8"));
    assert.equal(preview.offline, true);
    assert.equal(preview.to, x.email);
    assert.equal(preview.subject, "验证 SoldBench 邮箱");
    assert.equal(new URL(preview.link).pathname, "/zh-CN/verify-email");
    await assert.rejects(run("scripts/offline-mail.mjs", ...args), { code: 1 });
    assert.equal(
      (await x.post("/auth/verify-email", { token: tokenFrom(preview.link) }, "zh-CN")).status,
      202,
    );
    await assert.rejects(x.mailbox.preview(pending.id), /offline_mail_unavailable/);
    await run("scripts/query-worker.mjs", "--once");
    const [closed] = await x.messages("verify_email");
    assert.equal(closed.status, "cancelled");
    assert.equal(closed.encrypted_payload.length, 0);
    assert.ok(
      (await db.query("SELECT processed_at FROM outbox WHERE event_key=$1", [`auth-mail:${pending.id}`]))
        .rows[0].processed_at,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("concurrent local dispatch is idempotent and reissued or expired English links become unreadable", async () => {
  let now = "2026-11-17T12:00:00.000Z";
  const x = setup(() => now);
  assert.equal((await x.register("en")).status, 202);
  const [queued] = await x.messages("verify_email");
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => x.mailbox.workOnce()));
  assert.equal(concurrent.filter(Boolean).length, 1);
  const verify = await x.mailbox.preview(queued.id);
  assert.equal(verify.subject, "Verify your SoldBench email");
  assert.equal((await x.post("/auth/verify-email", { token: tokenFrom(verify.link) })).status, 202);
  await x.mailbox.workOnce();
  const requestReset = () => x.post("/auth/password-reset/request", { email: x.email });
  assert.equal((await requestReset()).status, 202);
  const first = await x.mailbox.workOnce();
  assert.equal((await x.mailbox.preview(first.id)).subject, "Reset your SoldBench password");
  now = "2026-11-17T12:01:00.000Z";
  assert.equal((await requestReset()).status, 202);
  await assert.rejects(x.mailbox.preview(first.id), /offline_mail_unavailable/);
  assert.equal((await x.mailbox.workOnce()).state, "cancelled");
  const latest = await x.mailbox.workOnce();
  assert.equal(latest.state, "ready_offline");
  now = "2026-11-17T12:31:00.000Z";
  await assert.rejects(x.mailbox.preview(latest.id), /offline_mail_unavailable/);
  assert.equal((await x.mailbox.workOnce()).state, "cancelled");
  assert.equal(await x.mailbox.workOnce(), null);
});

test("account deletion invalidates a ready local email and scrubs its ciphertext in the revocation transaction", async () => {
  const now = "2026-11-17T12:00:00.000Z";
  const x = setup(() => now);
  await x.register("en");
  const verify = await x.mailbox.workOnce();
  const content = await x.mailbox.preview(verify.id);
  assert.equal((await x.post("/auth/verify-email", { token: tokenFrom(content.link) })).status, 202);
  await x.mailbox.workOnce();
  assert.equal((await x.post("/auth/password-reset/request", { email: x.email })).status, 202);
  const pending = await x.mailbox.workOnce();
  assert.equal(pending.state, "ready_offline");
  const authentication = await x.auth.login(x.email, password, {
    clientId: randomUUID(),
    requestId: randomUUID(),
    locale: "en",
  });
  const user = await x.auth.sessionIdentity(authentication.token);
  await new AccountPrivacy(x.auth, () => now).request(user, x.auth.crypto.token(), randomUUID());
  await assert.rejects(x.mailbox.preview(pending.id), /offline_mail_unavailable/);
  assert.equal(
    (await db.query("SELECT length(encrypted_payload) n FROM auth_mail_outbox WHERE id=$1", [pending.id]))
      .rows[0].n,
    0,
  );
});
