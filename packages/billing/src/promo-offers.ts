import { createHash } from "node:crypto";
import type { Database, Transaction } from "@soldbench/db";
import { transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import type { BillingService } from "./index.ts";

export type PromoActor = {
  userId: string;
  assertCurrent?: (c: Transaction, now: Date) => Promise<unknown>;
};

type CampaignRow = {
  id: string;
  code: string;
  title_en: string;
  title_zh: string;
  credits: number;
  valid_days: number;
  max_redemptions: number;
  redemption_count: number;
  starts_at: Date;
  ends_at: Date;
  status: "draft" | "active" | "paused" | "ended";
  commercial_approved: boolean;
  policy_version: string;
};

type RedemptionJoinedRow = {
  id: string;
  campaign_id: string;
  campaign_code: string;
  title_en: string;
  title_zh: string;
  grant_id: string;
  wallet_id: string;
  credits_granted: number;
  remaining_balance: number;
  wallet_status: string;
  expires_at: Date;
  created_at: Date;
  commercial_approved: boolean;
};

type OfferVersionRow = {
  offer_version: string;
  plan_code: string;
  billing_cadence: string;
  currency: string;
  amount_cents: string | number;
  credits: number;
  status: string;
  commercial_approved: boolean;
  effective_from: Date;
  effective_until: Date | null;
  notes_en: string;
  notes_zh: string;
};

function fail(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

function normalizePromoCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,48}$/.test(code)) {
    fail("invalid_parameter", 400, "Promo code must be 3-48 alphanumeric, underscore, or hyphen characters.");
  }
  return code;
}

function normalizeIdempotencyKey(raw: string | undefined): string {
  const clean = raw?.trim() ?? "";
  if (!/^[\x21-\x7e]{8,128}$/.test(clean)) {
    fail("invalid_parameter", 400, "A valid Idempotency-Key header (8-128 visible ASCII chars) is required.");
  }
  return createHash("sha256").update(clean).digest("hex");
}

/**
 * Coordinates single-use promo redemptions backed by BillingService wallets/ledger
 * and immutable versioned pricing offer catalogs (`TASK-062`, `AT-081`).
 */
export class PromoOfferService {
  constructor(
    readonly db: Database,
    readonly billing: BillingService,
  ) {}

