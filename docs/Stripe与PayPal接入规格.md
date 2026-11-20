# Stripe与PayPal接入规格

版本1.0，2026-11-16。用户决定：Stripe主支付；PayPal补充支付；Creem与Dodo先核验审核资格作为备用。本文覆盖早先“Creem/Dodo优先选型、Stripe仅远期候选”建议。仍未取得G0、Stripe/PayPal产品与收付批准或真实凭证；本轮冻结设计契约，不是已接入网站。

## 1. 交付范围与启用条件

| 通道 | 开发目标 | 实际启用条件 |
|---|---|---|
| Stripe | 主通道，Checkout＋Billing订阅＋一次性额度包＋Portal＋Webhook/退款对账 | 真实身份/主体资格、SoldBench产品获准、税费和账务责任落实，沙盒/真实授权验收通过 |
| PayPal | 补充通道，Orders一次性额度包＋Subscriptions＋取消/退款/对账 | 当前中国账户商业API/Subscriptions、产品和结算资格分别确认；有能力的支付方式才显示 |
| Creem、Dodo | 资格/产品/出款路线核验、保留适配边界 | 仅备用准备；未另行批准选用，不启用checkout/webhook或替代扣款 |
| Paddle | 保留旧设计参考 | 当前不开发、不启用，不占用户明确要求的两个备用审核优先级 |

用户提出盈利后考虑香港公司属于未来经营选择，不是已具备实体或Stripe必定批准的证据。若现有Stripe资格不满足，主通道待接入；PayPal若先达条件可作为实际可用方式供单独发布评审，不自动把备用MoR改成主通道。G0/真实发布仍按既有阶段门，不以开户代替来源门。

Stripe Payments/Billing和PayPal直接收款不自动承担原MoR的销售方职责；销售主体、VAT/销售税适用、发票、退款/争议及跨境结算由实际主体和业务审核确认。未确认前不能复用“所有税由MoR处理”的承诺。

## 2. Checkout及渠道隔离

- `CheckoutRequest.provider`可选，`stripe`或`paypal`，默认stripe；省略时保持主通道语义，不因stripe不可用静默切paypal。非启用渠道返回503 `service_unavailable`及可恢复说明，不生成扣款。
- 服务端读取唯一offer/plan配置，绑定owner、环境、provider、商户ID、商品/价格ID、币种、周期/额度及幂等键。前端仅选计划/渠道和offer_version，不提交自定金额或额度。
- 对订阅使用同一owner的创建锁和checkout幂等记录，在两个渠道之间保持一份有效的待付款订阅checkout。已存在有效待支付或已付费订阅时返回现有流程或409 `state_conflict`；不能让同时点击两按钮创建两份可扣费订阅。供应商创建响应丢失先按已持久化request引用对账再恢复，不能直接创建第二份。
- 复用现有users行锁、idempotency_records、pending payment和outbox记录checkout意图/报价快照；记录仍有效时保留原provider，不用语言切换或重新打开页面替换。超时清理先确认原checkout失效/未付款，再释放订阅checkout锁定；测试需覆盖进程崩溃和并发。
- 一次性购买额度包允许明确的多次购买，但同一支付意图重试只有一笔payment/grant；不能拿订阅防重规则阻止正常额度包购买。
- 订阅取消和退款依据该对象的provider路由。Stripe使用官方Customer Portal；PayPal通过自有账单页提供已支持的管理/取消动作，不虚构Stripe式PayPal Portal API；统一portal入口遇不支持能力时明确返回能力限制和自有账单页恢复路径。升级/降级沿用原业务周期规则，在原渠道执行；V1不自动跨渠道迁移订阅，不复制支付令牌或自动创建替代订阅。
- 已有Stripe订阅的用户不能另购PayPal订阅叠加同一期权益；后续明确更换渠道需原订阅终止及周期处理完成后由用户新授权，不能静默续扣两个渠道。

## 3. 事件处理契约

