# 07　API、MCP、Skill 与开发者交付

审计日 2026-11-18。基线 `808b987`，OpenAPI 1.16.0。65 项 operation 均按方法和路径对照 Hono 注册（逐项索引见下）。挂载、返回样例符合 schema、业务状态机符合契约、真实外部可用是四个不同的验收对象。

## 跨入口行为

| 行为 | 当前本地实现 | 合同和边界 |
|---|---|---|
| REST 搜索 | GET /v1/sold，当前有效请求走 202，明确用户操作才提交。q 经 NFC、缩空格、限 1–120 字。US、90 天、item_plus_observed_shipping、50 条、allow_stale=false。 | limit 1–200；30/90 可用，180/365 返回 422。OpenAPI 还设计同步 200；现有示例只实现异步协议，若启用同步交付需增加 200 分支和显式收费告知。 |
| Web | 登录者 POST /web/search 经过 queryParameters→normalizeQuery→同一 submit、key/session、owner 与账本。匿名者检查 Origin，只读允许公开的合成缓存，返回聚合摘要，受访客及网络双预算约束。 | 用户首页表单 GET /research，与 POST JSON 适配器不同。实际进程路由检查两个语言的研究和账户入口均 404；真实浏览器 E2E 见 08。 |
| MCP | POST /mcp，Bearer、无 Cookie。sold_search 的 search/status/result/claim 分别复用 submit/job/result/result(claim)，sold_stats 只读已可读快照。展示最多 20 行，返回完整统计及截断信息。 | 请求输入约束、错误传输和行数有所不同；同 owner/规范参数应得到相同 query_id、源水位、hash、版本、样本数及统计，重复领取 0 credit。SDK 两种协议有本机测试。两种真实宿主安装与权限体验 NOT VERIFIED。 |
| 新查与复取 | 已查询 hash 含窗口、limit、allow_stale、强属性与价格范围；同 owner 10 分钟内复用。统计基于完整冻结候选，返回行数不决定费用。展示排序、语言、翻页、stats、复取免费。 | 202、计算、轮询、失败、低样本、允许 stale 不扣。fresh 且 ≥8 的未领取结果 409，owner 显式 POST claim、同幂等键，单事务至多一笔。响应丢失可 GET 或原键重放。 |
| 金额、时间和覆盖 | USD 整数分、未知 null；meta 有 data_as_of、版本、candidate_set_hash、合成模式及返回/可见/完整计数。错误沿 error.code/message/details/request_id，响应头 X-Request-ID。 | 时间精度缺口见 06 D3。分页不要通过改 limit 实现，limit 变更会改变查询身份。usage/history/diagnostics/logs 用签名 cursor，默认20、上限100；当前详情行列表无翻到下一展示页的游标。 |
| 配额与恢复 | PG 按 owner 聚合多把 key 的请求，Free 候选 30/min，付费取有效确认周期 plan。429 携 Retry-After。400 修入参；401 重新授权；402 ready 保留到期可补额度；403 停分发；409 按具体码处理；410 已过期；503 按是否有可用水位恢复。 | 备用支付和外部升级仍属商业门禁。客户回调订阅不在当前查询交付契约；支付供应商通知单独验签。 |

实现可核对 [REST](../apps/api/src/queries.ts)、[MCP](../apps/api/src/mcp.ts)、[共享查询](../packages/core/src/query.ts)、[PG 交付](../packages/query/src/index.ts)。[本机 SDK 测试](../tests/mcp.test.mjs) 覆盖现代及 legacy 协商、权限、公开/私有差异、402 后领取、REST 复用、20 行截断及完整统计；[服务测试](../tests/query-billing.test.mjs) 覆盖 100 并发、重启、退款及钱包跨期。

## 契约断点与可执行的修复

