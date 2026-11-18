# 06　成交证据、统计与数据质量

审计日 2026-11-18。代码基线 `808b987`。适用决策为 DEC-03/04/05/10/13、ADR-12 §2、ADR-13。一个查询可以给出可复算的合成样本价格；能否给 eBay US 某个型号报出可信成交价，仍取决于当前授权、真实字段、实际历史和按品类独立标注。

## 来源与字段级判定

唯一待准入市场是 eBay US。字段登记逐行见 [45 项来源能力](../step0/source-capabilities.csv)，所有 availability 均为 unverified；[权利登记](../step0/source-clearance.csv) 中唯一候选为 NOT_CLEARED、network_enabled=false，许可期间、频率、配额、留存、媒体凭证均空。以下同格字段共用相同判定或处理链。合成 HTML/JSON、独立 Python 金标和本机 HTTP 回放均不能证明平台字段实际可得。

| 字段（对应登记表） | 工程处理、缺失和风险 | 证据与上线验收 |
|---|---|---|
| listing_id、sale_event_id、event_identity_evidence、sold_status | listing/观察/售出事件分别保留，核实身份后按来源事件键去重；不明身份进入诊断，冲突隔离。重看一条 listing 不增销量。 | migrations/0005、0007；tests/collector-pipeline.test.mjs、collector-html.test.mjs。给同一 listing 的两次观察、两件真实成交、重上架分别盲标。 |
| sold_at、source_time_zone、sold_date_precision | 时刻按 UTC 开闭窗；日证据须有来源 IANA 时区且完整落窗，未知或跨界排除。暴露日期详见 D3。 | core/src/time.ts 的 localDay、inWindow；核对 DST 两天、缺时区、午夜边界、不同出口。 |
| sale_price_status、item_price、displayed_price、accepted_offer_evidence、sale_format | 必须核实成交事实及实际金额。固定价、拍卖、议价分别记录；单有展示价的 Best Offer 可展示诊断且不得入实际价。数量/折扣/多件成交的单件口径仍需源证据。 | core/src/pricing.ts 的 priceQualification；research.ts 的 diagnostics；原稿 §7.1。核对原始记录中的成交标记，拒绝“标价=接受价”的标注。 |
| currency | 对外 USD 整数分，原币保留；非 USD 缺可追溯 FX 凭证从统计排除。 | tests/query-billing.test.mjs 的 FX 用例。检查汇率日期、来源和确认的转换值。 |
| observed_shipping、shipping_status、shipping_evidence、shipping_destination、shipping_context | 默认商品价＋观测运费，运费未知不入默认价；item 口径允许未知运费。免费需证实并为 0；运费按获准目标上下文分组。税、目的地最终邮资和买家全部实付款无法由此推断。 | core/src/search-analysis.ts、tests/search-analysis.test.mjs；换目的地/免费/未知混合，不得跨组给单一运费。 |
| category、strong_attributes、item_specifics | 卡牌评级机构/等级/编号、球鞋尺码制、表款 reference、游戏区版、GPU 容量、收藏品变体都影响可比性。显式强筛选在冻结属性上精确匹配，证据缺失排除。泛词可包含不同型号；comparison_scope 有未知和混合警告。 | core/src/query.ts 的 applyStrongFilters；comparison-scope.ts；tests/core.test.mjs。按类目核对词典、完整性和误排/漏排。卡牌别名差异见 07 A1。 |
| condition、condition_id、condition_raw、condition_mapping_context、condition_description、description | 区分原始文本、标准枚举及映射上下文；Pre-Owned 本身不能确认 good。详情返回 present/missing/withheld，缺陷不从标题猜测。 | collector/src/html.ts、record-evidence.ts、query/src/research.ts；同名标签跨品类及描述缺失分别验。 |
| title、listing_url | 单条证据绑定访问权。链接须有真实原始依据；当前只允许合成 HTTPS 测试域名，缺失/撤销时显示相应状态。 | query/src/research.ts 的 listingLink、detail；tests/research.test.mjs。上线适配需验证目标域、原链接失效和替代证据入口。 |
| primary_image_candidate、primary_image_role、primary_image_evidence_binding、primary_image_dimensions、gallery_images | 首发取同 listing 主图。保存/处理/展示/分发逐项获权；图片链接为受控私有路径；每读校验 epoch/保留期，缺图不改事件、价格、收费。图库不自动纳入首发。 | media/src/primary.ts、query/src/index.ts 的 image；tests/media.test.mjs。撤权后旧链接拒读，复发前扫描存储与备份。 |
| seller_source_identity、seller_public_handle | 仅获许可聚合时返回识别/去重数量和未知数，当前 synthetic 标识有专门开关；无权不公布 handle。 | query/src/index.ts 的 seller_summary；step0/evidence/search-context-20261118/validation.json。测试两个相同卖家和两个未知卖家。 |
| next_cursor、sort_order、source_as_of、query_capture_context | 页面与 run/cursor/时钟绑定，已提交分片推进保守水位。作业失败不能抬升 freshness。采集排序、展示排序、查询语义 hash 分开。 | collector/src/worker.ts、refresh.ts、query/src/index.ts 的 submit；tests/collector-refresh.test.mjs。重复页、跳页、断页后重放检查分母。 |
| source_reported_match_count、source_reported_match_count_context、source_record_unit | 只接受绑定到本 run 首个提交页的数/单位/估计属性；无授权或缺项返回 null。例：fixture 首屏 42000、后续 999、核验价 10，coverage_ratio 仍 null。 | step0/evidence/search-context-20261118/validation.json；测试不同查询报告不得交叉引用。 |
| retention_until、field_visibility_permissions | 到期、撤销或隔离先拒读。聚合、逐条、公开缓存、分享、API、媒体分用途判权。历史结果、导出、缓存复用都须复核；客户已下载副本需另有合同与终止操作。 | query/src/index.ts 的 assertSnapshotRights、public-results.ts、research.ts。真实许可终止条件与下游处置 NOT VERIFIED。 |