| 来源 | 验证与确认 | 权益依据及重复保护 |
|---|---|---|
| Stripe | 官方SDK验证raw body、Stripe-Signature、签名时间窗和对应环境/商户；无法验证拒绝 | 订阅核对已付invoice与周期/金额，再按provider＋invoice/period发唯一grant；subscription状态事件只同步，不重复发周期额度 |
| Stripe一次性 | Checkout支付状态与实际成功支付核对；异步支付完成后才确认 | 同一PaymentIntent/支付交易只发一次purchased；checkout与payment重复事件不可各发一次 |
| PayPal | 用固定配置的官方验签端点/受支持验证方案，核验transmission头、绑定webhook_id、环境/商户；不从任意cert-url下载内容 | 订阅以成功付款事件及已验证渠道交易/周期映射发grant，不用ACTIVATED单独证明已付费 |
| PayPal一次性 | 服务端创建并capture订单，验证capture已完成、金额/币种/收款方/owner引用 | API capture响应与PAYMENT.CAPTURE.COMPLETED共享同capture唯一grant，不由前端onApprove直接发额度 |
| 两渠道共同 | 原始事件先持久化再ack；验证服务/DB失败返回可重试5xx；不把未验证事件当成功接收 | provider/merchant/environment隔离，事件唯一键之外仍按真实支付业务键去重；乱序主动查询渠道最终对象 |