| ID / 级别 | 客户观察与证据 | 整改责任与验收 |
|---|---|---|
| A1 P1 | OpenAPI /v1/sold 声明 attr_grade_company/value、attr_memory_gb、attr_color 等，core/src/query.ts:21–28 使用 grading_company、grade、vram_gb、colorway。声明的 grade 组合别名未拆解。本机规范化器：cards_graded＋attr_grade_company=PSA、attr_grade_value=PSA 均 400；attr_grading_company=PSA 可接受；attr_grade=PSA 9 得到单值 grade。 | API/数据负责人从真实 taxonomy 单源生成 REST/JSON/MCP、Quickstart 及 category discovery，签收旧别名与冲突处理；逐个枚举三入口，语义等价的表示须同 hash/同收费，不支持项明确 400。新 normalizer 版本须处理旧查询复用。 |
| A2 P1 | OpenAPI:412 明确按完整受权快照 sort 后限条。queries.ts:201 结果处理不读取 sort，query/src/index.ts:618 只按已存 presentation_order 返回，写入时已按 limit 截断。用户选价格升序可能看到近期记录；core 的排序单测无法覆盖此路由。 | Research/API 将只读 sort 接上完整、有当前字段许可的冻结行。用 58 条、limit=5、最便宜记录位于日期后段的夹具检验 HTTP 首条改变、原 hash/账本不变、空值置后。 |
| A3 P1 | OpenAPI:1250 的 GET /v1/queries 只声明 Session，queries.ts:248 调用默认 identity（接受 sold:read key）；query/src/index.ts:904 历史 DTO 包括 owner 的 q、filters。共享给集成的 key 可能读到未经该 key 发起的同账户研究。 | 身份/API 负责人按冻结契约收紧为 session 并测试 owner 与同 owner key 的区别；若业务确需 key 历史，先决策单独授权范围与兼容迁移。现有跨 owner 断言不能检验同 owner 内功能授权。 |
| A4 P1 | POST /v1/jobs/{id}/cancel 在 OpenAPI:784 需 Idempotency-Key 并回 200 JobResponse。queries.ts:213–236 校验 version，不用该头，给 204 空体；query/src/index.ts:814 使用版本比较，已取消重放可能 409。 | 后端/SDK 统一命令幂等性与返回 DTO，保留乐观锁；模拟服务提交后丢包、原 key 重试、并发另一版本，验证每次响应、终态、无收费和日志都一致。 |
| A5 P1 | GET /v1/categories 和 /v1/data-status 对外 schema 有 200，均无 Hono 注册。实际在 createApp 的进程请求两者都返回 404 not_found。公共 /status 服务健康 DTO 无法替代品类词典、开放窗口与最后有效轨迹。 | 产品/API 共同交付 taxonomy 及按类目的受控状态，明确 fixture/未知覆盖和开放历史；无源情况下可查看资格，OpenAPI/发现页与运行一致。 |
| A6 P2 | Skill references/api-reference.md:19 写日志支持 error filters；queries.ts:286–304 仅收 cursor/page_size/channel/operation/status。另有脚本仅以路径存在来生成 implementation-status，会把两个恒拒绝通知入口列为 present。 | 开发者文档在现有行为上修订过滤列表并列明禁用/契约规划入口。若需新过滤先走 API 变更。以生成文档中的各筛选和适配器开关作验收。 |

本次 2026-11-18 在当前仓库使用 Node 22.23.3，loadConfig({})、createApp 与空查询适配器，在进程 HTTP 检查发现页和首页目标；A1 使用已构建 @soldbench/core 的 normalizeQuery，未连接 DB。再用末端领域服务 stub 检查 HTTP 参数传递（没有 PG 和账务副作用）：A2 date_desc 与 price_asc 均返回 200、领域参数中均无排序；A4 无 Idempotency-Key 的 version=1 请求向取消服务传 1，HTTP 204 空体。此探针只验证协议适配器，取消事务行为取自领域代码。A3 的依据为路径代码与冻结契约比对。可复现的无状态检查：

