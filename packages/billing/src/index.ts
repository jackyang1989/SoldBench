import { createHash, randomUUID } from "node:crypto";
import { type Database, type Transaction, transaction } from "@soldbench/db";
import { AppError, VERSIONS } from "@soldbench/shared";

export const BILLING_VERSION = VERSIONS.billing;
const reject = (code: string, status: number, message: string): never => {
  throw new AppError(code, status, message);
};
export function freePeriod(anchor: Date, now: Date) {
  if (!Number.isFinite(anchor.getTime()) || !Number.isFinite(now.getTime()) || now < anchor)
    throw new Error("invalid_free_anchor");
  const anniversary = (month: number) => {
    const d = new Date(anchor);
    d.setUTCDate(1);
    d.setUTCFullYear(now.getUTCFullYear(), month, 1);
    const last = new Date(d);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    d.setUTCDate(Math.min(anchor.getUTCDate(), last.getUTCDate()));
    return d;
  };
  let month = now.getUTCMonth(),
    start = anniversary(month);
  if (start > now) start = anniversary(--month);
  return { start, end: anniversary(month + 1) };
}
export type Grant = {
  kind: "free" | "subscription" | "purchased" | "promo";
  provider: string;
  reference: string;
  amount: number;
  expiresAt: Date | null;
  periodStart?: Date;
  paymentId?: string;
  policyVersion?: string;
};
/** Internal domain API. No customer endpoint may accept grants or payment confirmations. */
export class BillingService {
  constructor(
    readonly db: Database,
    readonly clock?: () => string,
  ) {}
  async now(c: Transaction): Promise<Date> {
    return this.clock ? new Date(this.clock()) : (await c.query("SELECT clock_timestamp() t")).rows[0].t;
  }
  async lockOwner(c: Transaction, userId: string) {
    const u = (await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId])).rows[0];
    if (u?.status !== "active" || !u.email_verified_at)
      reject("email_verification_required", 403, "An active verified account is required.");
    return u;
  }
  async grantLocked(c: Transaction, userId: string, input: Grant, now: Date) {
    if (
      !Number.isSafeInteger(input.amount) ||
      input.amount < 1 ||
      input.amount > 2147483647 ||
      !input.provider ||
      !input.reference ||
      (input.kind === "purchased" ? input.expiresAt !== null : !input.expiresAt || input.expiresAt <= now)
    )
      throw new Error("invalid_credit_grant");
    const identity = createHash("sha256")
      .update(JSON.stringify([userId, input.kind, input.provider, input.paymentId ?? input.reference]))
      .digest("hex");
    const prior = (await c.query("SELECT * FROM credit_grants WHERE grant_identity=$1", [identity])).rows[0];
    if (prior) {
      if (prior.amount !== input.amount || prior.payment_id !== (input.paymentId ?? null))
        reject("idempotency_conflict", 409, "Grant identity has different terms.");
      return prior.id as string;
    }
    if (input.paymentId) {
      const p = (
        await c.query("SELECT * FROM payments WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          input.paymentId,
          userId,
        ])
      ).rows[0];
      if (p?.state !== "confirmed" || p.refunded_cents !== "0" || p.provider !== input.provider)
        throw new Error("payment_not_confirmed");
    }
    const wallet = randomUUID(),
      grant = randomUUID();
    await c.query(
      "INSERT INTO credit_wallets(id,user_id,bucket_identity,bucket_type,period_start,period_end,expires_at,balance,status) VALUES($1,$2,$3,$4,$5,$6,$6,$7,'active')",
      [
        wallet,
        userId,
        identity,
        input.kind === "free" ? "subscription" : input.kind,
        input.periodStart ?? null,
        input.expiresAt,
        input.amount,
      ],
    );
    await c.query(
      "INSERT INTO credit_grants(id,user_id,wallet_id,grant_identity,amount,payment_id,created_at,grant_kind,provider,provider_ref,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        grant,
        userId,
        wallet,
        identity,
        input.amount,
        input.paymentId ?? null,
        now,
        input.kind,
        input.provider,
        input.paymentId ?? input.reference,
        input.policyVersion ?? BILLING_VERSION,
      ],
    );
    await c.query(
      "INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,grant_id,ref_type,ref_id,idempotency_key,created_at) VALUES($1,$2,$3,$3,'grant',$4::uuid,'grant',$4::text,$5,$6)",
      [wallet, userId, input.amount, grant, `grant:${identity}`, now],
    );
    return grant;
  }
  async grant(userId: string, input: Grant) {
    return transaction(this.db, async (c) => {
      const user = await this.lockOwner(c, userId),
        now = await this.now(c);
      const id = await this.grantLocked(c, userId, input, now);
      if (input.kind === "subscription") await this.ensureFreeLocked(c, user, now);
      return id;
    });
  }
  async expireLocked(c: Transaction, userId: string, now: Date) {
    const rows = (
      await c.query(
        "SELECT * FROM credit_wallets WHERE user_id=$1 AND status='active' AND expires_at<=$2 ORDER BY id FOR UPDATE",
        [userId, now],
      )
    ).rows;
    for (const w of rows) {
      if (w.balance)
        await c.query(
          "INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,ref_type,ref_id,idempotency_key,created_at) VALUES($1::uuid,$2,$3,0,'expire','wallet',$1::text,$4,$5)",
          [w.id, userId, -w.balance, `expire:${w.id}`, now],
        );
      await c.query("UPDATE credit_wallets SET balance=0,status='expired',version=version+1 WHERE id=$1", [
        w.id,
      ]);
    }
  }
  async ensureFreeLocked(c: Transaction, user: { id: string; free_anchor_at: Date | null }, now: Date) {
    if (!user.free_anchor_at || user.free_anchor_at > now) return;
    const paid = (
      await c.query(
        "SELECT 1 FROM subscriptions s WHERE s.user_id=$1 AND s.status IN ('active','trialing') AND s.current_period_start<=$2 AND s.current_period_end>$2 AND EXISTS(SELECT 1 FROM credit_grants g JOIN credit_wallets w ON w.id=g.wallet_id JOIN payments p ON p.id=g.payment_id WHERE g.user_id=s.user_id AND g.grant_kind='subscription' AND g.provider=s.provider AND w.period_start=s.current_period_start AND w.period_end=s.current_period_end AND w.status='active' AND p.state='confirmed')",
        [user.id, now],
      )
    ).rowCount;
    if (paid) {
      const free = (
        await c.query(
          "SELECT w.* FROM credit_wallets w JOIN credit_grants g ON g.wallet_id=w.id WHERE w.user_id=$1 AND w.status='active' AND g.grant_kind='free' ORDER BY w.id FOR UPDATE OF w",
          [user.id],
        )
      ).rows;
      for (const w of free) {
        if (w.balance)
          await c.query(
            "INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,ref_type,ref_id,idempotency_key,created_at) VALUES($1::uuid,$2,$3,0,'expire','wallet',$1::text,$4,$5)",
            [w.id, user.id, -w.balance, `upgrade-expire:${w.id}`, now],
          );
        await c.query("UPDATE credit_wallets SET balance=0,status='expired',version=version+1 WHERE id=$1", [
          w.id,
        ]);
      }
      return;
    }
    const ended = (
      await c.query(
        "SELECT max(s.current_period_end) t FROM subscriptions s WHERE s.user_id=$1 AND s.current_period_end<=$2 AND EXISTS(SELECT 1 FROM credit_grants g JOIN credit_wallets w ON w.id=g.wallet_id JOIN payments p ON p.id=g.payment_id WHERE g.user_id=s.user_id AND g.grant_kind='subscription' AND g.provider=s.provider AND w.period_start=s.current_period_start AND w.period_end=s.current_period_end AND p.state IN ('confirmed','refunded'))",
        [user.id, now],
      )
    ).rows[0].t as Date | null;
    const anchor = ended && ended > user.free_anchor_at ? ended : user.free_anchor_at;
    const p = freePeriod(anchor, now);
    await this.grantLocked(
      c,
      user.id,
      {
        kind: "free",
        provider: "soldbench",
        reference: p.start.toISOString(),
        amount: 100,
        expiresAt: p.end,
        periodStart: p.start,
      },
      now,
    );
  }
  async balance(userId: string) {
    return transaction(this.db, async (c) => {
      const u = await this.lockOwner(c, userId),
        now = await this.now(c);
      await this.expireLocked(c, userId, now);
      await this.ensureFreeLocked(c, u, now);
      const wallets = (
        await c.query(
          "SELECT id,bucket_type,balance,expires_at,period_start,period_end FROM credit_wallets WHERE user_id=$1 AND status='active' ORDER BY expires_at ASC NULLS LAST,bucket_type,id",
          [userId],
        )
      ).rows;
      const recovery = (
        await c.query(
          "SELECT coalesce(sum(credits),0)::text n FROM credit_recoveries WHERE user_id=$1 AND status='open'",
          [userId],
        )
      ).rows[0].n;
      return {
        wallets,
        available_credits: wallets.reduce((n, w) => n + w.balance, 0),
        recovery_credits: Number(recovery),
        billing_policy_version: BILLING_VERSION,
      };
    });
  }
  /** Caller holds owner and query/source locks, and has verified current result eligibility. */
  async consumeLocked(c: Transaction, userId: string, queryId: string, resultHash: string, now: Date) {
    const old = (
      await c.query("SELECT * FROM billing_charges WHERE query_id=$1 AND user_id=$2", [queryId, userId])
    ).rows[0];
    if (old) {
      if (old.result_hash !== resultHash) throw new Error("charged_result_changed");
      return { chargeId: old.id as string, charged: 0 as const };
    }
    const q = (
      await c.query(
        "SELECT q.*,r.candidate_set_hash,r.stats FROM queries q JOIN query_results r ON r.query_id=q.id WHERE q.id=$1 AND q.user_id=$2 FOR UPDATE OF q",
        [queryId, userId],
      )
    ).rows[0];
    if (
      q?.compute_status !== "completed" ||
      q.result_state !== "ready" ||
      q.candidate_set_hash !== resultHash ||
      q.stats.n_price_verified < 8 ||
      q.expires_at <= now
    )
      throw new Error("query_not_chargeable");
    if (
      (await c.query("SELECT 1 FROM credit_recoveries WHERE user_id=$1 AND status='open'", [userId])).rowCount
    )
      reject("credit_recovery_required", 402, "Billing recovery requires review.");
    const u = (await c.query("SELECT id,free_anchor_at FROM users WHERE id=$1", [userId])).rows[0];
    await this.expireLocked(c, userId, now);
    await this.ensureFreeLocked(c, u, now);
    const w = (
      await c.query(
        "SELECT * FROM credit_wallets WHERE user_id=$1 AND status='active' AND balance>0 AND (expires_at IS NULL OR expires_at>$2) ORDER BY expires_at ASC NULLS LAST,CASE bucket_type WHEN 'subscription' THEN 0 WHEN 'promo' THEN 1 ELSE 2 END,id LIMIT 1 FOR UPDATE",
        [userId, now],
      )
    ).rows[0];
    if (!w) reject("insufficient_credits", 402, "No query credits remain.");
    const charge = randomUUID();
    await c.query(
      "INSERT INTO billing_charges(id,query_id,user_id,charged_credits,policy_version,result_hash,state,created_at) VALUES($1,$2,$3,1,$4,$5,'charged',$6)",
      [charge, queryId, userId, BILLING_VERSION, resultHash, now],
    );
    await c.query("UPDATE credit_wallets SET balance=balance-1,version=version+1 WHERE id=$1", [w.id]);
    await c.query(
      "INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,charge_id,ref_type,ref_id,idempotency_key,created_at) VALUES($1,$2,-1,$3,'consume',$4,'query',$5::text,$6,$7)",
      [w.id, userId, w.balance - 1, charge, queryId, `consume:${queryId}`, now],
    );
    return { chargeId: charge, charged: 1 as const };
  }
  /** Trusted operator workflow only; caller authentication is outside this internal service. */
  async refundCredit(userId: string, queryId: string, actorId: string, reason: string) {
    if (!reason.trim()) throw new Error("refund_reason_required");
    return transaction(this.db, async (c) => {
      // Lock users in stable order, including the authorizing operator.
      const users = (
        await c.query(
          "SELECT u.*,EXISTS(SELECT 1 FROM admin_roles a WHERE a.user_id=u.id AND a.role='admin') AS is_admin FROM users u WHERE u.id=ANY($1::uuid[]) ORDER BY u.id FOR UPDATE OF u",
          [[...new Set([userId, actorId])]],
        )
      ).rows;
      const actor = users.find((u) => u.id === actorId);
      if (!actor?.is_admin || actor.status !== "active")
        reject("forbidden", 403, "Operator authorization required.");
      const q = (
        await c.query("SELECT * FROM queries WHERE id=$1 AND user_id=$2 FOR UPDATE", [queryId, userId])
      ).rows[0];
      if (!q) reject("not_found", 404, "Query not found.");
      const charge = (await c.query("SELECT * FROM billing_charges WHERE query_id=$1 FOR UPDATE", [queryId]))
        .rows[0];
      if (!charge) throw new Error("query_not_charged");
      if (charge.state === "refunded") return false;
      const now = await this.now(c);
      await this.expireLocked(c, userId, now);
      const entry = (
        await c.query(
          "SELECT l.*,w.status,w.expires_at,w.balance FROM credit_ledger l JOIN credit_wallets w ON w.id=l.wallet_id WHERE l.charge_id=$1 AND l.kind='consume' FOR UPDATE OF w",
          [charge.id],
        )
      ).rows[0];
      let wallet = entry.wallet_id,
        balance = entry.balance;
      if (entry.status !== "active" || (entry.expires_at && entry.expires_at <= now)) {
        wallet = randomUUID();
        balance = 0;
        await c.query(
          "INSERT INTO credit_wallets(id,user_id,bucket_identity,bucket_type,expires_at,balance,status) VALUES($1,$2,$3,'promo',$4,0,'active')",
          [wallet, userId, `refund:${charge.id}`, new Date(now.getTime() + 30 * 86400000)],
        );
      }
      await c.query("UPDATE credit_wallets SET balance=balance+1,version=version+1 WHERE id=$1", [wallet]);
      await c.query(
        "INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,charge_id,refund_of,ref_type,ref_id,idempotency_key,actor_id,reason,created_at) VALUES($1,$2,1,$3,'refund',$4,$5,'query',$6,$7,$8,$9,$10)",
        [
          wallet,
          userId,
          balance + 1,
          charge.id,
          entry.id,
          queryId,
          `refund:${charge.id}`,
          actorId,
          reason,
          now,
        ],
      );
      await c.query("UPDATE billing_charges SET state='refunded',refunded_at=$2 WHERE id=$1", [
        charge.id,
        now,
      ]);
      await c.query("UPDATE queries SET settlement_status='refunded',version=version+1 WHERE id=$1", [
        queryId,
      ]);
      await c.query(
        "INSERT INTO audit_events(actor_id,action,object_type,object_id,reason,safe_diff,request_id) VALUES($1,'credit.refund','query',$2,$3,$4,$5)",
        [actorId, queryId, reason, JSON.stringify({ charge_id: charge.id }), randomUUID()],
      );
      const refunds = (
        await c.query(
          "SELECT id FROM payments WHERE user_id=$1 AND state='refunded' AND refunded_cents=amount_cents ORDER BY id",
          [userId],
        )
      ).rows;
      for (const payment of refunds) await this.revokePaymentLocked(c, userId, payment.id, now);
      return true;
    });
  }
  private async revokePaymentLocked(c: Transaction, userId: string, paymentId: string, now: Date) {
    const p = (
      await c.query("SELECT * FROM payments WHERE id=$1 AND user_id=$2 FOR UPDATE", [paymentId, userId])
    ).rows[0];
    if (p?.state !== "refunded" || p.amount_cents !== p.refunded_cents)
      throw new Error("full_refund_not_confirmed");
    // Follow credit compensation wallets too: refunded credits cannot survive a cash refund.
    const wallets = (
      await c.query(
        "WITH RECURSIVE lineage(id) AS (SELECT wallet_id FROM credit_grants WHERE payment_id=$1 UNION SELECT r.wallet_id FROM lineage x JOIN credit_ledger used ON used.wallet_id=x.id AND used.kind='consume' JOIN credit_ledger r ON r.refund_of=used.id AND r.kind='refund') SELECT w.* FROM lineage x JOIN credit_wallets w ON w.id=x.id WHERE w.user_id=$2 ORDER BY w.id FOR UPDATE OF w",
        [paymentId, userId],
      )
    ).rows;
    const ids = wallets.map((w) => w.id);
    const used = Number(
      (
        await c.query(
          "SELECT count(DISTINCT b.id) n FROM credit_ledger l JOIN billing_charges b ON b.id=l.charge_id WHERE l.wallet_id=ANY($1::uuid[]) AND l.kind='consume' AND b.state='charged'",
          [ids],
        )
      ).rows[0].n,
    );
    for (const w of wallets) {
      if (w.balance)
        await c.query(
          "INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,ref_type,ref_id,idempotency_key,created_at) VALUES($1,$2,$3,0,'expire','payment',$4,$5,$6)",
          [w.id, userId, -w.balance, paymentId, `payment-revoke:${w.id}:${w.version}`, now],
        );
      if (w.status !== "revoked" || w.balance)
        await c.query("UPDATE credit_wallets SET balance=0,status='revoked',version=version+1 WHERE id=$1", [
          w.id,
        ]);
    }
    if (used)
      await c.query(
        "INSERT INTO credit_recoveries(payment_id,user_id,credits,status,reason,created_at) VALUES($1,$2,$3,'open','confirmed_full_refund_after_consumption',$4) ON CONFLICT(payment_id) DO UPDATE SET credits=excluded.credits WHERE credit_recoveries.status='open'",
        [paymentId, userId, used, now],
      );
    else
      await c.query(
        "UPDATE credit_recoveries SET status='resolved',resolution_ref='all_original_consumptions_credit_refunded' WHERE payment_id=$1 AND status='open'",
        [paymentId],
      );
    return { recoveryCredits: used };
  }
  async revokeConfirmedPayment(userId: string, paymentId: string) {
    return transaction(this.db, async (c) => {
      await this.lockOwner(c, userId);
      return this.revokePaymentLocked(c, userId, paymentId, await this.now(c));
    });
  }
  async reconcile(userId: string) {
    return (
      await this.db.query(
        "SELECT w.id,w.balance,coalesce(sum(l.delta),0)::text ledger_balance FROM credit_wallets w LEFT JOIN credit_ledger l ON l.wallet_id=w.id WHERE w.user_id=$1 GROUP BY w.id HAVING w.balance<>coalesce(sum(l.delta),0)",
        [userId],
      )
    ).rows;
  }
}
