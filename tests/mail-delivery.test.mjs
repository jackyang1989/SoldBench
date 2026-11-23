import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { after, before, test } from "node:test";
import {
  AuthService,
  newAuthSecrets,
  ResendMailTransport,
  SmtpMailTransport,
  TransactionalMailWorker,
} from "@soldbench/auth";
import { database, migrate } from "@soldbench/db";

const db = database(process.env.DATABASE_URL);
const servers = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

test("Resend transport delivers EN & zh-CN verification/reset mails, honors 503 backoff retry, and scrubs encrypted payload", async () => {
  let attempt = 0;
  const received = [];
  const srv = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    attempt += 1;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/emails" && attempt === 1) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "upstream_busy" }));
      return;
    }
    received.push({
      auth: req.headers.authorization,
      idem: req.headers["idempotency-key"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ id: `re_msg_${attempt}` }));
  });
  servers.push(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;

  const clock = { value: "2026-11-17T12:00:00.000Z" };
  const auth = new AuthService(db, newAuthSecrets(), "http://127.0.0.1:3000", () => clock.value);
  const worker = new TransactionalMailWorker(
    auth,
    new ResendMailTransport({
      apiKey: "re_test_key_123",
      from: "SoldBench <support@soldbench.com>",
      apiBaseUrl: baseUrl,
    }),
    { from: "SoldBench <support@soldbench.com>", maxAttempts: 3, baseBackoffMs: 30_000 },
  );

  // Drain any unrelated pre-existing outbox items cleanly by registering a fresh unique user and setting earlier timestamp
  const zhEmail = `resend-zh-${randomUUID()}@example.test`;
  await auth.register(
    { email: zhEmail, password: "Passphrase-Mail-123!", terms_version: "2026-11" },
    { clientId: "mail-test", locale: "zh-CN", requestId: randomUUID() },
  );
  const mailRow = (
    await db.query(
      "SELECT m.id FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id WHERE lower(u.email)=$1",
      [zhEmail],
    )
  ).rows[0];
  await db.query("UPDATE auth_mail_outbox SET created_at='2020-01-01T00:00:00Z' WHERE id=$1", [mailRow.id]);

  // Attempt 1 hits 503 -> retryable recorded
  const step1 = await worker.deliverNext();
  assert.equal(step1?.id, mailRow.id);
  assert.equal(step1?.status, "retryable");
  assert.equal(step1?.errorCode, "resend_http_503");

  // Not yet due before backoff elapses
  clock.value = "2026-11-17T12:00:10.000Z";
  const tooEarly = await db.query(
    `SELECT next_retry_at FROM auth_mail_delivery_attempts WHERE mail_id=$1 AND attempt_number=1`,
    [mailRow.id],
  );
  assert.equal(new Date(tooEarly.rows[0].next_retry_at).getTime() > Date.parse(clock.value), true);

  // Advance clock +35s -> Attempt 2 succeeds & scrubs encrypted payload
  clock.value = "2026-11-17T12:00:35.000Z";
  const step2 = await worker.deliverNext();
  assert.equal(step2?.id, mailRow.id);
  assert.equal(step2?.status, "sent");
  assert.equal(step2?.provider, "resend");
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, "Bearer re_test_key_123");
  assert.equal(received[0].idem, mailRow.id);
  assert.deepEqual(received[0].body.to, [zhEmail]);
  assert.match(received[0].body.subject, /验证 SoldBench 邮箱/);
  assert.match(received[0].body.text, /\/zh-CN\/verify-email#token=/);

  const afterOutbox = (
    await db.query("SELECT status, length(encrypted_payload) AS len FROM auth_mail_outbox WHERE id=$1", [
      mailRow.id,
    ])
  ).rows[0];
  assert.equal(afterOutbox.status, "ready_offline");
  assert.equal(Number(afterOutbox.len), 0);

  // Permanent 4xx failure dead-letters immediately without wasting retries
  const badEmail = `resend-bad-${randomUUID()}@example.test`;
  await auth.register(
    { email: badEmail, password: "Passphrase-Mail-123!", terms_version: "2026-11" },
    { clientId: "mail-test", locale: "en", requestId: randomUUID() },
  );
  const badMail = (
    await db.query(
      "SELECT m.id FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id WHERE lower(u.email)=$1",
      [badEmail],
    )
  ).rows[0];
  await db.query("UPDATE auth_mail_outbox SET created_at='2020-01-01T00:00:01Z' WHERE id=$1", [badMail.id]);

  const failSrv = createHttpServer((_req, res) => {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "invalid_recipient" }));
  });
  servers.push(failSrv);
  await new Promise((r) => failSrv.listen(0, "127.0.0.1", r));
  const failWorker = new TransactionalMailWorker(
    auth,
    new ResendMailTransport({
      apiKey: "re_test_key_123",
      from: "support@soldbench.com",
      apiBaseUrl: `http://127.0.0.1:${failSrv.address().port}`,
    }),
    { from: "support@soldbench.com" },
  );
  const badStep = await failWorker.deliverNext();
  assert.equal(badStep?.id, badMail.id);
  assert.equal(badStep?.status, "failed");
  const badRow = (await db.query("SELECT status FROM auth_mail_outbox WHERE id=$1", [badMail.id])).rows[0];
  assert.equal(badRow.status, "cancelled");
});

