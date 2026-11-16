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