```sh
node --input-type=module <<'JS'
import {createApp} from '@soldbench/api';
import {loadConfig} from '@soldbench/shared';
import {normalizeQuery} from '@soldbench/core';
const app=createApp(loadConfig({}),{query:async()=>({rows:[]})});
for (const p of ['/v1/categories','/v1/data-status','/research?q=x','/zh-CN/research?q=x'])
  console.log(p,(await app.request(p)).status);
for (const k of ['attr_grade_company','attr_grading_company','attr_grade_value','attr_grade']) {
  try {console.log(k,normalizeQuery(new URLSearchParams({q:'card',category:'cards_graded',[k]:k==='attr_grade'?'PSA 9':'PSA'})).attributes);}
  catch (e) {console.log(k,e.status,e.code);}
}
JS
```

## 开发者与 Agent 安装/运行交接草案（按当前实现）

1. 打开本机 /docs，当前重定向 /docs/en/quickstart；中文文档可直接访问 /docs/zh-CN/quickstart。公开资源 /openapi.json、/llms.txt、/.well-known/skills/index.json 和索引指向的 SKILL.md。确认 offline_fixture、受权市场窗口和本机 base，阅读 Skill 及 linked references；按宿主文档将 Skill 包保留原目录结构导入。逐宿主自动安装流程尚待验收。
2. 个人开发者本机可按 Quickstart 启动独立专用 PG，运行 npm run developer:demo，私下加载 .local/developer-demo.env 后启动 npm run dev。此入口产生 synthetic 演示身份。普通新用户自主注册、收验证邮件、通过网页创建 key 尚需页面/邮件交付。API key 应由服务端或宿主 secret store 注入，作用域至少按动作分别给 sold:read、jobs:read，查使用日志另需 usage:read。创建/轮换仅首次显示明文；泄露后撤销并核对日志。
3. MCP 配置 Streamable HTTP URL 为本机 http://127.0.0.1:3000/mcp，Bearer 从宿主 secret store 读取；无 Cookie，无 OAuth 自动发现。完成协议握手后列出工具；search 参数例为 `{"action":"search","query":{"q":"Nintendo Switch OLED","limit":50}}`。保存 query_id、job_id，轮询 status；到 completed 先 result。仅在使用者认可最多 1 credit 后以稳定幂等键 claim。sold_stats 接收已有 query_id；用户要求取消时改用 REST 的同一 owner job，目前取消语义依 A4 核验。
4. 用 `node developer/examples/sold.ts --claim`、`python3 developer/examples/sold.py --claim` 或 `sh developer/examples/sold.sh --claim` 运行工作样例；去掉 --claim 可观察首次付费结果的 409。curl 入口依赖同目录 Python，Node 示例为 TypeScript，暂无独立发布的 JS/npm 或 Python SDK。客户端轮询有界、同一 claim 重试沿原 key、按 Retry-After 退避、禁止重定向，核对 HTTP/工具 isError。
5. 返回金额保留整数分和口径，引用 query_id、as_of、candidate_set_hash；报告 n_observed/n_comparable/n_price_verified 及 mixed_models 警告。price_status 非 verified_actual 不能借挂牌给出接受价。仅在获准详情提供链接时引用原记录；合成证据需标示。低样本回传范围与 null 中心；缺权停止交付。核查 /v1/usage、/v1/requests 的费用及 request_id，避免在日志或工单中粘贴 key。

## Docs 逐项目审查

