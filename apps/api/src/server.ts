import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import {
  AuthService,
  localAuthSecrets,
  ResendMailTransport,
  SmtpMailTransport,
  TransactionalMailWorker,
} from "@soldbench/auth";
import {
  BillingService,
  localPaymentKeys,
  PaymentLifecycle,
  PayPalProviderAdapter,
  StripeProviderAdapter,
} from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, prepareRuntimeDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createApp } from "./index.ts";

const config = loadConfig(process.env);
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
if (!config.liveGateAcknowledged) {
  assertLocalDatabaseUrl(config.databaseUrl, [
    resolve(".local/postgres/socket"),
    ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
  ]);
}
const db = database(config.databaseUrl);
const signals = ["SIGINT", "SIGTERM"] as const;
const startup = new AbortController();
const stopStartup = () => startup.abort();

function buildPaymentsLifecycle(billing: BillingService): PaymentLifecycle | undefined {
  if (config.paymentsMode !== "offline") {
    const environment = config.paymentsMode === "stripe_paypal_live" ? "live" : "sandbox";
    const stripe = config.stripe ? new StripeProviderAdapter({ ...config.stripe, environment }) : undefined;
    const paypal = config.paypal ? new PayPalProviderAdapter({ ...config.paypal, environment }) : undefined;
    return new PaymentLifecycle(billing, config.origin, {}, { environment, stripe, paypal });
  }
  if (config.paymentFixtures) {
    return new PaymentLifecycle(billing, config.origin, localPaymentKeys(resolve(config.localStateRoot)));
  }
  return undefined;
}

function buildMailWorker(auth: AuthService): TransactionalMailWorker | null {
  if (config.mail.mode === "resend") {
    return new TransactionalMailWorker(auth, new ResendMailTransport(config.mail), {
      from: config.mail.from,
    });
  }
  if (config.mail.mode === "smtp") {
    return new TransactionalMailWorker(auth, new SmtpMailTransport(config.mail), { from: config.mail.from });
  }
  return null;
}

async function start() {
  for (const signal of signals) process.on(signal, stopStartup);
  let listening = false;
  let mailTimer: ReturnType<typeof setInterval> | null = null;
  try {
    await prepareRuntimeDatabase(db, config.databaseStartup, startup.signal, () =>
      console.error("soldbench_api_startup_database_unavailable"),
    );
    const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin);
    const billing = new BillingService(db);
    const payments = buildPaymentsLifecycle(billing);
    const mailWorker = buildMailWorker(auth);
    if (mailWorker) {
      mailTimer = setInterval(() => {
        void mailWorker.deliverNext().catch((err) => {
          console.error("soldbench_mail_worker_error", err instanceof Error ? err.message : "unknown");
        });
      }, 5000);
      mailTimer.unref();
    }
    const query = new QueryService(
      db,
      auth,
      billing,
      new PrivateMediaStore(resolve(config.mediaRoot)),
      undefined,
      config.dataMode,
    );
    const server = serve(
      {
        fetch: createApp(config, db, { auth, billing, query, payments }).fetch,
        port: config.port,
        hostname: config.host,
      },
      () => {
        const modeLabel = config.liveGateAcknowledged ? "live" : "local";
        console.log(
          `SoldBench ${modeLabel} server listening at ${config.origin} (data_mode=${config.dataMode}, payments_mode=${config.paymentsMode}, mail_transport=${config.mailTransport})`,
        );
      },
    );
    let stopping = false;
    const stopServer = () => {
      if (stopping) return;
      stopping = true;
      if (mailTimer) clearInterval(mailTimer);
      server.close(() => {
        void db.end().then(() => process.exit(0));
      });
    };
    for (const signal of signals) process.on(signal, stopServer);
    listening = true;
  } catch (error) {
    if (!startup.signal.aborted) throw error;
  } finally {
    for (const signal of signals) process.removeListener(signal, stopStartup);
    if (!listening) await db.end();
  }
}

await start();