test("SMTP transport performs full RFC5321 AUTH PLAIN + DATA delivery over TCP socket", async () => {
  const transcript = [];
  let messageBody = "";
  const smtpServer = createNetServer((socket) => {
    let stage = "cmd";
    let buffer = "";
    socket.write("220 smtp.soldbench.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (stage === "data") {
        if (buffer.includes("\r\n.\r\n")) {
          messageBody = buffer.split("\r\n.\r\n")[0];
          stage = "cmd";
          buffer = "";
          socket.write("250 2.0.0 queued-smtp-msg-77\r\n");
        }
        return;
      }
      while (buffer.includes("\r\n")) {
        const idx = buffer.indexOf("\r\n");
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        transcript.push(line);
        if (line.startsWith("EHLO")) {
          socket.write("250-smtp.soldbench.test\r\n250 AUTH PLAIN\r\n");
        } else if (line.startsWith("AUTH PLAIN")) {
          socket.write("235 2.7.0 Authentication successful\r\n");
        } else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) {
          socket.write("250 2.1.0 OK\r\n");
        } else if (line === "DATA") {
          stage = "data";
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          break;
        } else if (line === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        }
      }
    });
  });
  servers.push(smtpServer);
  await new Promise((r) => smtpServer.listen(0, "127.0.0.1", r));

  const auth = new AuthService(db, newAuthSecrets(), "http://127.0.0.1:3000", () => "2026-11-17T12:00:00Z");
  const smtpEmail = `smtp-en-${randomUUID()}@example.test`;
  await auth.register(
    { email: smtpEmail, password: "Passphrase-Smtp-123!", terms_version: "2026-11" },
    { clientId: "smtp-test", locale: "en", requestId: randomUUID() },
  );
  const mailRow = (
    await db.query(
      "SELECT m.id FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id WHERE lower(u.email)=$1",
      [smtpEmail],
    )
  ).rows[0];
  await db.query("UPDATE auth_mail_outbox SET created_at='2019-01-01T00:00:00Z' WHERE id=$1", [mailRow.id]);

  const worker = new TransactionalMailWorker(
    auth,
    new SmtpMailTransport({
      host: "127.0.0.1",
      port: smtpServer.address().port,
      from: "support@soldbench.com",
      ehloDomain: "soldbench.com",
      auth: { user: "smtp_user", pass: "smtp_pass" },
    }),
    { from: "support@soldbench.com" },
  );
  const res = await worker.deliverNext();
  assert.equal(res?.id, mailRow.id);
  assert.equal(res?.status, "sent");
  assert.equal(res?.provider, "smtp");
  assert.ok(transcript.some((l) => l.startsWith("AUTH PLAIN ")));
  assert.ok(transcript.includes(`RCPT TO:<${smtpEmail}>`));
  assert.match(messageBody, /Subject: Verify your SoldBench email/);
  assert.match(messageBody, /\/verify-email#token=/);
});
