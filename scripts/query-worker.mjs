import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { publishNextScheduledContent } from "@soldbench/api";
import {
  AccountPrivacy,
  AuthService,
  localAuthSecrets,
  OfflineMailQueue,
  ResendMailTransport,
  SmtpMailTransport,
  TransactionalMailWorker,
} from "@soldbench/auth";
import { BillingService, localPaymentKeys, PaymentLifecycle } from "@soldbench/billing";
import { database, isDatabaseConnectionError, prepareDatabase, prepareRuntimeDatabase } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { PublicResults, QueryService, RequestAuditService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";
import { assertAllowedDatabaseUrl } from "./runtime-db.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => !["--once", "--watch"].includes(a)))
  throw new Error("invalid_query_worker_argument");
const config = loadConfig(process.env),
  url = config.databaseUrl ?? localDatabaseUrl();
assertAllowedDatabaseUrl(config, url);
const db = database(url),
  abort = new AbortController();
const watch = args[0] === "--watch";
const wait = (milliseconds) => setTimeout(milliseconds, undefined, { signal: abort.signal }).catch(() => {});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => abort.abort());
try {
  if (watch)
    await prepareRuntimeDatabase(db, config.databaseStartup, abort.signal, () =>
      console.error("soldbench_query_worker_startup_database_unavailable"),
    );
  else await prepareDatabase(db, config.databaseStartup);
  const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin),
    processMail = (() => {
      if (config.mail.mode === "resend") {
        const w = new TransactionalMailWorker(auth, new ResendMailTransport(config.mail), {
          from: config.mail.from,
        });
        return () => w.deliverNext();
      }
      if (config.mail.mode === "smtp") {
        const w = new TransactionalMailWorker(auth, new SmtpMailTransport(config.mail), {
          from: config.mail.from,
        });
        return () => w.deliverNext();
      }
      const mailbox = new OfflineMailQueue(auth);
      return () => mailbox.workOnce();
    })(),
    billing = new BillingService(db),
    payments =
      config.paymentsMode === "offline" && config.paymentFixtures
        ? new PaymentLifecycle(billing, config.origin, localPaymentKeys(resolve(config.localStateRoot)))
        : null,
    query = new QueryService(
      db,
      auth,
      billing,
      new PrivateMediaStore(resolve(config.mediaRoot)),
      undefined,
      config.dataMode,
    ),
    worker = `query-${randomUUID()}`,
    audit = new RequestAuditService(query),
    publicResults = new PublicResults(query),
    privacy = new AccountPrivacy(auth);
  let nextMaintenance = 0,
    nextHeartbeat = 0,
    nextPublicationCheck = 0,
    nextPaymentAttempt = 0,
    nextPrivacyAttempt = 0,
    nextMailAttempt = 0,
    retryDelay = 0;
  async function runCycle() {
    if (Date.now() >= nextMaintenance) {
      try {
        await audit.purgeExpired();
        await publicResults.prune();
        await privacy.prune();
      } catch (error) {
        if (isDatabaseConnectionError(error)) throw error;
        console.error("soldbench_query_retention_cleanup_failed");
      }
      nextMaintenance = Date.now() + 60000;
    }
    const result = await query.workOnce(worker);
    if (result) console.log(JSON.stringify({ data_mode: config.dataMode, ...result }));
    let event;
    if (payments && Date.now() >= nextPaymentAttempt) {
      try {
        event = await payments.workOnce();
      } catch (error) {
        if (isDatabaseConnectionError(error)) throw error;
        console.error("soldbench_payment_fixture_processing_failed");
        nextPaymentAttempt = Date.now() + 1000;
      }
    }
    if (event) console.log(JSON.stringify({ data_mode: config.dataMode, payment_event: event }));
    let deletion;
    if (Date.now() >= nextPrivacyAttempt) {
      try {
        deletion = await privacy.workOnce();
      } catch (error) {
        if (isDatabaseConnectionError(error)) throw error;
        console.error("soldbench_account_privacy_processing_failed");
        nextPrivacyAttempt = Date.now() + 1000;
      }
    }
    if (deletion) console.log(JSON.stringify({ data_mode: config.dataMode, deletion_job: deletion }));
    let mail;
    if (Date.now() >= nextMailAttempt) {
      try {
        mail = await processMail();
      } catch (error) {
        if (isDatabaseConnectionError(error)) throw error;
        console.error(
          config.mail.mode === "offline"
            ? "soldbench_offline_mail_processing_failed"
            : "soldbench_mail_delivery_processing_failed",
        );
        nextMailAttempt = Date.now() + 1000;
      }
    }
    if (mail) {
      console.log(
        JSON.stringify(
          config.mail.mode === "offline"
            ? { data_mode: config.dataMode, mock_mail: mail }
            : { data_mode: config.dataMode, mail_delivery: mail },
        ),
      );
    }
    if (Date.now() >= nextPublicationCheck) {
      try {
        const publication = await publishNextScheduledContent(db);
        if (publication) console.log(JSON.stringify({ data_mode: config.dataMode, publication }));
        nextPublicationCheck = Date.now() + (publication ? 0 : 1000);
      } catch (error) {
        if (isDatabaseConnectionError(error)) throw error;
        console.error("soldbench_scheduled_content_processing_failed");
        nextPublicationCheck = Date.now() + 1000;
      }
    }
    if (Date.now() >= nextHeartbeat) {
      await db.query(
        `INSERT INTO worker_heartbeats(worker_kind,last_cycle_at) VALUES('query',clock_timestamp())
         ON CONFLICT(worker_kind) DO UPDATE SET last_cycle_at=greatest(worker_heartbeats.last_cycle_at,excluded.last_cycle_at)`,
      );
      nextHeartbeat = Date.now() + 5000;
    }
    return Boolean(result || event || deletion || mail);
  }
  while (!abort.signal.aborted) {
    let busy;
    try {
      busy = await runCycle();
      if (retryDelay) console.info("soldbench_query_worker_database_recovered");
      retryDelay = 0;
    } catch (error) {
      if (!watch || !isDatabaseConnectionError(error)) throw error;
      if (!retryDelay) console.error("soldbench_query_worker_database_unavailable");
      retryDelay = retryDelay ? Math.min(10000, retryDelay * 2) : 1000;
      nextHeartbeat = 0;
      await wait(retryDelay);
      continue;
    }
    if (!watch) break;
    if (!busy) await wait(1000);
  }
} catch (error) {
  if (!abort.signal.aborted) throw error;
} finally {
  await db.end();
}
