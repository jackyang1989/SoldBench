# SoldBench 全项目审计结论

**审计 `AUDIT_PARTIAL` · 整改 `REMEDIATION_PENDING` · 发布 `RELEASE_BLOCKED`。** SoldBench 已有实质性的离线后端，PG16 隔离测试通过 235 项。公开网站目前是双语入口，普通用户在首页提交后无法进入研究或账户流程。来源准入尚未取得，G0 保持 NOT_ISSUED。审核对象为 2026-11-18 的 `808b987`，保存 476 个 Git 文件与原始映射。 [详细验证和独立复核](15_FINAL_VERIFICATION_REPORT.md)

## 总体判断

- 文档已有权威产品基线、决策与 56 项 TASK、75 个 AT。多处旧版本导航被误当现行行为，本轮修正重要入口。路由行为与冻结协议仍有明确缺口。 [文档差异](02_DOCUMENT_GAP_MATRIX.md) · [需求追踪](03_REQUIREMENTS_TRACEABILITY.md)
- 产品需求已经覆盖六类客户及查价、证据、复核、集成与运营。网页主线无可用闭环。开发者通过本机 REST/MCP 和脚本能走部分主线，帐户、开发者自助与支付闭环缺真实交付证据。 [用户工作流](05_WORKFLOW_REVIEW.md) · [能力完整度](04_FEATURE_COMPLETENESS.md)
- 保留共享查询/统计与账本、Postgres 存储、自研独立 Collector、当前权利校验和明确的领取结算。瓶颈是来源及品质签收、可见体验、公共接口一致性以及恢复能力。重做入口路径、日期/筛选/取消契约接线和运营故障流程。 [架构和安全](09_ARCHITECTURE_SECURITY_REVIEW.md)

## 五类最大风险

| 风险 | 已有证据 | 整改出口 |
|---|---|---|
| 来源、价格、媒体 | 唯一候选无准入，45 字段均未实证，人工金标 0 | 获得逐用途权限、冻结语料、14 天授权稳定验证及独立分类盲测 |
| 查价与账户核心交付 | 首页提交和账户入口在英中均 404 | 空用户可见注册、查询、显式领取、证据核对及回访，覆盖状态、手机和双语 |
| 撤销后恢复 | 已测账户旧库，缺来源撤销和最新清单全链证据 | 来源/账户恢复演练同时验证旧 key、图、快照、分享、账本和 RPO/RTO |
| 实际收费 | 本机模拟及账本已测，商户/渠道/结算待真实审批 | Stripe 主、PayPal 补充按计划做授权沙盒及小额三方对账 |
| 单位经济与需求 | 17 项实测输入缺失，访谈 0 | 六类需求、试点付费依据、真实成本及满额用户毛利签收 |

P1 另包括日期精度漂移、属性名冲突、展示排序、历史认证、取消契约、发现接口、离线数据库目标、工单闭环、故障监督和晚到支付。每项有证据与关闭条件。 [P0–P3 整改登记](12_RISK_AND_ISSUE_REGISTER.md)

## 交付入口

| 范围 | 文档 |
|---|---|
| 项目盘点与功能 | [01 完整清单](01_DOCUMENT_INVENTORY.md) · [02 差异](02_DOCUMENT_GAP_MATRIX.md) · [03 追踪](03_REQUIREMENTS_TRACEABILITY.md) · [04 完整度](04_FEATURE_COMPLETENESS.md) |
| 产品、数据和集成 | [05 工作流](05_WORKFLOW_REVIEW.md) · [06 数据与价格](06_DATA_AND_PRICING_QUALITY.md) · [07 API/MCP/Skill](07_API_MCP_SKILL_REVIEW.md) · [08 逐页对照](08_UX_PAGE_BY_PAGE_AUDIT.md) |
| 工程与商业 | [09 架构安全](09_ARCHITECTURE_SECURITY_REVIEW.md) · [10 支付与成本](10_BILLING_AND_UNIT_ECONOMICS.md) · [11 E2E 验收](11_E2E_ACCEPTANCE_MATRIX.md) |
| 决策与执行 | [12 风险](12_RISK_AND_ISSUE_REGISTER.md) · [13 六阶段计划](13_OPTIMIZATION_ROADMAP.md) · [14 决策](14_DECISION_LOG.md) · [15 证据和复核](15_FINAL_VERIFICATION_REPORT.md) · [16 文档补齐](16_MISSING_DOCUMENTS_AND_REVISIONS.md) |