| 主题 | 实物 | 待交付或限制 |
|---|---|---|
| Getting Started / Authentication / API Keys | 双语 quickstart、authentication；REST key 创建/轮换/撤销及测试。 | Quickstart 偏仓库维护者，普通注册用户第一把 key 的可见路径尚缺。 |
| API Reference / Parameters / Schema / Pagination / Filter / Sort | /openapi.json、sold-search、研究 DTO、签名 cursor。 | A1–A5；补 cursor 实际例与 error/refetch 示例，标清 owner 及结果展示 limit 差异。 |
| Errors / Limits / Credits / Async Jobs | errors-and-retries、billing-and-credits、async-jobs，OpenAPI 与错误详情。 | 为 409 各分支、Free 30/min、付费 plan 限额与 429/Retry-After 增补演示；限额价格仍属候选。 |
| Webhooks / Security / Usage / Logs | 支付服务端通知与本机夹具、认证页、日志/用量接口，说明禁止日志泄密。 | 当前无客户结果推送订阅；支付通知不得作为客户 API 功能承诺。补明确查错和撤销后再验。 |
| MCP Setup / Skill / Code Examples | 双语 mcp、可发现 Skill、官方 SDK 两个协商版本、curl/Python/Node TS 真实 fixture 客户端、Postman 集合。 | 两个主流宿主配置、取消/重试/费用确认、可见结果和引用，真实操作均 NOT VERIFIED。 |
| Provenance / Changelog / Migration | 双语 pricing-evidence 与 /changelog；旧过滤快照冲突有条目。 | 原稿 §9.1 规定破坏性升级 /v2 和至少 6 月兼容期；缺面向客户的影响清单、迁移验证与旧 key/客户端回归指引。 |
| 语言 / Docs UI / Playground | 8 对同主题 Markdown、/docs/search 和固定生成资产。 | 无完整可视化文档导航与 Playground 工作台；不宜让用户去比对整份 YAML 后才发现某路由尚无实现。 |

资产与真实示例验收见 [开发者交付测试](../tests/developer.test.mjs) 和[历史回执](../step0/evidence/developer-delivery-20261118/validation.json)。示例的本机 PG/HTTP 可运行性与过去的宿主缺口分别记录。大版本变更前应按旧客户端读新快照、新客户端读旧快照、未识别枚举和新增可空字段做双向兼容验证。

## 冻结端点逐项对照

路径列使用规范模板。实现位置为 `apps/api/src/` 下文件及行号。安全列来自 OpenAPI operation。测试列为目录 `tests/` 中相应业务包的验收入口，供复查对应业务。若某项只有注册证据，仍需按该 operation 对状态码、响应体和权限矩阵逐一实测。真实第三方联调、公开域名及来源场景全部 NOT VERIFIED。