  async redeemPromo(actor: PromoActor, input: { code: string; idempotencyKey: string | undefined }) {
    const normalizedCode = normalizePromoCode(input.code);
    const idempotencyDigest = normalizeIdempotencyKey(input.idempotencyKey);

    return transaction(this.db, async (c) => {
      await this.billing.lockOwner(c, actor.userId);
      const now = await this.billing.now(c);
      await actor.assertCurrent?.(c, now);
      await this.billing.expireLocked(c, actor.userId, now);
      if (await this.billing.hasPaymentHold(c, actor.userId)) {
        fail(
          "credit_recovery_required",
          402,
          "Open payment recovery or dispute blocks new promo redemptions.",
        );
      }

      const replay = (
        await c.query<{
          id: string;
          campaign_code: string;
          credits_granted: number;
          wallet_id: string;
          grant_id: string;
          expires_at: Date;
          commercial_approved: boolean;
        }>(
          `SELECT r.id, c.code AS campaign_code, r.credits_granted, r.wallet_id, r.grant_id,
                  r.expires_at, c.commercial_approved
           FROM promo_redemptions r
           JOIN promo_campaigns c ON c.id = r.campaign_id
           WHERE r.user_id=$1 AND r.idempotency_key=$2`,
          [actor.userId, idempotencyDigest],
        )
      ).rows[0];
      if (replay) {
        if (replay.campaign_code !== normalizedCode) {
          fail("idempotency_conflict", 409, "Idempotency-Key already used for a different promo code.");
        }
        return {
          redemption_id: replay.id,
          campaign_code: replay.campaign_code,
          credits_granted: replay.credits_granted,
          wallet_id: replay.wallet_id,
          grant_id: replay.grant_id,
          expires_at: replay.expires_at.toISOString(),
          replayed: true,
          commercial_approved: replay.commercial_approved,
        };
      }

      const campaign = (
        await c.query<CampaignRow>(
          `SELECT id, code, title_en, title_zh, credits, valid_days, max_redemptions, redemption_count,
                  starts_at, ends_at, status, commercial_approved, policy_version
           FROM promo_campaigns WHERE code=$1 FOR UPDATE`,
          [normalizedCode],
        )
      ).rows[0];
      if (!campaign) {
        fail("promo_not_found", 404, "Promo campaign was not found.");
      }

      const priorUserClaim = await c.query(
        "SELECT id FROM promo_redemptions WHERE campaign_id=$1 AND user_id=$2",
        [campaign.id, actor.userId],
      );
      if (priorUserClaim.rowCount) {
        fail("promo_already_redeemed", 409, "Each account may redeem this promo campaign at most once.");
      }

      if (campaign.status === "ended" || campaign.ends_at <= now) {
        fail("promo_expired", 409, "This promo campaign has expired.");
      }
      if (campaign.status !== "active" || campaign.starts_at > now) {
        fail("promo_not_active", 409, "This promo campaign is not currently active.");
      }
      if (campaign.redemption_count >= campaign.max_redemptions) {
        fail("promo_exhausted", 409, "This promo campaign has reached its maximum redemption cap.");
      }

      const expiresAt = new Date(now.getTime() + campaign.valid_days * 86_400_000);
      const grantId = await this.billing.grantLocked(
        c,
        actor.userId,
        {
          kind: "promo",
          provider: "soldbench_promo",
          reference: campaign.id,
          amount: campaign.credits,
          expiresAt,
          policyVersion: campaign.policy_version,
        },
        now,
      );
      const walletId = (
        await c.query<{ wallet_id: string }>("SELECT wallet_id FROM credit_grants WHERE id=$1", [grantId])
      ).rows[0]?.wallet_id;
      if (!walletId) throw new Error("promo_grant_wallet_missing");

      await c.query("UPDATE promo_campaigns SET redemption_count = redemption_count + 1 WHERE id=$1", [
        campaign.id,
      ]);

      const inserted = (
        await c.query<{ id: string }>(
          `INSERT INTO promo_redemptions(
             campaign_id, user_id, grant_id, wallet_id, idempotency_key, credits_granted, expires_at, created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [campaign.id, actor.userId, grantId, walletId, idempotencyDigest, campaign.credits, expiresAt, now],
        )
      ).rows[0];
      if (!inserted) throw new Error("promo_redemption_insert_failed");

      return {
        redemption_id: inserted.id,
        campaign_code: campaign.code,
        credits_granted: campaign.credits,
        wallet_id: walletId,
        grant_id: grantId,
        expires_at: expiresAt.toISOString(),
        replayed: false,
        commercial_approved: campaign.commercial_approved,
      };
    });
  }

  async listRedemptions(actor: PromoActor) {
    return transaction(this.db, async (c) => {
      await this.billing.lockOwner(c, actor.userId);
      const now = await this.billing.now(c);
      await actor.assertCurrent?.(c, now);
      await this.billing.expireLocked(c, actor.userId, now);

      const rows = (
        await c.query<RedemptionJoinedRow>(
          `SELECT r.id, r.campaign_id, c.code AS campaign_code, c.title_en, c.title_zh,
                  r.grant_id, r.wallet_id, r.credits_granted, w.balance AS remaining_balance,
                  w.status AS wallet_status, r.expires_at, r.created_at, c.commercial_approved
           FROM promo_redemptions r
           JOIN promo_campaigns c ON c.id = r.campaign_id
           JOIN credit_wallets w ON w.id = r.wallet_id
           WHERE r.user_id=$1
           ORDER BY r.created_at DESC, r.id DESC`,
          [actor.userId],
        )
      ).rows;

      return {
        items: rows.map((r) => ({
          redemption_id: r.id,
          campaign_code: r.campaign_code,
          title_en: r.title_en,
          title_zh: r.title_zh,
          grant_id: r.grant_id,
          wallet_id: r.wallet_id,
          credits_granted: r.credits_granted,
          remaining_balance: r.remaining_balance,
          wallet_status: r.wallet_status,
          expires_at: r.expires_at.toISOString(),
          redeemed_at: r.created_at.toISOString(),
          commercial_approved: r.commercial_approved,
        })),
      };
    });
  }

  async listOfferVersions() {
    const rows = (
      await this.db.query<OfferVersionRow>(
        `SELECT offer_version, plan_code, billing_cadence, currency, amount_cents, credits,
                status, commercial_approved, effective_from, effective_until, notes_en, notes_zh
         FROM pricing_offer_versions
         ORDER BY effective_from ASC, offer_version ASC`,
      )
    ).rows;
    return {
      offline_fixture_only: true as const,
      commercial_approval_required: true as const,
      historical_orders_immutable: true as const,
      versions: rows.map((r) => ({
        offer_version: r.offer_version,
        plan_code: r.plan_code,
        billing_cadence: r.billing_cadence,
        currency: r.currency,
        amount_cents: Number(r.amount_cents),
        credits: r.credits,
        status: r.status,
        commercial_approved: r.commercial_approved,
        effective_from: r.effective_from.toISOString(),
        effective_until: r.effective_until ? r.effective_until.toISOString() : null,
        notes_en: r.notes_en,
        notes_zh: r.notes_zh,
      })),
    };
  }
}