表中简写 core、collector、query、media 均位于 `packages/`，migrations 位于 `packages/db/`。首发允许开放的实际类目仍须逐项签收；六个测试组体现设计和抽样范围。

## 从采集到交付的可复核链

1. preflightCollectorAccess 核对入口、授权状态、epoch、预算和访问上下文。冻结 profile 与来源作业关联。fixture worker 执行有界获取、重试及熔断。合法上游断流和来源权利撤销有不同处置。
2. 原始页/记录证据关联来源、观察、listing 与 event。分页进度、预算、重复页与冲突留痕。观察不明保留诊断。主图另行绑定、私有存放、独立重试。
3. submit 选匹配 collectionQueryHash 的已提交水位并冻结查询候选。collection hash 去掉 limit 和允许 stale；owner 复用的 query hash 包含两者。没有此查询的覆盖快照时返回 503。
4. worker 从同一事件/观察关联的证据应用强属性、价范围和成交方式。evaluateSnapshot 输出完整决定、价输入及候选 hash。先计算完整样本、再按 limit 输出。来源状态和权利在每次读取时复核。
5. 结果包含 as_of/data_as_of、各层版本、candidate_set_hash 和缺失/排除信息。完整获权输入支持用户本地剔除与调整导出；原统计、原账本及原 hash 保留。缺少逐条必要字段时完整输入/导出受限。

代码入口见 [查询领域服务](../packages/query/src/index.ts)、[解析与来源守卫](../packages/collector/src/access-guard.ts)、[逐条研究与导出](../packages/query/src/research.ts)。

## 黄金样本如何解释

| 用户看到的指标 | 分母、算法与失败条件 | 离线校验 |
|---|---|---|
| Observed → Comparable → Price-verified | 去重来源候选 → 通过身份、窗口、强属性与筛选 → 当前口径有可核验价。未知实际价/所需运费可保留诊断。 | 合成黄金 121 → 64 → 58，排除 6 个未核验价；展示 limit=50 仍用 58。 |
| Recent qualified samples | 同资格且落入 30 天窗的事件数。源报告匹配数、平台成交量、周转率无对应分母。 | 黄金 35，overall score 和市场覆盖比均 null。 |
| P25 / median / P75 | Type 7，用 BigInt 有理数插值、最终 half-up；n<8 三者 null，8–29 标有限，≥30 标足量。 | 4200 / 5800 / 7600 分。 |
| Trimmed mean / min / max | 各端去 floor(n/20) 后求均值；小样本中心为空，非空样本可给观测极值。IQR 只标记。 | 截尾均值 5930 分，范围 2900–10800 分。普通 mean 单列。 |
| 分布、分组与解释 | 核验价输入可复算经验分布；按 format、时段各自执行门槛。时期缺覆盖时 change_ratio=null。诊断给主排除原因；分位区间不表示预测范围。 | tests/search-analysis.test.mjs；tests/research.test.mjs；research-demo 历史回执 18 行、16 核验、2 展示价。 |
| 统计版本与用户调整 | 候选、时间、过滤、版本绑定 hash。调整结果标 user_modified，保留 original_stats；完整输入缺许可不得以展示子集声称完整重算。 | tests/research.test.mjs 的 58 条/limit5、独立调整和撤权。 |