| 方法与路径 | operationId | 规范身份 / scope | 本机入口及结论 | 关联用例 |
|---|---|---|---|---|
| `GET /v1/media/{image_id}` | getPrimaryImage | ApiKey, Session | `queries.ts:311` 已挂载，离线 | media.test.mjs |
| `GET /v1/sold` | searchSold | ApiKey, Session · sold:read | `queries.ts:152` 异步 202；属性冲突 · A1 | query-billing.test.mjs |
| `GET /v1/sold/{id}` | getSoldResult | ApiKey, Session · sold:read | `queries.ts:201` sort 未接入 · A2 | query-billing.test.mjs |
| `POST /v1/sold/{id}/claim` | claimSoldResult | ApiKey, Session · sold:read | `queries.ts:202` 已挂载，离线 | query-billing.test.mjs |
| `GET /v1/jobs/{id}` | getJob | ApiKey, Session · jobs:read | `queries.ts:206` 已挂载，离线 | query-billing.test.mjs |
| `POST /v1/jobs/{id}/cancel` | cancelJob | ApiKey, Session · jobs:read | `queries.ts:213` 204/version，与契约冲突 · A4 | query-billing.test.mjs |
| `GET /v1/categories` | listCategories | 公开 | 缺路由，实测 404 · A5 | 待新增发现接口用例 |
| `GET /v1/data-status` | getDataStatus | 公开 | 缺路由，实测 404 · A5 | 待新增发现接口用例 |
| `GET /v1/usage` | getUsage | ApiKey, Session · usage:read | `queries.ts:241` 已挂载，离线 | query-billing.test.mjs |
| `GET /v1/queries` | listQueries | Session | `queries.ts:248` 另接受 sold:read key · A3 | query-billing.test.mjs |
| `GET /v1/keys` | listKeys | Session | `auth.ts:252` 已挂载，离线 | auth-access.test.mjs |
| `POST /v1/keys` | createKey | Session | `auth.ts:255` 已挂载，离线 | auth-access.test.mjs |
| `DELETE /v1/keys/{id}` | revokeKey | Session | `auth.ts:284` 已挂载，离线 | auth-access.test.mjs |
| `GET /v1/sold/{id}/calculation-inputs` | getCalculationInputs | ApiKey, Session · sold:read | `queries.ts:203` 日精度丢失 · D3 | query-billing.test.mjs |
| `POST /v1/shares` | createShare | Session | `public-results.ts:53` 已挂载，离线 | public-results.test.mjs |
| `GET /v1/shares` | listShares | Session | `public-results.ts:74` 已挂载，离线 | public-results.test.mjs |
| `DELETE /v1/shares/{id}` | revokeShare | Session | `public-results.ts:93` 已挂载，离线 | public-results.test.mjs |
| `GET /share/{token}` | getShare | 公开 | `public-results.ts:100` 已挂载，离线 | public-results.test.mjs |
| `POST /auth/register` | register | 公开 | `auth.ts:133` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/verify-email` | verifyEmail | 公开 | `auth.ts:141` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/login` | login | 公开 | `auth.ts:146` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/logout` | logout | Session | `auth.ts:153` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/password-reset/request` | requestPasswordReset | 公开 | `auth.ts:165` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/password-reset/confirm` | confirmPasswordReset | 公开 | `auth.ts:175` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/verification/resend` | resendVerification | 公开 | `auth.ts:170` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/reauthenticate` | reauthenticate | Session | `auth.ts:181` 已挂载，离线 | auth-access.test.mjs |
| `POST /account/password` | changePassword | Session | `auth.ts:193` 已挂载，离线 | auth-access.test.mjs |
| `GET /account/sessions` | listSessions | Session | `auth.ts:200` 已挂载，离线 | auth-access.test.mjs |
| `DELETE /account/sessions/{id}` | revokeSession | Session | `auth.ts:203` 已挂载，离线 | auth-access.test.mjs |
| `POST /account/deletion-requests` | requestDeletion | Session | `auth.ts:108` 已挂载，离线 | privacy.test.mjs |
| `GET /account/deletion-requests/{id}` | getDeletion | Session, DeletionReceipt | `auth.ts:127` 已挂载，离线 | privacy.test.mjs |
| `POST /billing/checkout` | createCheckout | Session | `payments.ts:78` 仅本机模拟 | payments.test.mjs |
| `POST /billing/cancel` | cancelSubscription | Session | `payments.ts:99` 仅本机模拟 | payments.test.mjs |
| `GET /billing/subscription` | getSubscription | Session | `payments.ts:96` 仅本机模拟 | payments.test.mjs |
| `POST /billing/portal` | createBillingPortal | Session | `payments.ts:105` 仅本机模拟 | payments.test.mjs |
| `POST /webhooks/paddle` | webhookPaddle | PaddleSignature | `payments.ts:151` 无开发准入，恒拒绝 | payments.test.mjs |
| `POST /webhooks/dodo` | webhookDodo | DodoSignature | `payments.ts:154` 备用渠道，恒拒绝 | payments.test.mjs |
| `POST /webhooks/stripe` | webhookStripe | StripeSignature | `payments.ts:149` 仅本机模拟 | payments.test.mjs |
| `POST /webhooks/paypal` | webhookPaypal | PayPalSignature, OfflinePayPalFixtureSignature/OfflinePayPalFixtureTime | `payments.ts:150` 仅本机模拟 | payments.test.mjs |
| `POST /web/search` | webSearch | 匿名, Session, ApiKey | `queries.ts:154` 匿名缓存 / 登录异步 | query-billing、public-results.test.mjs |
| `POST /support/requests` | createSupportRequest | 公开 | `operations.ts:103` 已挂载，离线 | operations.test.mjs |
| `GET /admin/sources` | listAdminSources | Session | `operations.ts:120` 已挂载，离线 | operations.test.mjs |
| `POST /admin/sources/{id}/commands` | sourceCommand | Session | `operations.ts:123` 已挂载，离线 | operations.test.mjs |
| `GET /admin/jobs` | listAdminJobs | Session | `operations.ts:138` 已挂载，离线 | operations.test.mjs |
| `POST /admin/jobs/{id}/retry` | retryAdminJob | Session | `operations.ts:141` 已挂载，离线 | operations.test.mjs |
| `GET /admin/billing` | listAdminBilling | Session | `operations.ts:156` 已挂载，离线 | operations.test.mjs |
| `POST /admin/charges/{id}/refund-credit` | refundQueryCredit | Session | `operations.ts:159` 已挂载，离线 | operations.test.mjs |
| `GET /admin/audit` | listAudit | Session | `operations.ts:171` 已挂载，离线 | operations.test.mjs |
| `GET /v1/sold/{id}/diagnostics` | getSoldDiagnostics | ApiKey, Session · sold:read | `queries.ts:253` 已挂载，离线 | research.test.mjs |
| `GET /billing/payments` | listPayments | Session | `payments.ts:108` 仅本机模拟 | payments.test.mjs |
| `GET /auth/me` | currentSession | Session | `auth.ts:152` 已挂载，离线 | auth-access.test.mjs |
| `POST /auth/mfa/verify` | verifyMfa | Session | `auth.ts:226` 已挂载，离线 | auth-access.test.mjs |
| `GET /account/mfa` | mfaStatus | Session | `auth.ts:208` 已挂载，离线 | auth-access.test.mjs |
| `DELETE /account/mfa` | disableMfa | Session | `auth.ts:240` 已挂载，离线 | auth-access.test.mjs |
| `POST /account/mfa/setup` | setupMfa | Session | `auth.ts:211` 已挂载，离线 | auth-access.test.mjs |
| `POST /account/mfa/confirm` | confirmMfa | Session | `auth.ts:216` 已挂载，离线 | auth-access.test.mjs |
| `POST /account/mfa/recovery-codes` | regenerateRecoveryCodes | Session | `auth.ts:247` 已挂载，离线 | auth-access.test.mjs |
| `POST /v1/keys/{id}/rotate` | rotateKey | Session | `auth.ts:269` 已挂载，离线 | auth-access.test.mjs |
| `GET /v1/sold/{id}/comps/{event_id}` | getSoldCompDetail | ApiKey, Session · sold:read | `queries.ts:261` 已挂载，离线 | research.test.mjs |
| `POST /v1/sold/{id}/export` | exportSoldResearch | ApiKey, Session · sold:read | `queries.ts:269` 已挂载，离线 | research.test.mjs |
| `GET /v1/requests` | listRequestAudit | ApiKey, Session · usage:read | `queries.ts:286` 过滤差异 · A6 | research.test.mjs |
| `POST /mcp` | callMcp | ApiKey · sold:read, jobs:read for status | `mcp.ts:98` 仅 POST 工具请求 | mcp.test.mjs |
| `GET /billing/checkout/{id}` | getOfflineCheckout | Session | `payments.ts:89` 仅本机模拟 | payments.test.mjs |
| `GET /account/deletion-requests/by-receipt` | findDeletionByReceipt | DeletionReceipt | `auth.ts:121` 已挂载，离线 | privacy.test.mjs |
| `GET /status` | getPublicStatus | 匿名 | `operations.ts:119` 已挂载，离线 | operations.test.mjs |
