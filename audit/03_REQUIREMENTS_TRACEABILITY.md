# 需求到验收追踪

Approved 为 v1.4、DEC 与正式范围。Planned 是可追踪但缺实现或外部前置。Implemented 指活动代码。Verified 指本轮指定的离线验证，实地或商用证明单列。Proposed 仅用于审计建议，见路线图。关键证据见 [15 验证报告](15_FINAL_VERIFICATION_REPORT.md)，以下路径缩写按文件名/模块定位，`api/` 代表 `apps/api/src/`，领域包路径省略 `packages/` 与 `src/`。已执行的离线用例不升级正式 AT 状态。

## 业务目标到首发功能、接口和证据

| 需求与原稿 | Approved 目标 | 数据契约 | 页面 | TASK | 实现 | 离线对应测试 | AT | 审计判定 |
|---|---|---|---|---|---|---|---|---|
| F-01 网页快速查价 / v1.4 §9 | 规范化查询、属性/窗口/口径、200/202/空结果 | 查询账本 §2/3；SoldQuery/Result | PAGE-W01、PAGE-W02 | TASK-027、TASK-028、TASK-032 | query/index.ts、api/queries.ts | query-billing、api | AT-019、AT-020、AT-023 | 部分闭环；活动网页阻断 |
| F-02 核验价格 / §6–7 | 已核验价、未知价和税运费边界 | 搜索页契约；Comp/PriceBasis | PAGE-W02、PAGE-W05 | TASK-019、TASK-020、TASK-032 | core/pricing.ts、collector/record-evidence.ts | core、collector-html | AT-012、AT-013、AT-017 | 部分闭环；真实语义待验 |
| F-03 解释可信度 / §7 | 五维质量、低样本与覆盖状态 | 查询账本；QualityReport | PAGE-W02、PAGE-W07 | TASK-021、TASK-032 | query/quality-report.ts、core/statistics.ts | research、search-analysis | AT-015、AT-018 | 部分闭环；金标与界面待验 |
| F-04 人工剔除 / §7/12 | 明细、排除原因和本地重算 | 查询账本 §6；CalculationInputs/Export | PAGE-W02 | TASK-032 | query/research.ts、api/queries.ts | research、query-billing | AT-025 | 部分闭环；日期精度／本地 UI |
| F-05 访客回访 / §2/11–12 | 匿名 5/日、只查预缓存、可恢复未命中 | 公开结果；AnonSearch/AnonymousUsage | PAGE-W01 | TASK-031 | query/public-results.ts、api/public-results.ts | public-results | AT-034 | 部分闭环；可见入口缺 |
| F-06 首访账户 / §12 | 注册/验证/登录/找回/会话/删除请求 | ADR-14、账户访问与恢复；Session | PAGE-C01、PAGE-C02、PAGE-C03、PAGE-C07 | TASK-023、TASK-033、TASK-039 | auth/service.ts、api/auth.ts | auth-access、privacy | AT-031、AT-032、AT-046 | 部分闭环；可见账户/真实邮件缺 |
| F-07 信用与付款 / §11 | 免费/订阅/购买/promo 分桶、账本和支付 | ADR-12；WalletUsage/Checkout | PAGE-C04、PAGE-C05、PAGE-A03 | TASK-026、TASK-029、TASK-033 | billing/index.ts、billing/payment-lifecycle.ts | query-billing、payments | AT-028、AT-029、AT-030、AT-038 | 部分闭环；渠道、账单及价格决定 |
| F-08 集成安全 / §9/12 | key 创建一次展示、撤销/轮换、scope | 账户访问；KeyCreate/KeyView | PAGE-C06 | TASK-024、TASK-033 | auth/service.ts、api/auth.ts | auth-access、mcp | AT-033 | 部分闭环；可见密钥管理缺 |
| F-09 采集权利 / §3/5/8 | 来源准入、存档、权利追溯和清洗 | 采集实施/稳定性；Clearance/Observation | PAGE-A01、PAGE-A02 | TASK-013、TASK-014、TASK-015 | collector/store.ts、media/primary.ts | collector-pipeline、media | AT-001、AT-005、AT-009 | 待业务决策；实际许可缺 |
| F-10 历史可复取 / §9/12 | 自己已查询快照复取，标记历史 | ADR-12、查询账本；QueryHistory | PAGE-C08、PAGE-W02 | TASK-027、TASK-033、TASK-039 | query/index.ts、api/queries.ts | query-billing、research | AT-024、AT-044 | 存在冲突；登录路径与历史认证 |
| F-11 获客可信 / §12/16 | 10–20 个原创有权内容页 | SEO 页面卡；发布投影/留存 | PAGE-W07、PAGE-W08 | TASK-034 | web/index.tsx、api/public-results.ts | api、public-results | AT-043 | 缺少实施；内容无签收 |
| F-12 Agent 接入 / §9/10 | sold_search、sold_stats、文档和一致计量 | MCP 与开发者交付；tool/JSON-RPC | PAGE-W04 | TASK-037 | api/mcp.ts、developer/skills | mcp、developer | AT-045 | 部分闭环；宿主/引导实际验收缺 |
| F-13 任务恢复 / §9 | 任务轮询/取消/到期/重试恢复 | ADR-12；JobAccepted/JobResponse | PAGE-W02、PAGE-C08 | TASK-027、TASK-028 | query/index.ts、scripts/query-worker.mjs | query-billing、readiness | AT-026、AT-027 | 存在冲突；取消响应/重试 |
| F-14 自研供数 / §3/5 | 自研 Fetcher/Parser/队列/预算/部署 | 采集实施；分页/租约/run/watermark | PAGE-A01、PAGE-A02 | TASK-014、TASK-016、TASK-017 | collector/worker.ts、collector/http-transport.ts | collector-http、collector-isolation | AT-002、AT-003、AT-004 | 部分闭环；真实入口不可用 |
| F-15 断源降级 / §13 | 断源 fresh/stale/expired/forbidden | ADR-12；Freshness/Unavailable | PAGE-W06、PAGE-A01 | TASK-027、TASK-035、TASK-040 | core/availability.ts、query/index.ts | readiness、public-results | AT-021、AT-022、AT-048 | 部分闭环；完整 Web/生产演练 |
| F-16 成本/安全止损 / §3/16 | 自研成本与维护工时、熔断安全 | DEC-07/11；预算/日水位/运营审计 | PAGE-A02、PAGE-A04 | TASK-008、TASK-016、TASK-041 | collector/store.ts、step0/unit-economics | collector-budget、step0 | AT-007、AT-008、AT-049 | 待业务决策；实测成本缺 |