Stripe官方订阅事件及签名参考：[订阅Webhook](https://docs.stripe.com/billing/subscriptions/webhooks)、[签名](https://docs.stripe.com/webhooks)。PayPal官方列出订阅付款`PAYMENT.SALE.COMPLETED`及退款/撤回事件；订阅激活与付款不是同一条通知。[订阅事件](https://developer.paypal.com/subscriptions/webhooks)、[验签接口](https://developer.paypal.com/api/webhooks/v1)

PayPal验签依官方服务时，当前事件暂时不能在线验证必须拒绝可重试，不能fail open；离线只验证fixture/模拟分支，不声称真实PayPal签名已通过。退款/撤回/争议映射ADR-12，不改写账本。付款到期/失败、渠道取消与本地权益期末分别处理，不能把延迟webhook导致的状态排序当真实发生顺序。

## 4. 冻结契约与验收

OpenAPI设计升至1.3.0，新增stripe/paypal webhook；原Paddle/Dodo端点保留为disabled备用设计，默认拒收处理。provider DTO可识别原渠道及Creem，是否可新建checkout仍以启用名单和资格检查为准，不以枚举存在表示已批准。

`CheckoutRequest.provider`为可选兼容字段；两个通道映射同一核心plan，套餐名/价格/额度仍为候选。新增支付事件/渠道不是统计算法变更，不升级engine/cleaner/parser；billing实现首次建立时用新通道映射版本1.1，保留原credit消费/补偿政策版本，不追溯重发旧grant。SQL文本provider列兼容现设计，本轮不改DDL。

AT-037/038/040/049/050覆盖Stripe与PayPal分别的成功、失败、取消、退款、争议、续期、重复/乱序/响应丢失和账本对账；增加同owner跨渠道100并发订阅创建只形成一个有效支付意图/一期grant，拒绝跨渠道退款，inactive备用无发放。UI双语显示真实可用渠道和交易所属，渠道未开通不出现可用支付按钮。

TASK-029从单MoR调整为Stripe＋PayPal两通道，TASK-042增加跨渠道回归。两个通道的商户账号、最终SDK/API版本及交易税务政策仍需真实确认，不向代码填假密钥、商户号或测试批准。预发布真实签名、渠道API、真实提现和授权小额交易留到对应实际集成/发布门；本轮静态校验不替代。

## 5. 本机实施边界

TASK-029 使用明确启用的本机合成渠道。Stripe 测试通知采用其原始字节与时间窗口签名格式，PayPal 使用独立的本机模拟签名和固定接收方。模拟密钥与商户仅在本机生成。真实 PayPal 验证使用官方验签接口，真实 Stripe 需要已核验的官方 SDK、事件版本和端点密钥。离线构建不向这两个接口发请求。

客户只提交套餐、报价版本、渠道及幂等键。PG 事务写入支付意图和固定报价，订阅意图按 owner 唯一有效，购买包按意图独立。已签名通知先落库再确认。支付处理器读取独立记录的本机渠道确认事实，核对环境、商户、意图、金额、币种、交易归属及订阅周期后才允许发放。支付状态、额度桶与事件终态原子提交。续期按周期和支付交易去重，缺少原交易或当前渠道确认时留待重试。期末取消保持当前已付额度。尚未结案的争议暂停新收费查询，最终全额退款沿既有撤销、回收和审计规则处理，部分退款仅留给真实政策定版后的复核。账单只返回本人安全摘要。离线优惠版本为 `offline-v1`，沿原稿候选数字用于模拟。

设置 `PAYMENT_FIXTURES=true` 后先执行 `npm run payment:fixture -- init`，再在相同环境下启动 `npm run dev`。`LOCAL_STATE_ROOT` 默认 `.local`，其中的密钥文件权限0600。该开关不能改变 `PAYMENTS_MODE=offline`。查询 worker 会处理已经验签的本机支付队列。遇暂时数据库异常回滚并在后续轮询重试，普通查询继续运行。接收与业务处理是两笔事务，验证通过并落库才返回空200，未知事实有可见的有界重试状态。

例如用已获本人会话创建 PayPal `purchased_1500` checkout，从其URL取得 checkout UUID。保存如下JSON，将 paid_at 替换为当次合成交易的UTC时间（在意图创建之后、到期之前）：

```json
{
  "provider": "paypal",
  "event_type": "capture_completed",
  "checkout_id": "00000000-0000-4000-8000-000000000001",
  "object_id": "fixture_capture_1",
  "revision": 1,
  "kind": "transaction",
  "status": "confirmed",
  "amount_cents": 1000,
  "currency": "USD",
  "paid_at": "2026-11-18T00:00:00.000Z",
  "subscription_id": null,
  "period_start": null,
  "period_end": null
}
```

运行 `npm run payment:fixture -- deliver /path/to/fixture.json`。重复模拟通知可固定可选 `event_id`，不同通知指向同交易和版本也不会重复发放。Stripe购买包事件用 `payment_intent_succeeded`，Stripe订阅用 `invoice_paid`、PayPal用 `sale_completed`，均须提供稳定订阅ID与周期。支持全额退款、争议及失败模拟；退款不自动终止原订阅。Stripe Portal 在本机返回自有账单路径，PayPal返回自有管理路径。真实 hosted checkout、PayPal capture/验签、真实 Stripe Portal、同商户支付方案变更及预发布财务对账须按供应商批准环境验收。Creem、Dodo当前仍为资格准备。

本机演练只变更合成账本。订单确认事实是受信本机CLI/测试数据，无公开创建确认事实的路由。迁移0018追加意图、确认事实和事件重试，以及交易/订阅归属约束。OpenAPI1.10增加GET checkout状态、订阅版本和PayPal本机签名方案；真实支付渠道仍各用独立验签方案。

## 6. 值班对账、晚到资金事实与发布签收（2026-11-18 补充）

B1/B3，见 DEC-02/07、TASK-029/035/043 和 AT-037/038/040/054。当前实现以 packages/billing/src/payment-lifecycle.ts、packages/billing/src/index.ts:404 和 tests/payments.test.mjs 为准。BillingService.reconcile 比较钱包余额与 credit_ledger 汇总；渠道现金净额与银行到账仍需独立证据。服务商官方或受控渠道确认事实独立于浏览器回跳、客户截图和工单主张。

### 每日日结及三方交叉核对

| 一方及责任人 | 取数、聚合方法 | 对另外两方检查 |
|---|---|---|
| A · 渠道营业账和结算明细，财务负责人 | 按 provider、环境、merchant、币种、营业日/时区导出每笔成功交易、续期、退款、争议、手续费、汇兑、留存/释放与 payout 批次；保留来源、截止点、文件 hash | 对 B 核金额分、支付状态、意图/owner 引用及周期；对 C 按 payout 汇总净额。付款发生日、可结算日、实际到账日分别留存 |
| B · SoldBench 本地，工程/账务 | 取 checkout 意图、payment_event、payment/订阅或 invoice-period、credit_grant、wallet/ledger、query/charge、恢复与争议记录。用原渠道交易 ID、订阅周期、意图和 owner 核，不用通知次数计算收入 | 同一交易或周期至多一份权益；多张事件回执可对应同一交易。现金金额/退款与 A 比，credits 分桶对 ledger，不将 credit 个数与货币金额相加 |
| C · 实际收款账户，财务负责人 | 按币种、银行入账日、银行流水及原渠道 payout ID（没有 ID 时保留人工匹配凭据）核净收；确认汇兑用的真实汇率和实际费项 | 同批订单按渠道表归总，与到账净额逐币种对齐；跨日/跨期未出款留在途和预计结算日。出款延迟单列，不重复发放已确认付款权益 |

操作记录含 UTC 对账区间与渠道时区、期初/期末余额、三方笔数和金额分、差异分类、归属人、下一检查点与复核人。每个差异保留受控交易引用，库/工单提取物中隐藏商户密钥、付款工具与客户证件。核算渠道可结算余额时，从期初余额加确认收入、释放和其他入项，减退款、争议损失、费用、代扣、冻结和已出款，匹配期末；按渠道报表项目归类以免手续费或冻结款重复扣除。支付聚合币种和银行到账币种不同时，用供应商转换明细和银行实际扣费逐笔桥接，无法解释的尾差单列。

### 离线渠道付款投影复核

运行 `PAYMENT_FIXTURES=true npm run payment:reconcile -- /absolute/path/statement.json`。脚本仅连接已校验的本机 PostgreSQL 目标，以只读事务查询渠道付款。输入由独立的合成渠道记账生成，须提供以下字段。

```json
{
  "schema": "soldbench.payment-statement.fixture.v1",
  "environment": "offline_fixture",
  "provider": "stripe",
  "merchant": "fixture_stripe_soldbench",
  "currency": "USD",
  "from": "2026-09-18T00:00:00.000Z",
  "until": "2026-09-19T00:00:00.000Z",
  "payments": [
    {
      "provider_payment_id": "fixture_payment_001",
      "created_at": "2026-09-18T12:00:00.000Z",
      "state": "confirmed",
      "amount_cents": 1000,
      "refunded_cents": 0
    }
  ]
}
```

PayPal 使用 `paypal` 与 `fixture_paypal_soldbench`。单份文件对应一个渠道和商户。区间按本地付款投影第一次记录的 `created_at` 左闭右开选取，状态与累计退款分使用对账时的快照。支持 `confirmed`、`disputed`、`refunded`。每份最多 20,000 笔、4 MiB。输出现金笔数、毛额、累计退款分、文件 SHA-256 和差异交易的引用摘要。退出 0 表示匹配，2 表示有差异，1 表示输入或运行错误。此命令覆盖 A 与 B 的本机付款投影对比。钱包余额仍按独立账本核对。实际付款到账日、部分退款权益处理、手续费与银行批次仍需真实渠道和财务证据。

### 异常处置与受控恢复

| 触发 | 当班动作 | 恢复/结案证明 |
|---|---|---|
| 回跳先成功，渠道确认未到/DB 暂不可用 | 标记处理中，按同一 owner 和意图读取状态。接收落库失败允许供应商重投；不让客户重购，也不依浏览器回跳发权益 | 原事件验签且持久化、渠道事实确认后原子投影 payment/grant。重投和重复点击仅一份有效权益 |
| 先收到失败、后成功；退款先于付款 | 比对原渠道交易、版本与当前事实；未知或冲突隔离。成功/失败/争议/最终全额退款依现有状态机和不可变账本处理 | 同一业务键、相同最终状态得到相同余额；过期失败不得回滚已确认收款。原未支付或已删除主体不自动发放 |
| 12 次确认重试后才有权威事实 | worker 将超过重试预算的通知置为 failed。记入原 receipt、支付意图与工单；在获准的本机演练中使用下面的复核命令，真实案件按原渠道结算流程处理 | 保留原尝试次数、迟到事实版本及审计，支付与权益同业务键最多生效一次 |
| 渠道扣款重复或实收金额/币种/商户不匹配 | 冻结受影响的投影与新意图，核对渠道最终对象、是否两笔独立成交及授权。真实重复收款按原渠道退款/争议处置 | 保留两笔外部现金事实及各自处置轨迹；只能为获准的权益授一次。管理员 refund-credit 不产生渠道现金退款 |
| 争议、部分退款、已删号、订阅取消后被扣 | 保留案件与现金证据；争议使用既定冻结/回收规则；部分退款的权益比例和已删号后续款项交责任人依据正式政策处理。原通道核取消生效期/授权，不新开其他通道订阅 | 原渠道/订阅位、已消费/未用分开对账；适用退款/拒付的本金、费用与实际到账对应，账本有补正记录，删除账号持续不可登录 |
| payout 缺失或银行到账不符 | 区分在途、留存、手续费、汇率、银行拒收。联系原渠道流程须经实际运营授权，记录案件与后续到账日 | 差异归零或形成经财务签收的在途项；同付款权益和查询扣费保持幂等 |

**本机受控重放。** 启用 `PAYMENT_FIXTURES` 后，近期 MFA 管理员可向 `POST /admin/payments/events/{id}/replay` 提交原本机验签 receipt、`case_reference`、`reason` 和 `Idempotency-Key`。只处理因 `confirmation_pending` 耗尽重试的原事件。读取受控 fixture 最新事实并核对环境、渠道、商户、对象及版本，将匹配确认交由原投影方法复核意图、owner、金额、币种和订阅周期。事实缺失保持待核，更新事实冲突或已删除账户进入人工复核。保留原尝试次数和审计。成功响应或耗尽响应后的同键重放只返回原结果。接收、权益、退款和银行到账各自取证。真实重放仍需渠道与商户批准。

**隔离旧库补放合成支付。** 有付款前的 checkout 意图、独立保存的合成事实和原事件 ID 时，可运行 `payment:fixture -- replay <file>`。启用 `PAYMENT_FIXTURES=true`，明确设置 `PRIVACY_RESTORE_ISOLATED=true` 并用 `PAYMENT_REPLAY_SHA256` 提供独立保存的原文件摘要。文件须私有，沿用合成 `deliver` 格式，`event_id` 必填。命令只处理对应通知，通过既有验签和 Worker 写入。相同通知及业务键允许幂等重试，其他待处理通知保留，失配或没有原意图进入处置。退出 0 表示该通知已应用。对账按渠道业务键核对事实和权益，重新生成的内部 UUID 不参与跨恢复环境的渠道对比。

批量使用 `npm run payment:fixture -- replay-batch <file>`，同样提供独立摘要。文件形状为 `{"schema":"soldbench.payment-replay.fixture.v1","events":[…]}`，最多 100 条、256 KiB。每条沿用单笔格式，按权威记录顺序排列。全文件先核格式、渠道通知类型和重复事件，再逐条应用，首次非成功结果报告从 1 开始的位置并退出 2。保存处理回执并复核该位置。重跑会跳过已经应用的通知，终态失败保留处理记录，后续通知保持待处理。更正后的范围重新取独立摘要再执行。退出 0 表示该批全部应用或已经应用。

**准入与验收。** 逐渠道记录主体、产品批准、允许的订阅/一次性操作、销售方、税/发票/退费/争议责任、真实签名配置、出款及换汇条款的受控引用。先验证供应商沙盒原始签名、订单/Capture、invoice、门户/取消、续费和退款；用 100 并发/多通知验证每周期一次 grant 和同 owner 跨渠道意图锁。追加 B3 合成场景：先令原事件达到失败终态，再注入晚到确认，合并并发重放、可重试数据库异常和回执丢失；最终支付、权益一次生效、审计完整，错商户/已退款/已删号均走确定分支。真实发布前仅由获授权负责人执行 AT-054 小额支付、领取、取消/退款和后续银行到账核对；按各状态的实际时间报告，未出款即记待结算。两主用渠道分别签收，Creem/Dodo 继续核资格。运行隔离及切回见[发布、回滚与撤权恢复手册](发布、回滚与撤权恢复手册.md)。