复算入口为 [Python 独立核算](../step0/tools/verify_fixture.py)、[冻结结果](../docs/evidence/contracts-20261116/golden_fixture.log)、[阈值与并发集成](../tests/query-billing.test.mjs)。后者同时覆盖 0/7/8/29/30、100 并发领取与单点余额。数学对照通过只支持算法解释；同一份 synthetic 输入无法估计真实误匹配率。

## 断源、容量与整改

- fresh ≤24h；24h 后至 72h 仅显式 allow_stale 且免费；超 72h 当前查询拒绝。已交付记录可在保留期、权限允许时作历史读取，标出水位。权利撤销优先于上述所有时间。恢复先建立新水位、处理旧 lease 和去重，再恢复当前价。商业窗口需决策人签收。
- 历史测试在本机 16 GiB、Apple arm64、50 并发公开缓存分享共 150 次 HTTP 200，P95 31.09ms。它覆盖缓存分享；长尾未命中、私有结果的图片查权、异步工作和 PG 锁等待需要专门测量。见 [原始回执](../step0/evidence/outage-readiness-20261118/validation.json)。
- D1 **P0**　无真实访问/保存/统计/再分发/图片授权。创始人和授权方出具可复核的字段、用途、流量、留存、地域与终止条件；法律责任人核对，字段默认拒绝。验收包括模拟撤销后的 Web/API/MCP/分享/媒体拒读；取得必要许可后才开始线上样本验证。
- D2 **P0**　[标注规程](../step0/quality-plan.md) 记录人工金标为零，[G0 记录](../step0/verdict.md) 无获准连续 14 天的线上证据。先冻结六类每类 20 查询及 holdout；授权后按类目、头尾分层双人盲标并仲裁，报告 TP/FP/FN、Wilson 区间、身份、价误差和字段缺失。每日保留失败分母，对照原稿 §3.4 的总体/分类首次成功建议门槛 95%/90%、关键字段 99%；失败类目不得以六类平均签收。
- D3 **P1**　仅精确到本地日期的合格成交在 query/src/index.ts:466–478 写成该日 00:00Z；列表另带 day，详情保留原时区，calculation():760 只回 sold_at。下载完整计算输入并跨时区分桶的客户会将占位午夜当作已知成交时刻。数据/API 工程应从冻结 candidate 交付精度、原始日期和来源时区，增加兼容字段并标明旧行；按同一洛杉矶日及夏令时变更日验列表、详情、计算输入和导出，校验成交分桶、近期计数与原价不变。此处为静态代码确认，跨端回归尚缺。
- D4 **P2**　私有带图交付与新查询每行 SQL 成本未量化。query/src/index.ts:462–500 逐条写计算输入，:618–645 逐条读取图像视图；research.ts:61、:162 逐条写决定和先全取再内存分页。小团队先在目标机器对同一候选规模、1/50/200 display、带图/缺图、并发 owner 制作 query count、队列等待、PG CPU、p95、每成功交付成本曲线；达到 DEC-11 基线后再决定是否批量读取/写入。扩大类目前先计授权费、重试、文件、CPU、人工与失败/免费请求成本，真实成本目前为空。[未测成本输入](../step0/unit-economics/unmeasured.json)

## 公开来源材料复查

- 2026-11-18 查阅 eBay 用户协议及 API 许可。自动访问和相关商业用途须依适用协议取得许可。受限 API 的定价工具用途涉及明确书面同意，终止时需依实际适用协议执行销毁。逐用途商业依据依然待签。 [eBay 用户协议](https://www.ebay.com/help/policies/member-behavior-policies/user-agreement?id=5414) · [eBay API 许可](https://developer.ebay.com/support/api-license-agreement)
- 官方 Product Research 描述 Seller Hub 可查看最长三年并包括已接受的 Best Offer，普通已结束售出搜索范围较短。Marketplace Insights 是限量发布。这些是三种不同产品或访问入口。任何一个入口的历史窗、价格真实性与再分发权，均须以 SoldBench 实际获准入口单独确认。 [Product Research](https://www.ebay.com/help/selling/selling-tools/product-research?id=4853) · [eBay Buy API 概览](https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application)