## 竞品范围与后续包

| 能力 | 目标 | 排期 | 验收 | 审计状态 |
|---|---|---|---|---|
| CP-01 | 六类客户完整路径，Web查价研究与API集成同等交付；逐类流程和证据 | V1；TASK-008、TASK-032、TASK-042 | AT-035、AT-058 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-02 | 自研稳定采集、合法准入、持续观察、成本、停止/恢复和主图权利 | V1；TASK-001、TASK-007、TASK-013、TASK-014、TASK-016、TASK-018、TASK-041 | AT-001、AT-003、AT-004、AT-006、AT-049、AT-056 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-03 | 精准强属性匹配、泛词/混型号提示、规则版本、原始/可比/核验分母 | V1；TASK-019、TASK-021、TASK-032 | AT-011、AT-018、AT-058、AT-074、AT-075 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-04 | 实际成交价/未知Best Offer状态；后续补价独立证据链 | V1状态，V1.1后查；TASK-020、TASK-032、TASK-047 | AT-012、AT-064、AT-074、AT-075 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-05 | 中位/分位/截尾、分布、纳排理由、完整输入与用户剔除重算 | V1；TASK-020、TASK-028、TASK-032 | AT-014、AT-015、AT-025、AT-074、AT-075 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-06 | 对应商品主图采集、规范副本存储/读取、撤销/缺图状态与占位 | V1；TASK-012、TASK-014、TASK-015、TASK-028、TASK-032 | AT-005、AT-056、AT-074、AT-075 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-07 | 完整成交详情：可获准属性/成色/说明/证据/多图按字段权利呈现 | V1；TASK-015、TASK-028、TASK-032 | AT-056、AT-059、AT-074、AT-075 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-08 | 有界分页/快照完整性/截断说明；不按返回条数收费、不用limit算统计 | V1；TASK-014、TASK-027、TASK-028 | AT-004、AT-014、AT-023、AT-026、AT-074、AT-075 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-09 | 单查询JSON/CSV导出；批量多查询/CSV上传独立异步工作台 | V1单结果、V1.1批量；TASK-028、TASK-032、TASK-045 | AT-059、AT-062、AT-074、AT-075 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-10 | 连续合法档案、历史查询/曲线、实际窗口/日期精度/缺图说明 | V1存储预留，V1.1历史产品；TASK-015、TASK-046 | AT-005、AT-063 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-11 | Overview/Search/Research/Subscription/Account/Support，空账户及失败恢复 | V1；TASK-032、TASK-033、TASK-034、TASK-035 | AT-031、AT-035、AT-036、AT-058 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-12 | key一次显示/撤销、会话、用户TOTP恢复码；Passkey后续 | V1；TASK-023、TASK-024；V1.1 TASK-044 | AT-032、AT-033、AT-060、AT-061 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-13 | Usage/Logs/额度桶/错误码/请求ID/charge/ledger关联，支持对账 | V1；TASK-025、TASK-026、TASK-033、TASK-035 | AT-029、AT-030、AT-036、AT-058 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-14 | 完整REST、参数/错误/重试、可运行Python/TS/curl示例 | V1；TASK-028、TASK-037 | AT-019、AT-020、AT-050、AT-057 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-15 | Playground参数→运行→响应/Headers/代码/异步claim/费用，安全代理 | V1；TASK-028、TASK-037 | AT-050、AT-057 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-16 | Hosted MCP、可安装Skill/索引/参考/llms全量、两客户端；OAuth在后包 | V1；TASK-037；V1.1 TASK-044 | AT-045、AT-057、AT-061 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-17 | 双语可搜索文档/状态页/changelog/版本与弃用；同一契约产出 | V1；TASK-034、TASK-035、TASK-037、TASK-042 | AT-048、AT-050、AT-055、AT-057 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-18 | Stripe主支付/PayPal补充、退款/账务、实测成本定价和真实收付资格 | V1；TASK-008、TASK-029、TASK-041、TASK-043 | AT-007、AT-037、AT-038、AT-049、AT-054 | Approved；实现和证据按 F 与 AT 查，商用待验 |
| CP-19 | eBay其他国家站点及本地语言/币种/日期税运模型，不混算 | V1.5 UK/DE TASK-049；V2其他5站 TASK-055 | AT-066、AT-072 | Planned；专项先决条件见台账 |
| CP-20 | 图片/条码→识别→用户确认→查价，上传安全及失败费用 | V1.5；TASK-050 | AT-067 | Planned；专项先决条件见台账 |
| CP-21 | 收藏/条件提醒/签名Webhook；库存估值和重复研究工作流 | V1.5；TASK-048、TASK-051 | AT-065、AT-068 | Planned；专项先决条件见台账 |
| CP-22 | 第二平台，区分已售与在售；每个平台逐源权限及质量验收 | V2；TASK-052 | AT-069 | Planned；专项先决条件见台账 |
| CP-23 | 卡牌/评级与拍卖专用语义，分别建产品身份和含佣口径 | V2；TASK-053、TASK-054 | AT-070、AT-071 | Planned；专项先决条件见台账 |
| CP-24 | 运费估算与RapidAPI渠道：决策包、采用后再冻结独立实施预算 | 专项；TASK-056 | AT-073 | Planned；专项先决条件见台账 |

