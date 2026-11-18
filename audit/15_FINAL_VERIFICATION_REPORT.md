# 最终验证与独立复核

| 维度 | 判定 |
|---|---|
| 审计范围 | **AUDIT_PARTIAL**。代码、规格、离线工程与公开竞品对照已成文。竞品登录后私有工作台、同口径真实成交对照以及完整空账号浏览器任务为 NOT VERIFIED |
| 整改 | **REMEDIATION_PENDING**。六份入口文档更新并补实施草案，产品和运营缺陷保留在风险登记 |
| 发布 | **RELEASE_BLOCKED**。来源许可、质量、核心网页、灾备、收款和经营门未闭合 |
| 现有阶段 | G0 `NOT_ISSUED`。独立审计不代替各阶段验收人或创始人商业签署 |

## 实际执行

基线提交 `808b9875d0f5a0ff005ddb37b8fb1c579b7ec7cd`，2026-11-18（Asia/Singapore）。起始 Git 状态干净。环境 macOS 26.3 arm64，Node v22.23.3，Homebrew PG 16.15，Python 3.9.6。测试启动独立临时 PG16、仅 Unix socket，各套件独立数据库。合成账户与事件，`COLLECTOR_ENABLED=false`、`DATA_MODE=offline_fixture`、`PAYMENTS_MODE=offline`。PoC 锚定 2026-11-16 UTC 并注入故障/时间偏移。工程用例按各测试声明使用模拟或本机时钟，真实生产基线待测。

| 命令 | 结果 | 范围与证据 |
|---|---|---|
| `npm run check` | 通过，25 套件 235 项，0 fail/skip；执行到静态契约收尾 | 初次沙箱内 initdb 创建共享内存获拒，按审批在临时 PG16 重跑。lint/typecheck/build、产品集成和 contracts 通过。 [工程运行](evidence/run/engineering.log) |
| 隔离 PG16 的 `psql -v ON_ERROR_STOP=1 -f docs/contracts/schema.sql -f docs/contracts/verify.sql` | 退出 0 | 47 张初始设计表，24 个关系反例及 owner/source、延迟账本对账，验证事务回滚并已停库。 [设计 SQL 实测](evidence/run/design-relations.log) |
| `npm run test:step0` | PASS，19 项步骤 | 强属性、日期、黄金夹具、故障回放、120 条语料、准备工具及 0/24/48/72h，stage verdict 保留 NOT_ISSUED。 [运行记录](evidence/run/step0.log) |
| `PYTHONPATH=/tmp/soldbench-contract-py python3 docs/contracts/check_contracts.py --formal` | PASS | 使用本机已有 validator 0.7.2；OpenAPI 3.1 / 1.16.0、103 schema、65 操作、15 完整合成实例、18 负例。 [正式校验](evidence/run/openapi-formal.log) |
| `python3 docs/check_docs.py` | PASS | 修订后 50 个规范文档、273 项本地链接、56 TASK、23 PAGE、24 CP、75 AT。 [文档验证](evidence/run/documentation.log) |
| `python3 scripts/check-developer-assets.py` | PASS | 双语链接、Skill 元数据/引用、发现机制、OpenAPI JSON、无凭据集合。真实宿主另验。 [开发者资产](evidence/run/developer-assets.log) |
| 运行产物中的 `/docs/implementation-status.json` | 63 / 65 个路由存在 | categories、data-status 没有注册。路径存在仅作为继续核对请求和状态码的起点。 [实现清单](evidence/run/implementation-status.json) |
| 44 个活动及目标页面路径探针 | 双语首页 200，研究、账户等路径 404 | Hono 进程内，无 DB、无浏览器。仅核证路由与内容类型。 [路由证据](evidence/run/local-page-routes.json) |
| 浏览器可见表单与导航 | 双语查询和中文账户入口出现 not_found | 本机空浏览器与活动回环路由；此 UI 服务未配置数据库和查询。另有隔离 PG16 后端验证。 [独立浏览器走查](evidence/run/browser-walkthrough.md) |
| Hono 进程内适配探针 | A1、A2、A4、A5 与冻结契约冲突 | 用合成输入和末端 stub 核对参数/响应，不触碰外库。 [可复现记录](07_API_MCP_SKILL_REVIEW.md) |

迁移测试验证空库和既有版本升级、重启幂等、关系约束与私有旧备份恢复。金额测试覆盖 121/64/58 与 0/7/8/29/30 边界、limit 50/200、等价请求复用、100 并发同请求与 100 不同请求竞争一份余额、重复付款/迟到/乱序/跨期、原账对账。媒体和分享测试含当前 owner、撤权拒读和清除。此前阶段记录仅作背景，本轮证据索引见 [11 矩阵](11_E2E_ACCEPTANCE_MATRIX.md)。

## 反方复核

- **把全绿当作合规和协议验证**。独立安全审阅从 OpenAPI 到实际代码复核 A3、A4。历史读取仍检查同一 owner，影响为认证面的扩大。取消使用版本保护，差异在公开响应/重试契约。保留两项 P1 及针对性验收。
- **把独立 worker 等价成安全本地入口**。代码审阅独立核对 S1。query worker 在建池前检查目标，API 只在支付夹具模式检查。并行 dev worker 失败退出无法证明 API 已停止迁移。判断为静态风险，外部写入未发生于本次验证。
- **把存在的首页当作研究流程**。另一名审阅用 Hono 进程内请求确认双语首页 200，两语研究/账户入口共四个 404。由此维持网页 P0，首页测试与页面流程验收并存。
- **把正确的内部时间计算当作完整公开证据**。复核原稿时间语义与公开计算输入投影后，保留 D3。官方 eBay 产品展示的 Best Offer 能力也单列于来源材料，实际数据访问未知。
- **以技术完整度替代商业证据**。反查资金压力假设、现有 Stripe/PayPal 与实际主体资格、试点需求、媒体权利、恢复最新性。对 D1/D2/B1/B2/S3 维持 P0；Stage G0–G5 仍遵原责任人和执行顺序。
- **以扩展增长补首发缺口**。回核六类客户的首发最低任务，单结果导出和历史复取保留，批量、长期历史、跨市场任务各有后续编号。核心数据引擎、不可变账本和 PG 服务边界继续复用。

工程范围独立复核完成上述交叉核对。尚待核实的证据包括竞品签入实测、可售数据盲测、主流 MCP 宿主、生产容量和供应链、真实邮件/支付/结算、运营恢复及 G0–G5 实际签收。 [逐页状态](08_UX_PAGE_BY_PAGE_AUDIT.md) · [发布整改](13_OPTIMIZATION_ROADMAP.md)

## 修改边界

本轮修改六份现行说明，新增 17 份编号审计与证据。源码、冻结 OpenAPI、迁移、测试断言、支付金额和权利状态均沿用基线。文档修订详见 [16 修订记录](16_MISSING_DOCUMENTS_AND_REVISIONS.md)。待修缺陷和实际验收列在 [12 整改登记](12_RISK_AND_ISSUE_REGISTER.md)。
