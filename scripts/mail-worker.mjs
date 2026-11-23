import { resolve } from "node:path";
import {
  AuthService,
  localAuthSecrets,
  ResendMailTransport,
  SmtpMailTransport,
  TransactionalMailWorker,
} from "@soldbench/auth";
import { database } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";

const config = loadConfig(process.env);
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");

const mode = process.env.MAIL_TRANSPORT ?? "";
const from = process.env.MAIL_FROM ?? "support@soldbench.com";
let transport;
if (mode === "resend") {
  transport = new ResendMailTransport({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from,
    ...(process.env.RESEND_BASE_URL ? { apiBaseUrl: process.env.RESEND_BASE_URL } : {}),
  });
} else if (mode === "smtp") {
  transport = new SmtpMailTransport({
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    from,
    secure: process.env.SMTP_SECURE === "true",
    ...(process.env.SMTP_USER && process.env.SMTP_PASS
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
      : {}),
  });
} else {
  throw new Error("Set MAIL_TRANSPORT=resend or MAIL_TRANSPORT=smtp with valid provider credentials.");
}

const db = database(config.databaseUrl);
try {
  const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin);
  const worker = new TransactionalMailWorker(auth, transport, { from });
  const results = [];
  for (;;) {
    const step = await worker.deliverNext();
    if (!step) break;
    results.push(step);
  }
  console.log(JSON.stringify({ processed: results.length, results }));
} finally {
  await db.end();
}