## 全部任务与验收索引

台账状态为基线快照，后续以原表为准。

| TASK | 原映射 | 依赖 | AT | 台账状态 |
|---|---|---|---|---|
| TASK-001 / E1–E3 | 0 / T-0.1/T-0.6/T-0.8/T-0.10 | — | AT-001、AT-074 | 阻塞 |
| TASK-002 / E4–E6 | 0 / 规格§0/§9 | TASK-001 | AT-023、AT-026、AT-050 | 待前置 |
| TASK-003 / E7–E10 | 0 / T-0.3 | — | AT-001、AT-003、AT-009 | 待复核 |
| TASK-004 / E11–E13 | 0 / T-0.2/§3.2 | — | AT-006、AT-018 | 待复核 |
| TASK-005 / E14–E15 | 0 / 附录D/§7.3 | TASK-003 | AT-012、AT-013、AT-014、AT-015、AT-017 | 待复核 |
| TASK-006 / E16–E17 | 0 / T-0.13 | TASK-003, TASK-005 | AT-008、AT-021 | 待复核 |
| TASK-007 / E18–E22 | 0 / T-0.3/§3.3 | TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006 | AT-003、AT-004、AT-006 | 待前置 |
| TASK-008 / E23–E26 | 0 / T-0.11/T-0.14 | TASK-004, TASK-007 | AT-007、AT-049 | 待前置 |
| TASK-009 / E27–E27 | 0 / T-0.12 | TASK-006, TASK-007 | AT-002、AT-053 | 待前置 |
| TASK-010 / E28–E28 | 0 / §3.4/T-0全体 | TASK-001, TASK-002, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009 | AT-006、AT-007、AT-008、AT-053 | 待前置 |
| TASK-011 / E29–E34 | 1 / S-01 | TASK-010 | AT-039、AT-050、AT-055、AT-056 | 进行中 |
| TASK-012 / E35–E39 | 1 / S-03 | TASK-011, TASK-002 | AT-039、AT-056、AT-074 | 进行中 |
| TASK-013 / E40–E44 | 1 / S-02 | TASK-012, TASK-001 | AT-001、AT-005、AT-056 | 进行中 |
| TASK-014 / E45–E52 | 1 / S-04 | TASK-013, TASK-003, TASK-004 | AT-003、AT-004、AT-009、AT-010、AT-056、AT-074 | 进行中 |
| TASK-015 / E53–E57 | 1 / S-05部分 | TASK-012, TASK-013, TASK-014 | AT-005、AT-040、AT-056、AT-074 | 进行中 |
| TASK-016 / E58–E62 | 1 / S-05其余/S-24 | TASK-014, TASK-015 | AT-003、AT-004、AT-052 | 进行中 |
| TASK-017 / E63–E65 | 1 / S-23 | TASK-011, TASK-016 | AT-002、AT-042 | 待前置 |
| TASK-018 / E66–E67 | 1 / 阶段1出口 | TASK-012, TASK-013, TASK-014, TASK-015, TASK-016, TASK-017 | AT-001、AT-002、AT-003、AT-004、AT-005、AT-039 | 待前置 |
| TASK-019 / E68–E74 | 2 / S-06/S-07 | TASK-018, TASK-004 | AT-011、AT-016、AT-017、AT-074 | 进行中 |
| TASK-020 / E75–E80 | 2 / S-08 | TASK-019, TASK-005 | AT-012、AT-013、AT-014、AT-015、AT-017、AT-075 | 进行中 |
| TASK-021 / E81–E86 | 2 / S-09 | TASK-019, TASK-020, TASK-004 | AT-018、AT-058 | 待前置 |
| TASK-022 / E87–E87 | 2 / 阶段2出口 | TASK-019, TASK-020, TASK-021 | AT-014、AT-018、AT-053 | 待前置 |
| TASK-023 / E88–E95 | 3 / S-10 | TASK-022, TASK-012 | AT-031、AT-032、AT-055、AT-060 | 进行中 |
| TASK-024 / E96–E97 | 3 / S-11 | TASK-023 | AT-033 | 进行中 |
| TASK-025 / E98–E100 | 3 / S-14账户部分 | TASK-023, TASK-024, TASK-012 | AT-024、AT-036、AT-050 | 进行中 |
| TASK-026 / E101–E105 | 3 / S-12 | TASK-025, TASK-020, TASK-002 | AT-028、AT-029、AT-030、AT-040 | 进行中 |
| TASK-027 / E106–E111 | 3 / S-13/S-25 | TASK-026, TASK-024, TASK-016, TASK-020 | AT-021、AT-022、AT-023、AT-026、AT-027、AT-040 | 进行中 |
| TASK-028 / E112–E119 | 3 / S-14查询部分 | TASK-027, TASK-025 | AT-019、AT-020、AT-024、AT-050、AT-056、AT-057、AT-059、AT-075 | 进行中 |
| TASK-029 / E120–E129 | 3 / S-15 | TASK-026, TASK-025, TASK-001 | AT-037、AT-038 | 进行中 |
| TASK-030 / E130–E131 | 3 / 阶段3出口 | TASK-023, TASK-024, TASK-025, TASK-026, TASK-027, TASK-028, TASK-029 | AT-024、AT-029、AT-037、AT-040、AT-053 | 待前置 |
| TASK-031 / E132–E134 | 4 / S-16 | TASK-030 | AT-034、AT-055 | 进行中 |
| TASK-032 / E135–E147 | 4 / S-17 | TASK-031, TASK-028 | AT-025、AT-035、AT-055、AT-056、AT-074、AT-075 | 待前置 |
| TASK-033 / E148–E155 | 4 / S-18/F-06页面 | TASK-032, TASK-025, TASK-029 | AT-031、AT-032、AT-033、AT-036、AT-037、AT-055、AT-060 | 待前置 |
| TASK-034 / E156–E160 | 4 / S-19 | TASK-032, TASK-021 | AT-043、AT-051、AT-055 | 进行中 |
| TASK-035 / E161–E164 | 4 / S-22运营部分/S-25状态页 | TASK-033, TASK-016, TASK-026 | AT-048、AT-052 | 进行中 |
| TASK-036 / E165–E168 | 4 / S-20 | TASK-034, TASK-035, TASK-032 | AT-035、AT-044、AT-053、AT-055 | 进行中 |
| TASK-037 / E169–E178 | 5 / S-21 | TASK-036, TASK-028 | AT-045、AT-050、AT-055、AT-056、AT-057、AT-075 | 进行中 |
| TASK-038 / E179–E181 | 5 / S-22性能部分 | TASK-037, TASK-027 | AT-041、AT-042 | 进行中 |
| TASK-039 / E182–E184 | 5 / S-22隐私恢复部分 | TASK-038, TASK-015, TASK-023, TASK-036 | AT-005、AT-046、AT-047 | 进行中 |
| TASK-040 / E185–E187 | 5 / S-26 | TASK-039, TASK-035 | AT-021、AT-022、AT-048 | 进行中 |
| TASK-041 / E188–E189 | 5 / S-27 | TASK-040, TASK-008 | AT-049 | 待前置 |
| TASK-042 / E190–E200 | 5 / S-22总验收 | TASK-037, TASK-038, TASK-039, TASK-040, TASK-041, TASK-021 | AT-035、AT-047、AT-048、AT-053、AT-055、AT-058、AT-059、AT-060、AT-074、AT-075 | 待前置 |
| TASK-043 / E201–E203 | 5 / 收费发布门 | TASK-042, TASK-029, TASK-010 | AT-054 | 待前置 |
| TASK-044 / E204–E211 | 扩展 / V1.1 | TASK-023, TASK-024, TASK-037 | AT-061 | 待前置 |
| TASK-045 / E212–E221 | 扩展 / V1.1 | TASK-026, TASK-027, TASK-032, TASK-033 | AT-062 | 待前置 |
| TASK-046 / E222–E231 | 扩展 / V1.1 | TASK-015, TASK-020, TASK-028, TASK-039 | AT-063 | 待前置 |
| TASK-047 / E232–E236 | 扩展 / V1.1 | TASK-014, TASK-019, TASK-020, TASK-027 | AT-064 | 待前置 |
| TASK-048 / E237–E243 | 扩展 / V1.5 | TASK-023, TASK-026, TASK-027, TASK-045 | AT-065 | 待前置 |
| TASK-049 / E244–E255 | 扩展 / V1.5 | TASK-018, TASK-022, TASK-042, TASK-046 | AT-066 | 待前置 |
| TASK-050 / E256–E263 | 扩展 / V1.5 | TASK-028, TASK-032, TASK-039 | AT-067 | 待前置 |
| TASK-051 / E264–E271 | 扩展 / V1.5 | TASK-045, TASK-046 | AT-068 | 待前置 |
| TASK-052 / E272–E279 | 扩展 / V2 | TASK-001, TASK-021, TASK-041, TASK-049 | AT-069 | 待前置 |
| TASK-053 / E280–E289 | 扩展 / V2 | TASK-019, TASK-021, TASK-052 | AT-070 | 待前置 |
| TASK-054 / E290–E299 | 扩展 / V2 | TASK-020, TASK-021, TASK-052 | AT-071 | 待前置 |
| TASK-055 / E300–E314 | 扩展 / V2 | TASK-049 | AT-072 | 待前置 |
| TASK-056 / E315–E319 | 扩展 / 专项决策 | TASK-008, TASK-029, TASK-041 | AT-073 | 待前置 |
