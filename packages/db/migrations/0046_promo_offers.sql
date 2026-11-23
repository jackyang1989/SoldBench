CREATE TABLE promo_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL UNIQUE CHECK(code ~ '^[A-Z0-9_-]{3,48}$'),
 title_en text NOT NULL,
 title_zh text NOT NULL,
 credits int NOT NULL CHECK(credits>0 AND credits<=100000),
 valid_days int NOT NULL CHECK(valid_days>0 AND valid_days<=365),
 max_redemptions int NOT NULL CHECK(max_redemptions>0),
 redemption_count int NOT NULL DEFAULT 0 CHECK(redemption_count>=0 AND redemption_count<=max_redemptions),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 status text NOT NULL CHECK(status IN ('draft','active','paused','ended')),
 commercial_approved boolean NOT NULL DEFAULT false,
 policy_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promo_redemptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES promo_campaigns(id),
 user_id uuid NOT NULL REFERENCES users(id),
 grant_id uuid NOT NULL,
 wallet_id uuid NOT NULL,
 idempotency_key text NOT NULL,
 credits_granted int NOT NULL CHECK(credits_granted>0),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,user_id),
 UNIQUE(user_id,idempotency_key),
 FOREIGN KEY(grant_id,wallet_id,user_id) REFERENCES credit_grants(id,wallet_id,user_id)
);
CREATE INDEX promo_redemptions_owner_idx ON promo_redemptions(user_id,created_at DESC);

CREATE TABLE pricing_offer_versions (
 offer_version text PRIMARY KEY,
 plan_code text NOT NULL CHECK(plan_code IN ('starter','pro','purchased_1500','starter_annual','pro_annual','enterprise_volume')),
 billing_cadence text NOT NULL CHECK(billing_cadence IN ('monthly','annual','one_time','custom')),
 currency char(3) NOT NULL CHECK(currency='USD'),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 credits int NOT NULL CHECK(credits>0),
 status text NOT NULL CHECK(status IN ('fixture_baseline','pending_commercial_approval','approved','retired')),
 commercial_approved boolean NOT NULL DEFAULT false,
 effective_from timestamptz NOT NULL,
 effective_until timestamptz CHECK(effective_until IS NULL OR effective_until>effective_from),
 notes_en text NOT NULL,
 notes_zh text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO promo_campaigns(
 code,title_en,title_zh,credits,valid_days,max_redemptions,redemption_count,
 starts_at,ends_at,status,commercial_approved,policy_version
) VALUES
 (
  'LAUNCH50_PREVIEW',
  'Offline Launch Preview Promo (+50 credits · 30d expiry)',
  '离线首发预览促销额度（+50 额度 · 30 天有效）',
  50,
  30,
  100,
  0,
  '2026-01-01T00:00:00Z',
  '2028-01-01T00:00:00Z',
  'active',
  false,
  'promo-offline-v1'
 ),
 (
  'EXPIRED10_PREVIEW',
  'Expired Preview Campaign (+10 credits · 7d expiry)',
  '已过期测试促销活动（+10 额度 · 7 天有效）',
  10,
  7,
  10,
  0,
  '2025-01-01T00:00:00Z',
  '2025-12-31T00:00:00Z',
  'ended',
  false,
  'promo-offline-v1'
 );

INSERT INTO pricing_offer_versions(
 offer_version,plan_code,billing_cadence,currency,amount_cents,credits,
 status,commercial_approved,effective_from,effective_until,notes_en,notes_zh
) VALUES
 (
  'starter-v1-fixture',
  'starter',
  'monthly',
  'USD',
  900,
  2000,
  'fixture_baseline',
  false,
  '2026-11-16T00:00:00Z',
  NULL,
  'Immutable baseline monthly fixture offer; historical orders preserve their exact purchase snapshot.',
  '既有基线月付合成报价；历史已成交订单永久保留原版本快照不被改写。'
 ),
 (
  'pro-v1-fixture',
  'pro',
  'monthly',
  'USD',
  2900,
  10000,
  'fixture_baseline',
  false,
  '2026-11-16T00:00:00Z',
  NULL,
  'Immutable baseline Pro fixture offer; historical orders preserve their exact purchase snapshot.',
  '既有基线专业版月付合成报价；历史已成交订单永久保留原版本快照不被改写。'
 ),
 (
  'purchased-1500-v1-fixture',
  'purchased_1500',
  'one_time',
  'USD',
  1000,
  1500,
  'fixture_baseline',
  false,
  '2026-11-16T00:00:00Z',
  NULL,
  'Non-expiring one-time purchased credit pack fixture baseline.',
  '永久有效一次性购买额度包合成基线。'
 ),
 (
  'starter-annual-v2-draft',
  'starter_annual',
  'annual',
  'USD',
  8400,
  24000,
  'pending_commercial_approval',
  false,
  '2026-11-24T00:00:00Z',
  NULL,
  'Candidate annual Starter version pending unit-economics and founder commercial sign-off before checkout activation.',
  '候选 Starter 年付报价草案，需完成实测成本核算与商业签收后方可开放结账。'
 ),
 (
  'pro-annual-v2-draft',
  'pro_annual',
  'annual',
  'USD',
  27600,
  120000,
  'pending_commercial_approval',
  false,
  '2026-11-24T00:00:00Z',
  NULL,
  'Candidate annual Pro version pending unit-economics and founder commercial sign-off before checkout activation.',
  '候选 Pro 年付报价草案，需完成实测成本核算与商业签收后方可开放结账。'
 ),
 (
  'enterprise-50k-v2-draft',
  'enterprise_volume',
  'custom',
  'USD',
  19900,
  50000,
  'pending_commercial_approval',
  false,
  '2026-11-24T00:00:00Z',
  NULL,
  'Candidate high-volume tier pending cost/abuse verification and commercial sign-off; does not alter existing orders.',
  '候选高用量档位草案，需完成成本与风控验证及商业签收；绝不回溯改写历史订单。'
 );
