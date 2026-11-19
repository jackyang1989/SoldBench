import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { AccountPrivacy, AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService, localPaymentKeys, PaymentLifecycle } from "@soldbench/billing";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { PublicResults, QueryService, RequestAuditService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => !["--once", "--watch"].includes(a)))
  throw new Error("invalid_query_worker_argument");
const config = loadConfig(process.env),
  url = config.databaseUrl ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url),
  abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => abort.abort());
try {
  await migrate(db);
  const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin),
    billing = new BillingService(db),
    payments = config.paymentFixtures
      ? new PaymentLifecycle(billing, config.origin, localPaymentKeys(resolve(config.localStateRoot)))
      : null,
    query = new QueryService(db, auth, billing, new PrivateMediaStore(resolve(config.mediaRoot))),
    worker = `query-${randomUUID()}`,
    audit = new RequestAuditService(query),
    publicResults = new PublicResults(query),
    privacy = new AccountPrivacy(auth);
  let nextMaintenance = 0,
    nextHeartbeat = 0,
    nextPaymentAttempt = 0,
    nextPrivacyAttempt = 0;
  do {
    if (Date.now() >= nextMaintenance) {
      try {
        await audit.purgeExpired();
        await publicResults.prune();
        await privacy.prune();
      } catch {
        console.error("soldbench_query_retention_cleanup_failed");
      }
      nextMaintenance = Date.now() + 60000;
    }
    const result = await query.workOnce(worker);
    if (result) console.log(JSON.stringify({ data_mode: "offline_fixture", ...result }));
    let event;
    if (payments && Date.now() >= nextPaymentAttempt) {
      try {
        event = await payments.workOnce();
      } catch {
        console.error("soldbench_payment_fixture_processing_failed");
        nextPaymentAttempt = Date.now() + 1000;
      }
    }
    if (event) console.log(JSON.stringify({ data_mode: "offline_fixture", payment_event: event }));
    let deletion;
    if (Date.now() >= nextPrivacyAttempt) {
      try {
        deletion = await privacy.workOnce();
      } catch {
        console.error("soldbench_account_privacy_processing_failed");
        nextPrivacyAttempt = Date.now() + 1000;
      }
    }
    if (deletion) console.log(JSON.stringify({ data_mode: "offline_fixture", deletion_job: deletion }));
    if (Date.now() >= nextHeartbeat) {
      await db.query(
        `INSERT INTO worker_heartbeats(worker_kind,last_cycle_at) VALUES('query',clock_timestamp())
         ON CONFLICT(worker_kind) DO UPDATE SET last_cycle_at=greatest(worker_heartbeats.last_cycle_at,excluded.last_cycle_at)`,
      );
      nextHeartbeat = Date.now() + 5000;
    }
    if (args[0] !== "--watch" || abort.signal.aborted) break;
    if (!result && !event && !deletion)
      await setTimeout(1000, undefined, { signal: abort.signal }).catch(() => {});
  } while (!abort.signal.aborted);
} finally {
  await db.end();
}
