# SoldBench 开发规格书 v1.4

> 2026-11-16实施勘误：本文件保留v1.4产品范围，异步交付/时间/身份/额度的可执行规则以 [ADR-12](docs/adr/ADR-12.md) 及 [OpenAPI](docs/openapi.yaml) 为准。eBay获取先执行 [采集稳定性专项规格](docs/采集稳定性专项规格.md)。用户已确认目前无来源许可，先完成离线开发与准入准备；这不是G0/生产批准。[原始未修改交付副本](docs/baselines/SoldBench-v1.4-original.md)。

Nov 15, 2026 · 基于 v1.3 修订（自建采集与业务连续性执行版）

**文件定位**：这是 **SoldBench** 的独立执行基线。正式产品品牌 `SoldBench`；项目仓库/代码代号 `soldbench`；拟采用主域名 `soldbench.com`（2026-11-16用户已确认注册；DNS/TLS与上线尚未验证）。产品形态为网页成交研究工具 + REST API + MCP，保留 v1.3 全部数据、统计、支付和质量设计，并将**自主开发、自行部署、自主维护的数据采集系统**提升为生产 P0 硬要求。**任何第三方 scraping Actor、代抓取 SaaS 或按结果付费的数据抓取 API 均不得成为 V1 的在线服务依赖或故障自动接管通道。**

**关键现实约束**：自建程序解决对第三方采集服务的依赖，并**不消除对 eBay 上游访问权限的依赖**。eBay 当前用户协议限制未经明确许可的自动化采集及信息商业化；先确定合法且可持续的数据获取与再分发路径，再做网络采集验证。未通过此门只允许对有权持有的离线样本构建采集/解析框架，不得通过规避登录墙、验证码、封禁等方式替代许可。**网站不中断**指采集故障期间网页/API/账单仍可运行，并对**有权继续保留与展示**的历史数据实施诚实降级；不承诺持续提供新的实时成交价。

### v1.3 → v1.4 本轮变更（保留 v1.3 的全部统计、计费与质量修订）

| 修订主题 | v1.4 结果 |
| --- | --- |
| 品牌与命名 | 产品、仓库、环境和文档统一 SoldBench / `soldbench`；`soldbench.com` 用户已确认注册，实际DNS/TLS与部署验证后启用 |
| 核心采集能力 | 原自定义来源适配器升级为自研、自部署 Collector；生产禁止 Apify Actor 等第三方代抓取服务 |
| 断源不宕站 | API/Web 从本地 Postgres + 缓存及有权保留的快照读数；上游停止后分级返回 fresh/stale/unavailable |
| 合规先决条件 | 不再将“14 天技术成功”视为允许采集/转售；增加逐来源许可与商业再分发门 |
| 产品竞争力 | 从泛化更多数据转向“可比商品精准匹配 + 可信实际价 + 可解释结果” |
| 样本与市场 | `n_observed` / `n_comparable` / `n_price_verified`，不再用样本数量代表市场销量 |
| 价格可信度 | 未证实 Best Offer 实际价不纳入默认中位数，运费未知不得按 0 补足 |
| 质量报告 | V1 输出五维诊断，未经校准的单一质量分先为 null |
| 数据库 | listing、sale event、observation 与 query match 拆分；PG16 V1 取消月度分区 |
| 计量与余额 | 1 次有效标准查询=1 credit，至多返回 200 条；月额与按量包分余额桶 |
| 异步与幂等 | 新增 202/jobs 状态、查询去重、失败免扣与强租户隔离 |
| 成本与市场验证 | 加入重度用户毛利压力、用户访谈/付费意愿门、来源许可费用 |
| SEO 和开发清单 | 先 10–20 个原创有价值页面，重排 Story、测试和阶段门 |

### v1.4 技术决策（不可解释成可选项）

1. **品牌**：`SoldBench` / 代码 `soldbench`；域名 `soldbench.com` 用户已确认注册，DNS/TLS及部署验证后才能启用。
2. **生产采集**：自研 Collector、独立部署、自有源码和质量测试；**0 个第三方抓取 Actor、代抓取 API 作为生产依赖**。
3. **访问权限**：明确的自动采集与数据商业使用前提，未满足则 `COLLECTOR_ENABLED=false`；不得以绕过限制代替获取许可。
4. **高可用边界**：上游数据停止时网站继续运行，但真实数据仍会逐渐陈旧；只使用有权继续提供的历史快照，过期当前价/禁止数据不提供、也不收费。
5. **交付标准**：第 0 步自建采集 14 天线上合法验证 + 独立性审计 + 0/24/48/72h 断源 E2E 必须通过，才能开发收费产品。

---

## 0. 执行规则（agent 必读）

2026-11-16用户授权更新：按 [ADR-13](docs/adr/ADR-13.md) 先完成整个产品的离线工程，apps/packages、账户、网页、API/MCP和支付沙盒代码可开发，真实数据/收款/上线保留原门禁。下述G0前编码限制及阶段编码顺序由该授权覆盖，真实验收要求继续执行。商品主图纳入必备采集与展示能力，随图片权利和留存期限管理。

> **文档状态：v1.4 / 2026-11-15。** 本文是单一产品执行基线，不是法律授权文件。原 v1.2 的具体市场价格、来源准入及成本数字属于待核验的历史快照或假设；任何“已验证”的措辞均须有独立证据和日期。v1.4 优先消除统计、计费、数据模型及阶段门冲突。

1. **自研采集是核心要求，合法访问是前提**：生产必须使用 SoldBench 自主编写并自行部署的 Collector。禁止把 Apify Actor、第三方代抓取 API、第三方爬虫 SaaS 当作在线依赖/容灾替代。先完成 T-0.6 平台条款及商业再分发评估、T-0.10 来源准入；未取得明确允许的自动化访问及商业化依据前，只能用获准离线样本开发解析器，不得对 eBay 进行未经许可的网络自动采集。
2. **先验证后开发**：第 3 章第 0 步取得 `GO` 前，仅可在 `step0/` 开发独立的自研采集 PoC（网络测试限许可范围）、离线 fixture 解析器、数据质量/缓存故障模拟及访谈；禁止注册、支付、正式前端产品代码。第 0 步必须交付可复现的自研 Collector 验证证据，不能用第三方 Actor 成绩替代。`CONDITIONAL_GO` 不解锁阶段 1。
3. **顺序与门禁**：第 0 步 → 阶段 1 → 2 → 3 → 4 → 5（第 14 章）。阶段允许准备性文档重叠，但未通过前一阶段门不得上线或把未完成能力作为可售权益。
4. **规格空白**：先查附录 E，已登记按默认建议执行并在 `docs/progress.md` 标注；新增决策先登记。不允许用自动生成代码替代关键商业/法务决策。
5. **口径变更**：统计、匹配、清洗、计量、金额、数据权利等口径变更，必须同 PR 修改本规范、`docs/openapi.yaml`、回归样本和对应版本；使用 `engine_version`、`cleaner_version`、`parser_version` 以及 `billing_policy_version`。
6. **凭证与隐私**：密钥、会话、供应商凭证走密钥管理；禁止进仓库、镜像、日志和测试快照。禁止使用未经授权的生产个人数据做本地测试；账号与用户删除遵守数据保留/删除规则。
7. **命名**：产品正式工作品牌统一 **SoldBench**，仓库/包/容器/服务/日志前缀为 `soldbench`，前端展示为 `SoldBench`；不得出现旧代号。拟主域名 `soldbench.com`；**创始人确认注册并控制 DNS 前**，生产基地址保持环境变量，不能默认为该域名已属于项目。不得暗示 eBay 合作或官方授权。
8. **对外透明**：数据来源与方法页面应如实披露来源性质、非官方关系、价格及覆盖局限；不得隐瞒法律上应披露的重要事实。运行凭证、供应商商业秘密、访问安全细节不在公众页面披露。
9. **定义完成**：单测、类型检查、lint、契约及迁移测试通过；价格与计费变更必须带对账、并发、幂等与回归证据；每个 Story 在 `docs/progress.md` 写入编号、commit、验收证据、风险状态。
10. **冲突裁决**：以本版第 3 章（合规和验证门）、第 7 章（统计）、第 8 章（模式）、第 9 章（请求契约）、第 11 章（资金与额度）为唯一口径；各表与示例不符时禁止静默选边，须建 ADR 并修改文档。

11. **单一可维护的自建采集路径**：生产禁用 `THIRD_PARTY_SCRAPE_FALLBACK` 类开关；不准因自研采集失败而临时直接接入按结果付费代抓取服务。第三方服务只限必要的通用基础设施（主机、DNS、存储、网络传输），不能掌控数据抓取业务逻辑；每个依赖另做可迁移方案。
12. **断源服务必须可用但不能造假**：采集 Worker 故障不应让 Web/API、登录、API Key、账单、历史结果、方法页与状态页失败；仅允许展示符合留存与再分发权利的快照，并按第 9/13 章明确数据新鲜度、收费与停用边界。

| 全局口径 | v1.4 定义 |
| --- | --- |
| 货币 | 账务和 API 金额统一 USD 整数分；源币及换算证据单独保存，禁止以 float 存钱 |
| 价格 | `item` 与 `item_plus_observed_shipping` 两种；后者不等于含税、覆盖所有目的地的最终到手价 |
| 价格可信度 | 可核验实际成交价与仅显示标价必须分离；后者不进入默认中位价 |
| 时间 | UTC 存储，来源当地日期与时区、原始文本留痕；不能确认成交时间时不得伪造精度 |
| 成交总量 | `sample_count` 是观测样本量，不能直接称为市场成交量或卖出件数 |
| 计费 | V1 `1 credit = 1 次成功的标准查询`，最多返回 200 条；缓存命中与未命中同价；异步排队和失败不收费 |
| 质量 | 匹配、价格可信度、样本量、覆盖度等分项透明；未经过校准的启发式分数不宣传为统计置信度 |
| 证据 | 竞争数据、成功率、价目与成本须标注抓取日期、原始出处、是否实测/估算/目标 |
| 权利与合规 | 获得相应明确访问许可与商业保存、统计、再分发依据才允许自建 Collector 联网采集、收费 |
| 采集自主性 | 采集调度/请求/解析/去重/数据存档/质量监控由 SoldBench 自研并自托管；第三方抓取服务为生产禁用 |
| 故障连续性 | 断源时 Web/API 继续处理账户与缓存/存档查询；新数据不可用则返回明确降级/503，不假装数据实时 |

> 2026-11-17身份实现澄清：认证/安全命令重试按 [ADR-14](docs/adr/ADR-14.md)，账户与MFA实施按 [账户访问契约](docs/账户与访问实施契约.md)。查询、支付和额度幂等规则不变。

## 1. 产品定义

**定位**：SoldBench 提供可追溯的可比商品成交记录（comps）及可靠的价格统计，服务个人卖家、收藏品交易商、二手商家、开发者、SaaS 企业和专业数据使用者，帮助他们研究成交、判断价格区间并减少**型号/规格/版本/成色错配**。首发只使用**自研、自托管且满足访问与再分发条件**的数据采集系统获取可用来源的数据；不是官方 eBay 数据接口，不承诺完整覆盖。

| 项 | v1.4 决策 |
| --- | --- |
| 产品形态 | 网页成交研究与查价 + REST API 集成 + MCP；网页是可直接使用的产品入口，三者共用查询、匹配、统计、计费引擎 |
| 首发市场 | 目标 eBay 美国已售市场；**能否取得自建自动采集的明确访问许可与商业再分发条件，是第 0 步硬门槛** |
| 首发楔子 | 默认带评级卡牌，最终按第 3 章盲测及客户验证选一个。首发公开质量承诺仅覆盖通过验收的细分类目；其他五组作为候选验证，不默认为同等成熟 |
| 总体类目 | 卡牌、球鞋、手表、电子游戏、GPU/电脑硬件、收藏杂项（第 0 步均测）；按类目质量门逐步开放 |
| 用户 | 个人卖家、收藏品交易商、二手商家、开发者、SaaS 企业、专业数据使用者；按工作流验证需求，不预设开发者优先或把网页用户只当作API获客流量 |
| 商业主体 | 单人或极小团队、全远程、中国个人开发者收款，持护照/香港银行卡/Wise；Stripe主支付、PayPal补充；Creem/Dodo核验备用资格，实际收付待真实账户/产品审批 |
| 获客 | 高质量免费工具、开发者文档、针对楔子类目的原创指南与 SEO；社区验证为辅，不以页数为成功标准 |
| 竞争排序 | ① 自研采集与可持续数据供给 ② 可比匹配质量 ③ 已核验成交价/证据 ④ 断源持续服务与稳定契约 ⑤ 网页研究体验与开发者集成 ⑥ MCP/SEO ⑦ 多市场扩展 |

**竞争与需求认识**：v1.2 记录的 SoldComps、CompSniper、Soldgraph、Terapeak/130point、Apify 等为需持续验证的市场参考，不能把对手营销声称当作独立测试事实。尤其“更长历史”“更多市场”“MCP”并非自然形成独特优势。详细逐项基准见附录 A。

**明确的付费理由**：相比用户逐条人工核对搜索结果，SoldBench 通过网页、API 和 MCP 提供版本/评级匹配、对不可核实价格单独分层、样本及覆盖解释、来源可追溯、稳定接口与合理费用。只有在盲测和真实用户试用中得到证据才可对外宣称“更准确”。

**不卖**：转售竞争者禁止转售的数据；未经允许的私人/受限信息；无证据的“全部真实成交”“官方授权”“真实 Best Offer 价格”承诺；自动进货决策和保证盈利的推荐。历史档案只能来自有权保存的记录，存档本身不代表市场完整性。

**验证要点**：至少访谈 10–15 名潜在目标用户，覆盖上述六类客户，分别记录网页研究、程序集成与专业数据需求；共享工具用户和SaaS终端用户不重复计为独立客户。并取得 ≥3 份能证明愿意付费的试点承诺或实际付费试用（建议门槛，非行业统计事实）；若未达到，停止全量产品开发并回访调整定位（第 3 章）。

## 2. 范围与功能清单

> Search截图专项补充：[搜索页字段与统计契约](docs/搜索页采集字段与统计契约.md)规定完整标题/链接/主图/成色/获准seller及源上下文、价格和成交方式过滤、展示排序、普通均价/运费/时间桶/分组统计的首发要求，沿用未知Best Offer排除和每组每桶n<8中心null。新增AT-074/075与7人日已计入台账；当前OpenAPI/实现未全部支持，不作已完成功能。

> 2026-11-16范围及排期补充（DEC-13）：用户要求竞品差距在开发前进入计划，执行[竞品能力实施规格与路线图](docs/竞品能力实施规格与路线图.md)与[修订任务台账](docs/开发排期与任务台账.md)。V1增加完整成交详情/单结果JSON或CSV导出、用户TOTP恢复码、请求日志及完整开发者交付/六类客户验收。单结果导出不等于完整CSV批量工具；批量/历史/OAuth/站点/平台等进入明确后续工作包，不再仅列候选。本文旧18周/156人日估算以新台账替代；原始归档不变。


**V1（仅已通过合法来源、匹配质量和成本门的类目发布）**：

| 模块 | 内容与边界 |
| --- | --- |
| 数据来源 | 目标 eBay US 已售记录；**只能由 SoldBench 自建 Collector 在获得相应许可后采集/入库**，未经允许不得联网采集或对外提供 |
| 查询 | 关键词 + 类目、成色、品牌、型号/版本/规格过滤；最多返回 200 条 comp；异步任务可查询状态 |
| 统计 | 已核验价格样本中位数、p25/p75、截尾均值、观测样本数与最近 30 天**样本**成交数；匹配与数据质量分项、覆盖状态 |
| 记录及证据 | 样本明细、已核验成交价状态、剔除原因、来源时间、可共享的脱敏只读结果；支持剔除后本地即时重算 |
| 账户与计费 | 邮箱注册、免费/Starter/Pro 候选套餐、API keys、余额桶、幂等账本、支付通道准入 |
| API | `/v1/sold` + `/v1/jobs/{id}` + 查询复取 + `/v1/usage`、分类和密钥；OpenAPI 3.1 |
| 前端 | 首页真实可用免费查价、结果页、开发者文档、定价、账户管理、首批 10–20 个经质量验证的真实内容页 |
| AI 分发 | 两个 MCP 工具、llms.txt、SKILL.md，与 REST 共用权限/限额；不夸大 AI 输出可信度 |
| 批量能力 | 可选 P0.5：小批量异步 API（无 CSV/UI），仅在第 0 步客户测试证明需要且单位成本可控时提升到首发 |

**V1 不做**：第二市场、完整 CSV 批量工具、图片查价、移动 App、团队多席位、SSO、复杂预测/库存决策、历史完整性未验证的价格趋势承诺、未经授权的跨市场聚合。

**上线标准（全部满足才允许收费）**：

1. 第 0 步出具 `GO` 且来源权利链、商业再分发、平台条款及支付产品准入在允许范围内；尚无足够权利时即便抓取成功也为 `NO-GO`。
2. **每个对外开放细分类目**满足附录 D 的精度、召回、价格误差、价格核验、覆盖披露测试；不得用六组平均值掩盖局部失败。原 v1.2 的错配率 ≤8%、中位价偏差 ≤6% 保留为目标，但必须同时报告样本量、区间及 Recall。
3. 缓存命中 P95 ≤800ms；允许的实时查询 P95 ≤15s，超过进入 202 异步任务；**完全断开 Collector 后 Web/API 仍可独立处理合法留存的历史/缓存查询和全部账户管理**；缓存数据新鲜度必须在元数据明示。
4. 注册、key、配额与支付从沙盒到真实小额生产交易全链路验收；退款、订阅失效、并发余额、webhook 重放和支付对账无差异。
5. 采集、统计、查询与支付监控就绪；**不依赖 Apify/第三方抓取服务**；采集故障时只从有权持有的 Postgres/Redis/对象存储快照提供明确过期标记，断源测试通过。
6. 有数据来源与方法说明、投诉/下架处理、用户数据删除及平台通知响应 SOP；每一份数据有来源、准入决定和保留策略。
7. 定价政策与单位经济复核通过；对满额使用或高负载客户的成本不会因配额模型失控。
8. 用户访谈与付费需求验证通过；未通过不得单凭技术成功全面开发。

**P0 功能及验收**：

| 编号 | 功能 | 验收 |
| --- | --- | --- |
| F-01 | 单次精准查询 | 参数校验、筛选及样本明细正确，空结果返回明确空状态而非 500 |
| F-02 | 价格口径与质量说明 | `price_status` 分层；未经核验 Best Offer 仅做附注，不进入默认实际成交价统计 |
| F-03 | 质量与不足状态 | 匹配、价可信度、样本量、覆盖和时间五分项；有效已核验价格样本 <8 时不给价格中心值和置信评分，只给不足原因及观测范围 |
| F-04 | comp 明细和重算 | 明细可追溯，客户端剔除任意条后 ≤1s 重算，明确标记用户覆盖结果而不篡改服务端权威快照 |
| F-05 | 匿名免费查询 | 每日 5 次仅用已准入预计算数据/缓存；未命中清楚说明注册或等待选项；防刷、限流和隐私测试 |
| F-06 | 账户和密码 | 完整注册、登录、邮箱验证、密码重置、注销与数据删除请求流程 |
| F-07 | 订阅、余额桶、credit 账本 | 月额和永不过期按量包分别记录，扣费并发安全，可按查询/任务追溯；后台可查 |
| F-08 | API key 生命周期 | 多 key、名称、权限、哈希、创建仅展示一次、撤销 60s 内生效、key 旋转 |
| F-09 | 数据获得/存档/清洗 | 自建 Collector、来源准入、解析版本、审计链、质量日报与采集熔断；无第三方 Actor 依赖 |
| F-10 | 历史记录 | 只保留有权持有的数据；覆盖度、可用窗口和时间戳明确，禁止把持有样本称为完整历史 |
| F-11 | 有价值 SEO 页 | 首批 10–20 页，每页有独立数据解释/版本差异/方法和时间；无质量/权利保障不建页 |
| F-12 | MCP | `sold_search` 与 `sold_stats` 复用 API 查询执行/授权/用量；不同 MCP 客户端测试通过 |
| F-13 | 异步状态接口 | `202`、jobs 轮询、超时、取消/过期、错误重试不重扣的状态机 |

| F-14 | **自研采集全链路** | 采集调度/HTTP 或浏览器访问（只按许可）/解析/分页/去重/存档/指标均为本仓库代码；自托管运行；依赖扫描确认无外部 scraper API、Actor 或代抓取 SDK 生产调用 |
| F-15 | **断源业务连续性** | 完全停止 Collector 24/48/72 小时的 E2E：Web/API/账户/计费管理可用，有权保留快照按 SLA 标注 stale；超窗不可用不收费；恢复后回填、去重与统计版本一致 |
| F-16 | **自研采集的经济与安全门** | 真实总成本含联网重试、分页、计算、存储、维护和合法访问成本；禁止依赖第三方按结果费；401/403/验证码/拒绝访问不绕过，直接熔断并告警 |

**V1.5（上线后 1–3 个月，按需求排序）**：第二市场（权利门独立通过）、CSV 批量与小批量 API、库存估值、条码查价、可靠覆盖前提下的价格历史、收藏与提醒、高级用量/低水位 webhook、Google 登录。

**P2**：拍照、更多市场（含 Poshmark、TCGplayer、Whatnot 等）、eBay UK/DE、团队版、类目级数据导出许可产品。任何市场均需重新通过来源权利、质量、成本三道门。

**非功能标准**：月 API 可用性 ≥99.5%；查询结果 `data_as_of`、`coverage_status`、`source_price_status` 完整；全站 HTTPS，后台 MFA，API key 哈希；每周依赖漏洞扫描；查询日志去标识化；PostgreSQL 每日备份 + 异地副本、对象存储版本控制与季度恢复演练。未授权采集异常不应导致已授权数据无法被合规降级提供。

## 3. 第 0 步：14 天来源、质量、商业联合验证（Go / No-Go）

**目的**：在投入产品开发前证明五件事：① 存在明确允许自建网络采集及商业保存/统计/API 再分发的访问路径；② SoldBench **自研 Collector** 在连续 14 天内稳定抓取并保持质量，而不是借助第三方 Actor；③ 断源后站点和付费账户可继续正常运行并如实标注历史数据状态；④ 最差实际使用场景的单位经济可接受；⑤ 有真实用户愿意付费。产出 `step0/verdict.md`、自建 PoC 源码、测试日志、断源演练报告、客户访谈和准入档案；不写正式产品代码。

**重要边界**：eBay 当前用户协议对未经其事先明确许可的 scraper/robot 访问及 eBay 信息商业化有明确限制。**自建不等于取得许可**；律师分析不能代替平台需要的明确许可。未有对应访问/再分发条件前，不进行 eBay 在线自动采集。任何验证码、登录墙、账户封禁、访问限制或平台停止通知都必须触发安全停机；禁止将账号切换、代理切换、验证码破解、浏览器指纹伪装或反检测绕行当作处理策略。允许离线开发自有 parser、作业队列、数据模式及缓存降级演练。

### 3.1 前置 D-7 至 D0（不通过不得启动线上数据采集）

| 任务 | 验证 | 产物 |
| --- | --- | --- |
| T-0.1 | 明确目标 eBay US 自动采集的允许访问方式及商业保存/再分发条件；其他渠道仅作退出策略调研，不替代自建生产采集 | `step0/access-rights.md`、平台书面依据与权限边界 |
| T-0.2 | 冻结下方 120 条查询语料；各组头部/长尾各半 | `step0/corpus.csv`、hash、创始人签字 |
| T-0.3 | **自行编写** `step0/collector-poc/`：调度、获许可 HTTP/浏览器请求、分页、解析、证据记录、去重、日志；未取得许可只执行离线样本 | PoC 代码、依赖清单、实测/模拟执行模式、复现 README；无第三方代抓取调用 |
| T-0.6 | 熟悉美国互联网平台、合同与数据库许可的律师出具书面风险备忘录，明确获取、存储、再分发、跨境、平台投诉与终止义务 | `step0/legal-review.md`（保密，不入公开仓库） |
| T-0.8 | 按真实身份对Creem/Dodo/Paddle候选如实申报业务与来源；单独核验Stripe资格及PayPal能力；记录具体品类、费用、产品/收款/出款状态 | `step0/payment-review.md`，不能把“已开户”当作产品获批 |
| T-0.10 | 对自研采集的目标站、入口和字段建立逐来源准入台账：允许访问方式、速率、保留、公开展示和 API 再分发、终止义务 | `step0/source-clearance.csv`；无准入只执行离线样本模拟，**不启用 Collector 联网** |
| T-0.11 | 目标客户访谈约 10–15 人，明确目前用何工具、每月真实查询量、最大愿付价及迁移障碍 | `step0/interviews.md`，脱敏留证 |

| T-0.12 | 自研采集独立性审计：生产包依赖检查、网络出口审计和第三方计费记录验证，确保不调用代抓取服务 | `step0/independence-audit.md`，列出每个外部依赖及可替换性 |
| T-0.13 | 模拟外部来源停机：Collector 网络断开/关闭，API 与网站继续读取合法快照，等待与不可用按规则响应 | `step0/outage-drill.md`：0/24/48/72h 样本与截图、收费断言、恢复回放 |
| T-0.14 | 自建采集全成本模拟与故障恢复：按页数、重试、带宽、CPU、存储、合规访问成本和人工维护计价 | `step0/collector-unit-economics.csv`、资源上限、月最坏情况 |

### 3.2 查询语料与对照

`corpus.csv` 列：`id,group,keyword,tier(head|tail),expected_attrs,ground_truth_notes`；按六类目各 20 条，合计 120 条；不允许运行中替换低成功率样本。首批种子如下，须补足至各 20 条。

| 类目组 | 种子查询 |
| --- | --- |
| 卡牌 | Charizard Base Set Unlimited PSA 9；Michael Jordan 1986 Fleer PSA 8；Umbreon VMAX Alt Art 215/203 |
| 球鞋 | Air Jordan 1 Retro High Chicago size 10；Nike Dunk Low Panda size 9；Yeezy 350 V2 Zebra |
| 手表 | Rolex Submariner 116610LN；Seiko SKX007；Casio G-Shock GA-2100 |
| 电子游戏 | Game Boy Color Atomic Purple；Nintendo Switch OLED；Pokemon Emerald GBA cartridge |
| GPU 与电脑硬件 | RTX 4070 Ti Super 16GB；RX 7900 XT；RTX 3080 10GB |
| 收藏杂项 | Hot Wheels Super Treasure Hunt；LEGO 75192 Millennium Falcon；Funko Pop Batman 01 |

竞争者盲测：每组 5 个查询，参考 CompSniper、SoldComps 和可合法访问的官方/免费工具，**同一过滤条件、日期窗口、价格口径**对比；每查询抽至少 20 条样本，标记型号/版本/评级/成色/价格可信度。模型可以预标，但关键回归样本必须人工独立复核并记录分歧；不得把竞争者自称准确率记为事实。每组先 100 条进行探索，正式质量结论按附录 D 做扩大抽样和置信区间。

### 3.3 连续 14 天验证执行

| 测试 | 操作 | 证据与口径 |
| --- | --- | --- |
| D1–D14 **自研 Collector 稳定** | 仅在明确允许的访问方式/速率内，以 SoldBench 自研 PoC 测 120 条语料，早中晚均衡；无权限时改为离线演练，不能宣称线上验证通过 | 首次/最终成功率、延迟、字段完整率，仓库源码提交 hash 与机器资源证据；未联网测试单列 |
| D1–D3 自建网络与解析基准 | HTTP 与浏览器渲染两种**获许可访问方案**对比响应完整性与真实资源消耗，分页按允许范围测试 | 记录网络、CPU、内存、并发、分页、合法重试；不绕过技术访问限制 |
| D8–D14 自研爬坡测试 | 只在许可流量额度内爬坡到预测业务负载；不允许以新账号/出口绕过既有限制 | P95、字段缺失、解析错误、断路器触发、网络/计算成本及停止原因 |
| 每日质量 | 抽检至少 10 个结果组，核对可比性、价格状态、日期、售出事件及有无重复 | 当日质量摘要、分类异常、原始证据摘要 |
| 商业验证 | 目标用户试用同口径脱敏样本/演示并比较现有工具 | ≥3 份具体付费试点意向/实际试用订单为建议 GO 目标；缺少则暂缓产品化 |
| 合规检查 | 检查许可变更、来源投诉及数据保留义务 | 任何禁令/撤销立即停止该来源，不把换服务商视为解决 |

| 完全断源演练 | 关停 Collector 并阻断对上游的访问，验证 0/24/48/72 小时状态和恢复补采 | API/Web 保持服务；新鲜度与免责说明正确；无虚假实时、无异常扣费；恢复无重复事件 |

**测试日志建议列**：

```text
request_id, ts_utc, source_id, source_clearance_id, corpus_id, category,
attempt_no, first_attempt_success, final_outcome,
http_status_or_provider_code, latency_ms, records_observed,
records_price_verified, sample_coverage_status, bytes_in, bytes_out,
pages_or_units_consumed, collector_network_cost_cents, collector_compute_cost_cents,
parser_version, schema_hash, error_code, raw_evidence_key, notes
```

禁止写入会话凭据或可识别的个人信息。原始数据的保存时长、可公开字段必须遵从 `source_clearance_id` 对应的许可决定。

### 3.4 GO 判定（五项硬门：权利、自研质量、经济、需求、断源独立性）

| 门 | GO 目标（开发前验证门） | 失败处理 |
| --- | --- | --- |
| 法务/权利 | 目标首发市场必须具有**允许 SoldBench 自建自动采集**的访问依据及合法存储/统计/API 再分发路径；律师与创始人书面确认；如平台要求事先明确许可，须取得许可 | 权利缺失为 **NO-GO**，不能用绕过限制补救 |
| 自研稳定/质量 | **自研 Collector** 连续 14 天线上合法验证：总体首次成功率建议 ≥95%、每开放类目 ≥90%；关键字段完整率 ≥99%；来源验证、匹配精度与召回通过；不能用 Actor 成绩替代 | 未满足则复测或 NO-GO；只有离线演练不能给网络采集 GO |
| 单位经济 | 计入全部分页/重试/自建 Collector 计算/网络/存储/维护与合法访问费用的实际成功查询成本可支撑拟定套餐；压力场景下单个 Pro 用户边际毛利目标 ≥50%（建议阈值） | 成本门不达可调整额度/价格并追加 7 天验证，不得沿用旧套餐强行 GO |
| 商业需求 | 访谈 10–15 名目标客户，尽量取得 ≥3 份有具体预算/使用承诺的付费试点或实际付费证明；证明优势类目和痛点 | 无需求证据为 **需求未验证**，不开放阶段 1，允许继续用户研究 |

| **断源与独立性（附加硬门）** | 0 个第三方 scraper/Actor 在线依赖，断开 Collector 后 0/24/48/72h 服务降级 E2E 全过，恢复后无重复/错计费；已保存数据必须具备继续分发权利 | 生产依赖第三方抓取或断源导致站点核心服务宕机 → **NO-GO** |

**结论只有**：`GO`（五项硬门全部通过）、`CONDITIONAL_GO`（仅限明确可解决的性能/成本/需求偏差，再测 7 天；**不解锁产品开发**）、`NO-GO`（自研直接访问不可行、权利不可行、断源无法安全降级、技术持续失败、明显无经济性或不可接受风险）。最后必须有创始人签署 `step0/verdict.md`、源许可清单、成本分位数及风险说明。

**预算**：原 v1.2 的 $200 仅作为小规模自建 PoC 的**探索预算建议上限**，不包括律师费、平台许可费或人工；不承诺能完成 14 天测试。核心计算为「每次自研成功采集的完整边际成本」「每个可收费结果全成本」「用户请求平均成本」，单独计网络、CPU、存储、合法访问许可、人力、失败/重试。**不把 Apify/Actor 报价作为生产成本或备用成本。**

## 4. 系统架构

选型继续沿用 v1.2 的 TypeScript monorepo + 模块化单体，但明确拆为**独立自研 Collector 进程**、**独立清洗/统计 Worker**和 Web/API 服务。Hono、React SSR、PostgreSQL 16、Redis/BullMQ、S3 兼容对象存储、Docker Compose 不变。Collector 与 Worker 均为 SoldBench 仓库源码、自行发布、自有监控。**第三方 actor、代抓取 SDK、爬虫 SaaS 不在生产依赖中。** 允许使用一般性开源 HTTP/浏览器框架和普通主机/存储/网络基础设施，但不得借它们规避目标平台的许可与访问限制。

```text
[Web SSR] ────┐
[REST API] ───┼──> [Hono API] ──> [PostgreSQL: 原始可用证据 / 清洗结果 / 统计快照]
[MCP Server] ─┘        │                        ^
                       ├─ [packages/core: 纯函数匹配与统计]
                       ├─ [Redis: 缓存、限流、队列]
                       └─ [BullMQ] ──> [自建 Worker: 解析/清洗/回放] ──> [对象存储(依许可)]
                                             ^
                 【独立进程/主机边界】         |
                   [自建 Collector]
                    ├─ [Source Permission Guard: 禁止未准入网络访问]
                    ├─ [Scheduler + Rate/Cost Budget + Circuit Breaker]
                    ├─ [Owned Fetcher: 获准 HTTP/Playwright]
                    ├─ [Parser + Pagination + Identity Dedup]
                    ├─ [Evidence Writer + Outbox]
                    └─ [Health/Telemetry + Kill Switch]

失去上游访问时：Collector 停止 → API/Web 不停止 → 查询 DB/缓存合法历史
→ fresh / stale / unavailable 公开标记 → 受影响新查询不收费 / 可 503
```

| 层 | 组件 | 约束 |
| --- | --- | --- |
| API | Node.js TypeScript + Hono | `/v1`，契约优先；金额整数分；对外鉴权全部经过 tenant scope |
| Web | React SSR | SEO 页真实服务端渲染，数据不足不开放索引 |
| DB | PostgreSQL 16 | v1.4 **普通表**（不分区），唯一约束可执行；真实规模达到阈值再 ADR 评估分区 |
| 作业与缓存 | Redis + BullMQ | 作业按 tenant/规范查询/来源去重；重试与死信，队列入库一致性保护 |
| **自建采集** | `apps/collector` + `packages/collector` | SoldBench 自有源码、自托管；Fetcher、Parser、Scheduler、去重、熔断、存档；准入成功后才可联网 |
| 原始证据 | S3 兼容对象存储/R2 | 加密、访问控制、保留期限按许可证据设置；不得默认永久保存无权保存的 HTML |
| 支付 | Stripe主支付＋PayPal补充；Creem/Dodo只做备用资格核验 | webhook 校验、标准化事件、幂等权益变更；不同平台切换按正式迁移方案 |
| 部署 | 至少双进程隔离，优先双机 VPS / Docker Compose | 服务 A API/Web/DB/Redis；服务 B 自建 Collector + Worker；服务 A 不等待或直连上游；备份/恢复可验证 |

**不可破坏的架构原则**：

1. Worker 与 API 进程/资源隔离；上游失效不拖垮 API，但仅能用有权保留的缓存/历史，明确 `stale` 与 `coverage_status`。
2. `packages/core` 对清洗后的可比记录执行纯函数，不直读第三方页面；返回可复现的 `engine_version`、`candidate_set_hash` 与 `cleaner_version`。
3. 按业务身份做查询授权：`GET /v1/sold/{query_id}` 必须绑定 owner，分享使用独立短期 token，不允许越权枚举。
4. 所有网络采集只经自有 Collector + 权利校验模块；必须能立即停止被撤销许可的数据，停用后查询/导出/归档遵从 `source_clearance` 规则；**不允许按错误状态自动接入第三方抓取服务**。
5. 每个生产发布带向前兼容数据库迁移、rollback/restore 演练与零双扣的计量契约测试。

6. Collector/Worker 的重启、网络断连、上游拒绝访问、DNS 故障不得阻断 Web 登录、历史报告、API Key、余额查询、支付回调或状态页；API 不得同步依赖 Collector 存活。
7. 遇 401/403、验证码/挑战、登录墙、明确拒绝/撤销许可时立即停机/熔断，记录原因并通知人；不把切换账户/出口或自动破解挑战作为技术恢复路径。

**目录（定版）**：

```text
soldbench/
├─ apps/{api,web,worker,collector}/
├─ packages/
│  ├─ core/         # 查询匹配 + 统计纯函数
│  ├─ db/           # schema/migrations/repository
│  ├─ collector/    # 自建采集：Fetcher/Parser/Scheduler/Guard/CircuitBreaker
│  ├─ billing/      # credits 余额桶/流水 + 获选支付通道适配
│  └─ shared/       # 类型/错误码/配置/定价
├─ step0/           # 自建 Collector PoC + 离线 fixtures + 合法访问测试 + 断源演练
├─ infra/           # compose、告警、备份和恢复
└─ docs/            # openapi.yaml、adr、progress、runbook、source-policy
```

**ADR 定版**：ADR-01 模块化单体；ADR-02 原始观测不可变、处理结果版本化（按许可删除）；ADR-03 缓存优先、明确新鲜度；ADR-04 credits 不可变流水和余额桶；ADR-05 自建 Collector 解析器版本化；ADR-06 V1 不做日期分区；ADR-07 样本≠市场总体；**ADR-08 禁止第三方 scraping-as-a-service 作为生产依赖**；**ADR-09 断源运行与数据新鲜度等级**；**ADR-10 自研采集准入/停止/恢复契约**。

### 4.1 自建 Collector 最小技术契约（生产 P0）

| 模块 | 自研责任 | 关键验收 |
| --- | --- | --- |
| `AccessGuard` | 在发起请求前按 `source_clearance_id` 校验方法、字段、目的、地域、时间窗口、允许速率及过期状态 | 任何禁用/过期/缺失权限均 **0 次网络请求**；审计能证明拒绝 |
| `QueryScheduler` | 规范化查询、任务优先级、固定容量队列、按类目周期刷新、并发/流量预算 | 重复任务仅一份，上游失效时排队不无限增长 |
| `Fetcher` | 自研 HTTP 客户端/Playwright 执行器（仅限获得许可的方法）；采集版本、耗时、请求页数和网络指标 | 不借助第三方 Actor；遇 401/403/挑战页面/禁止通知停止并告警，不自动绕过 |
| `PageIterator` | 在访问授权允许范围内按源页面语义处理分页、终止条件与数量上限 | 终止可证明；空页/重复页/页数异常不重复计入成交 |
| `Parser` | 自研 HTML/结构化数据解析器；结构签名、字段完整性、单元与回放测试 | 日期、货币、运费未知、议价价未知严格分离；DOM 变动 fail closed |
| `IdentityResolver` | listing 与 sale event 识别、重复观测合并、来源间隔离 | 未核验的重复上架不能虚构多次成交；证据 hash 可追溯 |
| `EvidenceWriter` | 按准入权限将源观测与原始页或合法派生字段写入 DB/对象存储 | 不会先写无权保留数据；幂等写入、事务 outbox |
| `HealthMonitor` | 结构变动、账号/访问错误、限速、成本、队列和新鲜度分位数 | 30 分钟内触达事故接收人，P0 访问/权利阻断即时熔断 |
| `KillSwitch` | 控制全局/单类目/单入口采集开关、开关留审计，恢复必须检查准入状态 | 单次变更 ≤60 秒阻止新的采集任务；暂停不清空合法历史 |

**严格边界**：允许使用通用开源 HTTP/Playwright/HTML 解析库，但 Collector 的查询逻辑、解析规则、任务状态、缓存与数据模型必须为 SoldBench 自有代码。禁用外部 Actor ID/actor run、scraping SaaS API、绕过验证或隐藏封禁的依赖；未经许可时 `Fetcher` 必须保持 `disabled`，其他模块仍能用 fixture 离线开发。

**源码交付**：`packages/collector/src/{access-guard,scheduler,fetcher,page-iterator,parser,identity,evidence,health,circuit-breaker}.ts`；`apps/collector` 独立入口与 Compose service；`docs/collector-runbook.md`；`docs/adr/ADR-08.md`；`tests/collector/{fixtures,contract,integration,outage}`。测试必须对 Collector 完全 mock 外网，不允许 CI 意外访问 eBay。

### 4.2 采集故障不停站：降级状态与默认时限

**定义**：新鲜度相对 `data_as_of`（最后有效的来源观测时间）计算，而非 `sold_at`。90 天历史内的旧售出事件不意味着缓存“过期”；过期判断针对**最近观测覆盖的截止时间**及是否能支持当前查询。阈值是 v1.4 **首发候选配置**，待第 0 步按类目核实和经营负责人签字，不能假装所有市场都适合固定时限。

| 状态 | 默认条件（允许留存、发布时） | API/Web | credits |
| --- | --- | --- | --- |
| `fresh` | 最近一次有效观测 ≤24 小时，来源/类目质量门通过 | 正常响应并显式返回 `data_as_of` | 符合第 9/11 章规则收费 |
| `stale_acceptable` | 观测 >24 小时且 ≤72 小时；调用方显式 `allow_stale=true` | `200` + `stale=true`、`source_status=degraded`、明确数据更新时间与有限覆盖 | V1 不收费 |
| `expired` | 观测 >72 小时或不满足类目时效策略 | 不作为当前价格提供；可进入**明确的历史查询**只读展示（有权时），或当前查询 `503` | 当前查询不收费 |
| `forbidden` | 许可撤销、字段无再分发权、需删除 | 立即停止分发该来源及其衍生快照；不能用“旧缓存”规避权利撤销 | 不收费 |
| `never_observed` | 首次查询无有效观测 | 202 排队（采集允许且可恢复时）或 503 不可用 | 不收费 |

**故障期间站点维持的能力**：主页、已有可合法公开的类目/历史内容页、用户注册/登录、API key、用量与订阅、方法页、系统状态、查询/作业状态；新的实时查询只在 Collector 恢复且获准运行后执行。状态页公开最新可用数据时间/影响类别；SEO 页面不得把过期报告继续称为当前行情。

**缓存/快照事实源**：PostgreSQL 保留允许留存的 `source_observations`、`sale_events`、`query_results`、`category_pages`；Redis 仅为缓存，**断源服务不依赖 Redis 中有全部历史**。如 Redis 丢失，Web/API 可从数据库重建；如 Collector 主机完全不可用，API 容器仍正常启动。

**恢复流程**：人工确认访问与许可状态 → 打开单类目健康探针（不采用绕过手段）→ 在允许范围内恢复抓取 → 幂等补齐缺失窗口 → 校验字段完整率/重复率/价格漂移 → 10% 灰度启用 → 全量恢复并清除错误过期标记。无法合法恢复时，持续按降级策略运行或停止相关付费能力，不得把网站“存活”包装成“行情仍最新”。


## 5. 数据管道

数据管道 S1–S5 保留，但所有上游输入必须绑定来源权利证明，并区分**原始观测、商品刊登、实际售出事件、查询匹配关系和统计快照**。

| 阶段 | 操作 | 失败/边界处理 |
| --- | --- | --- |
| S1 调度 | 只向自建 Collector 派发：准入校验、查询规范化、同类任务合并、用户查询/预刷新/允许回放 | 无许可/熔断 → **不联网**；队列预算耗尽 → 202 或 503，禁止直接切第三方代抓取 |
| S2 获取 | SoldBench 自研 Fetcher 在许可范围内访问批准入口，记录页数/网络资源/状态/解析版本；不得委托外部 Actor | 429 按许可 `Retry-After` 或停止；401/403/挑战/平台拒绝 → 熔断/告警，不换账号/出口绕过 |
| S3 观测存档 | 保存允许保存的源响应、元数据摘要、hash、`source_clearance_id` 和允许的到期时间 | 无原始存档权时只存允许的衍生证明；不能把不允许存档的内容写入 R2 |
| S4 解析/实体归一 | 解析源记录、listing 身份、可观测售出事件、价格、费项、日期精度和价格核验状态 | `external_id` 不等于售出事件唯一身份；缺失事件身份不得推断成多笔真实成交 |
| S5 查询匹配与统计 | 全局属性提取、按查询属性匹配、有效价格筛选、离群评估、可重算快照；只发布质量门通过的类目 | 新版本全量回放；中位价变动 >3% 的受影响类目需人工解释 |

**关键数据边界**：

- `listing` 是商品刊登/来源中的商品标识，`sale_event` 是有证据的一笔成交。多件库存、重复售出/重刊均需通过来源证据区分；不能因为相同 listing ID 只记一次就声称完整成交量。
- `source_observations` 记录某时刻观察到的结果，支持 `first_seen_at`、`observed_at`、`source_as_of`、`raw_hash`、`source_clearance_id`、`retention_until`；抓取样本不是全部市场成交。
- `sale_price_status` 有 `verified_actual`（有实际成交价依据）、`displayed_only`（仅展示/刊登价格）、`unknown`。`displayed_only` 和 `unknown` 不进入默认实际成交价格统计。
- 同一批商品在不同查询下的匹配分、离群标记、排除原因，存 `query_comparables`，不可固定写死在 `listing_attributes`。
- `coverage_status=complete|partial|unknown`；只有来源证据明确总体范围且经核验时才可 `complete`。`archive_coverage` 只能描述**指定来源 × 时间 × 可观测总体**的覆盖度，不代表 eBay 市场覆盖。
- 任何数据删除或许可证据撤销必须能找到对应派生缓存、快照、公开页面及导出并执行停用/重算。

**质量日报**：来源首次/最终成功率、样本数量、可比记录准确率、召回率、实际成交价格核验率、字段完整率、不同类目的覆盖状态、未核验 Best Offer 占比、实际单位成本。丢弃率不是好坏目标，不能继续以 v1.2 的 25%–40% 当作最优质量标志。

**自建采集日报附加指标**：`collector_version`、准入校验拒绝数、采集任务首轮/最终成功率、首次拒绝/挑战次数、分页与去重效率、每查询请求数与字节、CPU 秒、内存峰值、合法重试次数、任务滞留、fresh/stale/expired 覆盖比例、最近有效观测时点、被禁用来源数。没有真实访问权限时报告 `offline_only`，不得报告为合法在线成功率。

**停用机制**：来源权益变化、被明确拒绝访问、收到平台通知、权限到期或合同中止 → 自建 Collector **立即熔断并停止新采集**；按准入/法务 SOP 决定是否能继续提供现有记录、快照、历史页面。API/Web 的基础功能必须持续可用，但数据不充分时如实返回 503/不收费；**不接入第三方抓取补洞**。

## 6. 清洗与匹配规则（cleaner v1.4，R-01 至 R-10）

每条规则必须有**适用类目、正/反例、误杀风险、版本、可解释原因和人工回归样本**。区分：全局可断定属性（`listing_flags`）、查询相关决策（`query_comparables`）、来源级价格可核验程度（`sale_events`）。不得把同一件商品在某次查询中的“低相关”记成全局错误商品。

| 规则 | 名称 | v1.4 处理 |
| --- | --- | --- |
| R-01 | Lots 与组合 | 标记 `is_lot`、`bundle_quantity`、是否拆包可比；默认单件查询排除 lot；不能简单凭含 `lot` 一词就删除，需避免品牌名误伤 |
| R-02 | 残次与配件 | `for parts`、`damaged`、`box only` 等生成可解释的条件标记；`read description` 单独标记人工或额外文本复核，不无条件判定残次 |
| R-03 | 查询匹配 | 品牌/型号/年份/评级/尺寸等按查询约束检查，生成匹配等级和排除原因；**强约束不一致必须剔除**，不再只“降权”后混入中心价格 |
| R-04 | 离群评估 | Q1−1.5×IQR/Q3+1.5×IQR 只作候选异常；对稀有高价/多峰分布不自动删除；默认中位数保留可比但离群的已核验价格，若排除需可解释并另列敏感性统计 |
| R-05 | Best Offer / 实际价格 | 区分 sale_format 和 `sale_price_status`。Best Offer 仅展示价不进入默认实际成交统计；返回 `excluded_unverified_price_count` |
| R-06 | 运费与金额 | `item_price_cents`、`observed_shipping_cents`、税费状态分别保存。默认 `item_plus_observed_shipping`，运费未知时不可视为 0，禁止混算不同 price_basis |
| R-07 | 去重与事件身份 | 来源记录按来源 ID + 原始事件身份/时间精度/证据 hash 去重；不能把一条商品刊登当成永远只能成交一次；来源无法判定时标 `sale_event_identity_uncertain` |
| R-08 | 成色归一 | 常用归一成色仍为 `new_with_tags`、`new_without_tags`、`like_new`、`good`、`fair`、`defective`，加 `unknown`；类目差异映射必须保留 `condition_raw` |
| R-09 | 属性抽取 | 品牌/型号/版本/年份/尺寸/容量/评级机构+分数等为固定属性；query-specific 匹配分不得写入本表；优先细化楔子类目 |
| R-10 | 币种归一 | 保留源币、成交日期、换汇来源/精度和 USD 整数分；费率未知或日期含糊时不得伪造历史汇率；标记缺少可核实换汇依据 |

**清洗计算顺序**：来源/权利验证 → 观测和售出事件身份 → 全局属性与价格状态 → 查询强制属性匹配 → 生成候选集 → 缺失/不可信价格过滤 → 汇总统计/离群敏感性分析 → 质量分项与不足说明 → 结果快照。所有剔除数量分类汇总返回，合计与 `n_observed` 对账。

**每次规则变更**：升级 `cleaner_version`，保留旧版匹配和统计快照；用附录 D 的 golden set 回放；单类目中位价漂移 >3% 必须人工复核并记录来源，不允许静默发布。

## 7. 统计计算引擎（engine v1.4）

`packages/core` 为无副作用纯函数：输入查询条件、**已匹配的售出事件**、来源及价格证据、时间窗口和版本，输出统计、诊断和一个稳定 `candidate_set_hash`。**价格分布不等于市场成交总量，也不等于未来转售价值预测。**

### 7.1 样本、可比性与价格口径

| 字段 | 精确定义 |
| --- | --- |
| `n_observed` | 该查询条件获得的源记录/候选事件数量（需按来源 ID 去重），**不是平台市场全部成交** |
| `n_comparable` | 满足型号、版本、成色等全部强约束并认定可比的事件数量 |
| `n_price_verified` | 在本次 `price_basis` 下有可核验**实际成交价**、且必要费项可用的可比事件数，是默认价格统计样本 `n_stat` |
| `n_excluded_unverified_price` | 可比但实际价/所需运费不可靠而未入价分布的数量 |
| `sold_last_30d_observed` | 本查询抓获、满足可比和价格规则且售出日期落在 30 天内的**观测样本事件数**，不是平台总销量 |
| `coverage_status` | `complete`、`partial` 或 `unknown`；只对某来源在约定类别和期间、可验证的总体覆盖程度而言 |
| `archive_coverage` | 只有分母/起止窗口具备证据时返回 0–1；未知必须返回 `null`，不能写 1.0 |
| `price_basis` | `item` 或 `item_plus_observed_shipping`；后者不含未观测税费/跨地区实际运费，不称“最终到手价” |
| `data_as_of` | 支撑本结果的来源观测最晚/最保守可信时点，同时返回 `source_window_start/end` |

**资格**：若实际成交价只能看到展示标价（尤其 Best Offer），标记 `displayed_only`，不进入默认 `n_price_verified`。如用户明确查看展示价，必须走独立的 `indicative_display_prices` 字段，不能混入 `stats`。

**统计方法**：

- `median_cents`：按升序排序后的第 50 百分位；偶数条取中间两条平均再按四舍五入到整数分。
- `p25_cents` / `p75_cents`：线性插值，使用样本分位 Type 7（位置 `h=(n-1)*p`，按 0 起索引插值）并对最终整数分四舍五入。实现用 decimal/整数有理数，不用 JS 浮点做结算或货币运算。
- `trimmed_mean_cents`：升序后两端各剔除 `floor(0.05*n)` 条，再求均值，四舍五入整数分；不能让该规则再改变 `n_price_verified`。
- 默认中位数与四分位仅在 **`n_price_verified >= 8`** 时输出；低于 8 返回 `null`，提供观测价格 `observed_min_cents`、`observed_max_cents` 及 `data_insufficient=true`，不可将小样本范围称为可信市场价格带。
- `sell_through_est` 不在 V1 返回；没有同口径在售量、售出覆盖和分母时间窗口不得用不完整样本计算周转率。
- 价格统计以 `window_days=30|90|180|365` 为筛选上限。180/365 仅在准入历史数据有明确窗口、许可和覆盖率时允许；无法支持则返回 `unsupported_window`，不能悄悄退回 90 天。
- 默认仅发布来源有权保存和公开的字段；币种换算/缺失运费/未知成交日不得作确定值。

**返回结构（均为整数分）**：

```ts
type SoldStats = {
  n_observed: number;
  n_comparable: number;
  n_price_verified: number;
  n_excluded_unverified_price: number;
  sold_last_30d_observed: number; // observed sample, NOT market volume
  median_cents: number | null;
  p25_cents: number | null;
  p75_cents: number | null;
  trimmed_mean_cents: number | null;
  observed_min_cents: number | null;
  observed_max_cents: number | null;
  buy_it_now_verified_count: number;
  best_offer_verified_count: number;
  best_offer_displayed_only_count: number;
};
```

### 7.2 质量报告（取代未经校准的单一“可信分”）

```ts
type QualityReport = {
  data_insufficient: boolean;       // n_price_verified < 8
  quality_status: 'sufficient_sample' | 'limited_sample' | 'insufficient_sample';
  match: { matched: number; excluded_hard_mismatch: number; mean_rule_match_score: number | null };
  price: { verified_share: number | null; unverified_best_offer_count: number };
  sample: { verified_count: number; recent_30d_count: number };
  freshness: { data_as_of: string | null; stale: boolean };
  coverage: { status: 'complete' | 'partial' | 'unknown'; ratio: number | null; source_scope: string | null };
  score: number | null;             // V1 null, until blind-test calibration is signed off
  warnings: string[];
};
```

**解释规则**：`match.mean_rule_match_score` 是规则匹配指标，不是已校准的 Precision。`price.verified_share = n_price_verified / n_comparable`，分母为 0 则为 `null`。`coverage.ratio` 仅当完整可靠分母存在才可数值。`score` V1 默认 `null`，不以样本数量和离散度假装统计置信度；V1.5 只有在人工盲测数据证明分数与真实错误风险有校准关系之后才能启用评分版本及其阈值。

| 有效实际价样本量 | 行为 |
| --- | --- |
| `n_price_verified >= 30` | 完整统计，`quality_status=sufficient_sample`，仍显示覆盖/价格验证和匹配告警 |
| `8–29` | 完整统计，`quality_status=limited_sample`，显著提示样本有限 |
| `<8` | 中心值/四分位/截尾均值 `null`，只给观测最小/最大及不足提示，不给评级 |

**离群值**：异常值列表与统计敏感性结果单独提供（可选）；不能在未检测数据多峰、误配、稀缺性前自动剔除高价真实成交。用户在网页前端手动排除后重算为 `user_modified=true` 的本地结果，不覆盖权威快照。

### 7.3 黄金样本算例（规范、OpenAPI 和测试共用）

查询：`game boy color atomic purple`，窗口 90 天，`price_basis=item_plus_observed_shipping`；**以下均为测试夹具，不是实测市场数字**。

- `n_observed=121`，`n_comparable=64`，其中 6 条价格未核验，`n_price_verified=58`；`sold_last_30d_observed=35`。
- 夹具实际价中位数 5800 cents、p25=4200 cents、p75=7600 cents、trimmed_mean=5930 cents（夹具必须提供 58 条完整有序价格且计算确实得到这些值，未构造前不能用此组值冒充自动算例）。
- `quality.price.verified_share = 58/64 = 0.90625`，`coverage.status=unknown`，`coverage.ratio=null`，`quality.score=null`。
- 返回 `limit=50` 时最多展示 50 条 `comps`，但价格统计基于全部 58 个符合条件的源事件；**1 次成功查询扣 1 credit，不因 58 条样本扣 2 次**。

**测试纪律**：第 7.3 的数值是目标 fixture，须在 `packages/core/test/fixtures/` 添加生成并核对过的逐条成交价格、日期、属性证据；若无法构造满足所有分位值的 fixture，必须同步修正本段与第 9 章示例，绝不写“容许 ±1”来掩盖口径差异。新增边界测试：同一商品不同评级、相同 listing 多次售出、隐藏议价实际价、缺失运费、跨日时区、极端离群、多峰分布、<8 样本、部分存档和完全未知覆盖。

## 8. 数据库设计（PostgreSQL 16，v1.4 可执行模式）

全部业务表 UUID 主键、`created_at`/`updated_at` UTC（不可变原始事件表允许仅 `created_at` + 处理时间）；金额一律 `bigint` 整数分，美元以外保留原币 ISO 4217。**v1.4 不对 `sold_listings` 做按月声明式分区**：PostgreSQL 16 的分区表 UNIQUE/PK 必须包含分区键，无法同时直接满足 v1.2 的单 UUID PK、全局 `(marketplace,external_id)` 唯一及 `sold_at` 月分区。等实际规模与访问模式证明需要再独立 ADR 迁移。

### 8.1 权利来源、观测与售出事件

| 表 | 关键字段和约束 |
| --- | --- |
| `source_clearances` | id, provider, dataset, allowed_access_methods jsonb, can_store_raw bool, can_store_derived bool, can_redistribute_comp bool, can_publish_stats bool, permitted_fields jsonb, retention_days, jurisdiction, reviewed_by, reviewed_at, expires_at, status, document_ref；必须能追溯书面依据 |
| `sources` | id, source_clearance_id FK, marketplace, access_method, collector_version, entrypoint_id, status；所有网络采集绑定有效准入及自建 Collector |

| `collector_configs`（新增） | id, source_id FK, collector_version, allowed_entrypoints jsonb, access_method(`approved_http`,`approved_browser`,`offline_fixture`), rate_cap, concurrency_cap, max_pages, max_bytes_per_job, enabled, last_approval_ref, updated_at；不能用运行时参数扩大准入权限 |
| `source_observations` | id, source_id, collector_run_id FK, captured_at, source_as_of, raw_hash, raw_object_key（可空）, retention_until（可空）, parser_version, record_count, permitted_visibility；不允许“没有原文就伪造存档” |

| `collector_runs`（新增） | id, source_id FK, config_id FK, query_hash, collector_version, parser_version, request_count, page_count, bytes_in, cpu_ms, compute_cost_cents, network_cost_cents, started_at, completed_at, outcome, stop_reason, permission_snapshot_hash；日志不存账户凭证 |
| `collector_circuits`（新增） | id, source_id FK, category_key, status(`closed`,`open`,`half_open`), opened_reason, opened_at, last_probe_at, resume_approval_ref；`open` 时不发网络任务 |
| `collector_health_snapshots`（新增） | id, source_id FK, captured_at, last_success_at, first_attempt_success_rate, challenge_count, forbidden_count, parser_completeness, backlog_depth, fresh_share, stale_share；支持断源监控 |
| `sold_listings` | id, marketplace, source_id, external_listing_id, title, url, condition_raw, condition_std, category_path, first_seen_at, last_seen_at；`UNIQUE(source_id, external_listing_id)`（前提：来源 ID 稳定），仅代表商品刊登，不代表售出事件 |
| `sale_events` | id, listing_id FK, source_id FK, source_event_key（可空）, event_identity_status, sold_at（可空）, sold_date_raw, sold_date_precision, sale_format, sale_price_status, item_price_cents（可空）, observed_shipping_cents（可空）, observed_shipping_status, currency, item_price_usd_cents（可空）, shipping_usd_cents（可空）, fx_rate_source（可空）, observation_id FK, first_seen_at；来源提供事件稳定键时 `UNIQUE(source_id, source_event_key)`，无稳定键时记录不确定性并禁止推断多个售出件数 |
| `listing_attributes` | listing_id FK, brand, model, edition, year, grade_company, grade_value, variant_attrs jsonb, extractor_version；**不存 query-specific `match_score`** |
| `listing_flags` | id, listing_id FK, rule_id, flag, cleaner_version, evidence jsonb；只存全局可判定事实，`UNIQUE(listing_id,rule_id,cleaner_version,flag)` |

**事件身份原则**：同一 `external_listing_id` 可有关联多次售出事件，仅在来源确实有独立可识别的成交证据时分别计数；否则只能展示观测记录，`coverage_status` 降级，不可将观察次数充当销售次数。

### 8.2 查询、可比集、统计与作业

| 表 | 关键字段和约束 |
| --- | --- |
| `queries` | id, user_id（匿名可空）, api_key_id（可空）, canonical_query_hash, normalized_query, filters jsonb, marketplace, window_days, price_basis, requested_limit, billing_policy_version, status, credits_charged, latency_ms, executed_at |
| `query_comparables` | id, query_id FK, sale_event_id FK, match_rule_version, match_score numeric(5,4)（仅规则指标）, is_comparable bool, include_in_price_stats bool, exclusion_reasons jsonb, outlier_candidate bool, candidate_set_hash；`UNIQUE(query_id,sale_event_id)` |
| `query_results` | query_id FK UNIQUE, stats jsonb, quality jsonb, snapshot_version, engine_version, cleaner_version, candidate_set_hash, source_scope jsonb, data_as_of, coverage_status, archive_coverage numeric(5,4)（可空）, stale bool |
| `query_result_items` | query_id FK, sale_event_id FK, presentation_order, visible_payload jsonb（仅许可字段）, `UNIQUE(query_id,sale_event_id)`；用于可重取、权限隔离和分享 |
| `query_jobs` | id, query_id FK, dedupe_key, status(`queued`,`running`,`completed`,`failed`,`expired`,`cancelled`), queue_priority, retries, status_message, error_code, available_at, expires_at；状态单向受控迁移 |
| `collector_jobs` | **从旧 `scrape_jobs` 更名**；id, source_id FK, collector_run_id FK, reason, status, attempts, page_count, records_observed, bytes_in, network_cost_cents, compute_cost_cents, error_code, stopped_reason, started_at, finished_at；不存凭证/会话明文 |
| `category_pages` | id, slug UNIQUE, filters jsonb, stats_snapshot jsonb, source_scope jsonb, quality_status, refreshed_at, indexable bool |

| `data_availability`（新增） | id, source_id FK, category_path, last_successful_observation_at, freshness_state(`fresh`,`stale_acceptable`,`expired`,`forbidden`,`never_observed`), collector_status, can_serve_history bool, last_transition_at；用于 Web/API/状态页一致性 |
| `category_taxonomy` | id, marketplace, category_path, name, parent_id, active bool |
| `anonymous_quota` | id, rotating_ip_hash, first_party_cookie_hash（可空）, day date, used_count；符合隐私政策，不默认侵入式设备指纹 |
| `live_scrape_budget` | day date PRIMARY KEY, cap, reserved, used；为**获许可的实时供应数据请求**设上限，不允许并发超支 |

**缓存**：清洗后可复用的**底层查询结果**可跨用户安全缓存（须符合来源再分发许可），用户 `queries`、额度和复取授权依然严格隔离；缓存键包含来源/许可版本、类目过滤、价格口径、窗口、cleaner/engine version 和新鲜度策略。数据许可变动能批量失效缓存和快照。

### 8.3 账户、订阅、余额桶和不可变流水

| 表 | 关键字段和约束 |
| --- | --- |
| `users` | id, email UNIQUE, password_hash, email_verified_at, status, deleted_at, preferred_marketplace, default_window_days |
| `api_keys` | id, user_id FK, key_hash UNIQUE, key_prefix, name, scopes jsonb, created_at, last_used_at, revoked_at；仅创建时显示完整密钥 |
| `plans` | id, code(`free`,`starter`,`pro`), price_usd_cents bigint, monthly_credits int, rate_limit_per_min int, policy_version, features jsonb |
| `subscriptions` | id, user_id FK, provider, provider_subscription_id, plan_id, status, current_period_start/end, cancel_at_period_end, last_provider_event_at；`UNIQUE(provider,provider_subscription_id)` |
| `credit_wallets` | id, user_id FK, bucket_type(`subscription`,`purchased`,`promo`), period_start/end（可空）, expires_at（可空）, balance int CHECK(balance>=0), status；唯一约束按 bucket identity 定义，不允许现金充值混入期限余额 |
| `credit_ledger` | id, wallet_id FK, user_id FK, delta int, balance_after int, kind(`grant`,`consume`,`refund`,`expire`,`adjust`), ref_type, ref_id, idempotency_key UNIQUE, created_at；不可修改/删除，发放与扣减在 DB 事务内锁余额桶完成 |
| `billing_charges` | id, query_id UNIQUE, user_id, charged_credits int, policy_version, state, created_at, refunded_at；每完成一次标准查询最多一笔 charge，与账本流水可对账 |
| `payment_events` | id, provider, provider_event_id, event_type, payload_encrypted jsonb/引用, received_at, processed_at, status；`UNIQUE(provider,provider_event_id)`，按保留政策脱敏/清理 |

**账务口径**：v1.4 是**按余额桶的不可变借贷流水 + 对账**，不无依据宣称严格双分录会计体系。所有扣减、赠送、退款、失效通过同一原子操作；按有限期promo/subscription最早到期优先，同期subscription优先，最后永久purchased（原§8.3误序已按§11.2/E-15纠正）；失败时整个事务回滚。

**必建索引/约束**：

- `sold_listings UNIQUE(source_id,external_listing_id)`、`sale_events UNIQUE(source_id,source_event_key) WHERE source_event_key IS NOT NULL`、`query_comparables UNIQUE(query_id,sale_event_id)`。
- `sale_events(source_id,sold_at DESC)`、`sold_listings(marketplace,category_path)`、可用的 `pg_trgm` 标题搜索索引；源适配器数据规模压测后优化。
- `queries(user_id,canonical_query_hash,executed_at DESC)` 支撑同租户 10 分钟去重；`query_jobs(dedupe_key,status)` 的并发互斥采用唯一活动锁或事务 advisory lock，不能靠普通索引假定阻止竞态。
- `credit_wallets(user_id,bucket_type,expires_at)`、`credit_ledger(wallet_id,created_at DESC)`、`payment_events(provider,provider_event_id)` 唯一。
- DB CHECK/外键验证：金额不为负、已核验价格有证据、可计算 total price 必须已观测 shipping、每笔消费有唯一 charge 关联。

**保留与删除**：原始页不再“永久保留”；仅在许可允许且商业必要时设热存/归档期限并按到期删除。用户查询保留 13 个月后聚合（如法律及隐私政策允许）；支付事件按税务及隐私保留义务。删除用户时处理身份/密钥/原文、法定留存和匿名统计分离。只可在许可允许时继续保留去标识化成交证据。

## 9. API 规格（v1.4，契约优先）

### 9.1 全局约定

| 项 | 定版 |
| --- | --- |
| 基地址 | `https://api.soldbench.com/v1`，从 `API_PUBLIC_BASE_URL` 读取，不硬编码 |
| 鉴权 | `Authorization: Bearer <api_key>`；key 创建/撤销及账户设置走网页登录会话，查询绑定 tenant |
| 金额 | 对外金额为 USD 整数 `*_cents`；不能用 JSON float 存钱 |
| 标准查询 | `limit=1..200`，每次成功且足够样本的标准查询 **扣 1 credit**；返回条数不改变收费 |
| 重复请求 | 同一用户、相同规范化参数（含 limit、窗口、价格口径、过滤条件）10 分钟内复用结果且不重复扣费 |
| 计费幂等 | GET 仍有扣费副作用，必须做 canonical hash、并发锁、唯一 charge、原子余额扣减；写端点另要求 `Idempotency-Key` |
| 不收费 | 参数错误、无价格或 `n_price_verified<8`、202 排队、503 上游错误、429、jobs 轮询、已购结果复取；stale 缓存 V1 不收费 |
| 缓存定价 | 有效缓存与首次实时完成查询统一 1 credit；底层数据缓存不包含个人的计费/查询响应 |
| 限流 | Free 30/min、Starter 60/min、Pro 300/min；还有实时预算与 credit 限制，429 含 `Retry-After` |
| 时间与覆盖 | meta 包含 `data_as_of`、`stale`、`freshness_state`、`source_status`、`coverage_status`、`archive_coverage`（可空）、`source_scope` 和版本 |
| 权限 | `query_id` 仅 owner 或授权服务可读；公开分享必须使用短期 `share_token`，去掉账户与账务数据 |
| 版本 | URL `/v1`；破坏性更新升 `/v2`、旧版保留至少 6 个月并发布弃用通知 |

`GET /v1/sold` 可同步响应 200 或异步 202；单次查询的统计样本数可大于返回的 `comps` 列表长度，不能把 `limit` 误当作真实销量上限。

### 9.2 端点

| 方法和路径 | 说明 | 计费 |
| --- | --- | --- |
| `GET /v1/sold` | 成交查询，返回统计、comps 或任务状态 | 成功足量时首次 1 credit |
| `GET /v1/sold/{query_id}` | owner 复取已购结果 | 0 |
| `POST /v1/sold/{query_id}/claim` | 显式领取ready异步结果，按ADR-12原子结算 | 首次合格交付1，其余0 |
| `GET /v1/jobs/{job_id}` | 任务 queued/running/completed/failed/expired 状态 | 0 |
| `GET /v1/categories` | 类目、支持属性及覆盖状况 | 0 |
| `GET /v1/usage` | 分余额桶余额、到期时间、扣费流水 | 0 |

| `GET /v1/data-status` | 各已开放类目最后有效观测时点、freshness/Collector 状态；无内部凭证 | 0 |
| `POST /v1/keys`、`DELETE /v1/keys/{id}` | key 创建、吊销及轮换 | 0 |
| `POST /v1/shares`、`GET /share/{token}` | 有时效的去标识化结果分享 | 0 |
| `POST /webhooks/paddle`、`/webhooks/dodo` | 计费服务端回调验签和事件处理 | 不涉及查询 credits |
| `POST /v1/batch-searches` | P0.5/V1.5 小批量异步 | 每有效子查询独立计费 |
| `GET /v1/history` | V1.5，有历史覆盖验证才提供 | 单独定版 |

**`GET /v1/sold` 参数**：`q` 必填 ≤120 字符；`marketplace=ebay_us` 默认；`category`、`brand`、`model`、`attr_*`（如 `attr_grade=PSA 9`）；`condition` 标准枚举；`window_days=30|90|180|365`（缺少许可历史窗口返回 422 `unsupported_window`，不暗退至 90 天）；`price_basis=item|item_plus_observed_shipping` 默认后者；`limit=1..200` 默认 50；`allow_stale=false` 默认，true 仅可使用**仍有权提供的**、处于 `stale_acceptable`（默认 ≤72h）的快照且 V1 不收费；超过最大陈旧窗口的当前价查询 503，不因用户设 true 无限延长。

**响应信封**：同步成功 `{data,meta}`；202 `{data:{job_id,status,status_url},meta:{credits_charged:0,...}}`；失败 `{error:{code,message,details,request_id}}`。异步计算完成只变ready、不收费，GET jobs轮询始终免费；owner通过POST /v1/sold/{query_id}/claim显式领取时才原子收费一次；未领取到期/任务失败免费；`query_jobs` 状态变更与账本原子提交或由可恢复事务 Outbox 保证。

**错误码**：400 `invalid_parameter`；401 `invalid_api_key`；402 `insufficient_credits`；403 `forbidden`；404 `not_found`（不存在资源，不代表查不到成交）；409 `idempotency_conflict`；422 `unsupported_window`；429 `rate_limited`；503 `source_unavailable`/`collector_unavailable`/`data_expired`；504 `job_timeout`（仅同步处理）。**无结果**统一 200、`n_price_verified=0`、`data_insufficient=true`、`credits_charged=0`。

**任务**：`queued → running → completed|failed|expired|cancelled`。`GET /v1/jobs/{id}` `completed` 后返回 `query_id` 与 `result_url`；排队/运行/计算完成待领取不扣费；显式claim交付fresh且有≥8已核验可比成交样本才扣1credit；允许stale交付0credit。默认任务有效期 24 小时；作业失败重试、同一 key 重试不能重复扣费，Collector 的实际失败与重试成本单独纳入成本。

**Collector 断源时的 API 契约**：① `collector_status=stopped` 不影响 `GET /v1/sold/{query_id}`（有权且未到结果保留期限）、`GET /v1/usage`、`GET /v1/categories` 等自身服务；② `fresh` 命中按正常计费，`stale_acceptable` 仅 `allow_stale=true` 返回且 **0 credit**；③ `expired` 当前价返回 503 `data_expired` 并带 `last_data_as_of`；④ `forbidden` 不返回相关数据；⑤ 无新采集能力时不得无限返回 202，有限等待超过预算即返回 503。第 9.3 节 JSON 示例是健康状态，压测和文档另附断源 `200 stale`、`503` fixtures。

### 9.3 规范返回示例

下例为**合成 fixture 的结构示范**，非真实市场数据。`stats` 在 58 个已核验价格样本上计算，`comps` 在示例中仅节选 1 条（故 `returned_comp_count=1`）；生产查询要求返回真实 `min(limit,n_price_verified)` 条可展示记录（许可受限则需要告警/诊断并在 meta 解释）。

```json
{
  "data": {
    "query_id": "00000000-0000-4000-8000-000000000001",
    "query": {"q":"game boy color atomic purple","marketplace":"ebay_us","window_days":90,"price_basis":"item_plus_observed_shipping","limit":50},
    "stats": {
      "n_observed":121,"n_comparable":64,"n_price_verified":58,
      "n_excluded_unverified_price":6,"sold_last_30d_observed":35,
      "median_cents":5800,"p25_cents":4200,"p75_cents":7600,
      "trimmed_mean_cents":5930,"observed_min_cents":2900,"observed_max_cents":10800,
      "buy_it_now_verified_count":54,"best_offer_verified_count":4,
      "best_offer_displayed_only_count":6
    },
    "quality": {
      "data_insufficient":false,"quality_status":"sufficient_sample",
      "match":{"matched":64,"excluded_hard_mismatch":57,"mean_rule_match_score":null},
      "price":{"verified_share":0.90625,"unverified_best_offer_count":6},
      "sample":{"verified_count":58,"recent_30d_count":35},
      "freshness":{"data_as_of":"2026-11-14T06:00:00Z","stale":false},
      "coverage":{"status":"unknown","ratio":null,"source_scope":null},
      "score":null,"warnings":["Observed samples are not complete market sales."]
    },
    "comps":[{
      "sale_event_id":"11111111-1111-4111-8111-111111111111",
      "title":"Nintendo Game Boy Color Atomic Purple Handheld",
      "item_price_cents":5500,"observed_shipping_cents":499,
      "price_usd_cents":5999,"currency":"USD",
      "sale_price_status":"verified_actual","sale_format":"fixed_price",
      "sold_at":"2026-11-02T00:00:00Z","sold_date_precision":"day",
      "condition_std":"good","url":"https://example.invalid/source-item"
    }]
  },
  "meta": {
    "credits_charged":1,"cache_hit":false,"data_as_of":"2026-11-14T06:00:00Z",
    "stale":false,"freshness_state":"fresh","source_status":"healthy","coverage_status":"unknown","archive_coverage":null,
    "source_scope":["approved_source_1"],"engine_version":"1.4.0",
    "cleaner_version":"1.4.0","billing_policy_version":"1.4.0",
    "returned_comp_count":1,"available_comp_count":58,
    "example_is_truncated":true
  }
}
```

示例的 `example_is_truncated` 仅用于文档展示，不是生产字段。文档/契约测试中必须另外保存完整 `limit=50` JSON fixture，并用第 7.3 节的逐条价格样本核验数值。`example.invalid` 是占位符，绝不发布为有效成交链接。

**202 示例**：

```json
{"data":{"job_id":"22222222-2222-4222-8222-222222222222","status":"queued","status_url":"/v1/jobs/22222222-2222-4222-8222-222222222222"},"meta":{"credits_charged":0,"data_as_of":null,"stale":false,"engine_version":"1.4.0"}}
```

### 9.3.1 断源响应示例（与第 4.2 节一致）

下列为**合成测试响应**，仅当有权继续保留及展示该数据时成立。已过时但仍处于允许的降级窗口，调用方必须显式设置 `allow_stale=true`；旧数据 V1 不收费。

```json
{
  "data": {
    "query_id": "00000000-0000-4000-8000-000000000001",
    "stats": {"n_price_verified": 58, "median_cents": 5800},
    "comps": []
  },
  "meta": {
    "credits_charged": 0,
    "data_as_of": "2026-11-14T06:00:00Z",
    "stale": true,
    "freshness_state": "stale_acceptable",
    "source_status": "degraded",
    "coverage_status": "unknown",
    "archive_coverage": null,
    "engine_version": "1.4.0",
    "example_is_truncated": true
  }
}
```

**注意**：`example_is_truncated` 仅为文档演示标识。生产结果必须遵守 `/v1/sold` 的完整 schema；不能用本节节选 JSON 作为完整 OpenAPI fixture。若当前价已经超过允许的陈旧窗口，则返回 `503` 且 `credits_charged=0`：

```json
{
  "error": {
    "code": "data_expired",
    "message": "Current sold-price data is temporarily unavailable.",
    "details": {"last_data_as_of": "2026-11-14T06:00:00Z", "source_status": "stopped"},
    "request_id": "req_synthetic_001"
  }
}
```

即使上述当前价查询不可用，`/v1/usage`、API Key 管理、用户登录和有权保留的**明确历史**查询仍须按其自身契约可用。所有时间窗口/出数/收费条件必须在 E2E 自动断源演练中验证。

### 9.4 MCP 与开发者文档

| MCP 工具 | 行为 |
| --- | --- |
| `sold_search` | 与 `/v1/sold` 同查询能力，摘要及前 20 条 comp；有权限用户可由查询 ID 复取；执行新有效查询按标准规则收费 |
| `sold_stats` | 从本人已有可读快照读取，永不隐式新查或领取。 |

MCP 的 search、status、result 和 claim 动作见 [MCP 与开发者交付契约](docs/MCP与开发者交付契约.md)。只有调用方明确同意后才执行 claim，沿 REST 原子结算。MCP 的 20 条展示上限不改变规范参数、候选集或完整统计。双语 Markdown、Skill、OpenAPI JSON 和客户端示例随仓库交付。

远程 MCP 采用 Streamable HTTP；Bearer API key 的 scopes、租户权限、计费和 REST 一致。必须覆盖余额不足、异步等待、重复查询不多扣、分享越权及两个主流 MCP 客户端联调。

**文档交付物**：`docs/openapi.yaml`（OpenAPI 3.1）、5 分钟 quickstart、curl/TS 客户端范例、202 任务轮询、金额分单位、实际价验证/Best Offer、覆盖局限、失败状态、密钥旋转、MCP、Postman 或 Bruno collection；实现与 OpenAPI 双向契约校验入 CI。

## 10. 前端、用户工作流与 SEO

2026-11-16用户确认：首发英语＋简体中文；后续新增站点必须同步交付当地所需语言，已有语言复用并地区适配。完整规则以 [多语言与商业交付补充规格](docs/多语言与商业交付补充规格.md) 和DEC-12为准；覆盖界面、邮件、错误、格式、SEO及双语验收。界面语言不改变eBay美国站和USD口径。

### 10.1 P0 页面与交互

| 页面 | V1 要求 |
| --- | --- |
| 首页免费工具 | 首屏输入关键词、热门真实示例，显示匿名可用次数；只能对许可来源的预缓存样本出数，未命中有清晰注册/稍后查询说明，不伪装“正在查全网” |
| 结果页 | 明确区分“已核验实际价统计”和“仅展示价/未知价”，顶部中位数/区间/实际价样本量，旁边覆盖状态与观察时间；字段名不写“全市场销量” |
| 结果列表 | 成交来源可追溯，过滤/剔除后 <1s 重算并显示 `Your adjusted view`；原始权威结果与用户重算清楚分开 |
| 登录、用量后台 | 注册/验证/密码重置/注销；分桶 credit 余额、账本、订阅时间、key 管理/吊销、授权信息；**基本用量看板必须在 V1** |
| 定价页 | 价格/credit 规则来自 `packages/shared/pricing.ts`，解释 1 次成功查询扣 1 credit、200 条上限、低于 8 条已核验样本不扣、有效缓存收费、异步等待不扣 |
| API 文档 | 鉴权、200/202、轮询、1 credit、历史覆盖、可信度分项、Best Offer 限制、MCP |
| 来源与方法 | 来源性质、非官方关联、许可所允许的可公开说明、统计局限、反馈及下架入口；不能称“官方授权数据”除非有有效授权 |

| 数据更新状态 | 首页/查询结果/类目页和独立状态页显示“最后更新时间”和 `Fresh / Delayed / Historical / Unavailable`；采集暂停时不出现假实时计数器 |
| 楔子类目/单品页 | 首批 10–20 个高质量页面，每页有具体可比属性、样本和价可信度、可核实的独立解释、最后更新时间；无足够数据不 index |
| 竞品对比页 | 首发最多 2 篇；事实基于有日期、相同用量单位的实测/官网说明，营销声称与独立测试分开 |

**关键用户路径**：网页用户匿名查询（可命中）→真实结果与局限→注册/验证→网页新查询或复取历史→明确费用后领取→用量/订阅管理；全程无需API key。开发者在注册/验证后另走key创建→示例调用→领取/免费复取→用量对账。两条主线均支持英语与简体中文，并按同一owner/查询/收费规则验收。不得拿 V1.5 的历史曲线、第二市场或完整 CSV 批量功能当作已上线付费卖点。

**低样本/未知价格状态**：`n_price_verified<8` 时首页/结果页不展示“可信中位价”，而展示不足原因、样本数量和下一步建议；原始候选可以在许可范围内展示但不计费。未知 Best Offer 只列在诊断信息，默认中位数不含该项。数据过期用明确 badge/时间而不是继续显示为新鲜。

**匿名额度**：每日 5 次仅命中缓存，联合旋转 IP hash、第一方 cookie 和异常流量控制；避免默认使用侵入式设备指纹，按隐私政策披露。可分享结果仅有脱敏可公开字段，默认短期有效；分享查看不新扣费、不泄露 owner。

**全站断源体验**：Web Header/首页不因采集异常空白或报 500；查询框不暗示实时可用；类目历史数据若超当前行情时限必须显示历史标记、最后观测时点，并按 SEO 政策降索引；用户后台、用量、账单、密钥管理保持可用。用户在查询时可选择在有权的 ≤72h 历史数据上继续查看，并清楚知道不收 credit。

### 10.2 SEO 质量优先

不以自动生成页数为目标，不为不存在的样本生成页。模板：楔子类目基础页、清晰版本/评级对比的单品页、带可验证统计例子的原创指南页、事实严谨的竞品对比页。内容至少具备可独立验证的实质价值，不能仅把模板变量 + 价格快照批量换词生成近重复页。

- 来源权利不允许公开商品标题/链接时，不输出该字段；没有公开数据权的组合即使统计可内部使用也不得 index。
- 类目页数据超出已批准新鲜度 SLA 自动标注 stale、必要时移出 sitemap 和设置 noindex；无样本/高价格不确定性也 noindex。
- 每个页面以真实查询数据、方法局限、更新日期、适用范围为基本要素；SEO 文字不宣称完整交易历史。
- 先做 10–20 个质量较高页面，监测真实索引与自然工具转化，再扩 50/100 页；对收录不好或缺少独立价值的页面不放量。
- 相关规范：Google Search Central 关于规模化无价值内容的政策（参考附录 F）。

### 10.3 可访问性与体验验收

移动端首屏展示统计 + 样本可信度；完整查价不超过 3 步；LCP ≤2.5s（测试设备与网络条件记录），键盘和读屏可用；结果页图表不能用颜色作为唯一信息信号。失败、排队、余额不足、数据不足各有明确可恢复路径，不显示空白 500。

## 11. 计费、账户权益与收款（billing policy v1.4）

### 11.1 V1 候选套餐（需第 0 步单位经济与市场验证后定版）

| 套餐 | 月费 | 月订阅 credits | 限流 | 备注 |
| --- | --- | --- | --- | --- |
| Free | $0 | 100 | 30/min | 无需绑卡；匿名缓存免费查价另外每天最多 5 次 |
| Starter | $9/月 | 2,000 | 60/min | 与竞品对比须比较**实际成功查询次数**，不把记录条数当查询次数 |
| Pro | $29/月 | 10,000 | 300/min | 优先队列可配；批量、历史曲线等未来权益上线前不得作为已提供功能宣传 |
| 按量包 | $10 / 1,500 credits | 永不过期（除条款约定的法定/账户关闭情形） | 随账户套餐 | 余额归入 purchased bucket，不因订阅周期清零 |

**计量定版**：1 次满足收费条件的标准查询 = 1 credit，**无论 API 返回 1–200 条 comp，均不因条数增加 credit**。收费条件：查询最终完成、有 ≥8 条已核验可比价格、结果未因许可/来源错误失效、非同租户 10 分钟内重复查询；客户端获取其已买结果、202 等待和 failed/expired 不扣费。`limit`、类目、窗口、price_basis 变化计为新查询。有效缓存与实时查询同价。

**重大提醒**：上述套餐额度为候选经营假设，不是已获批准的利润模型；若第 0 步高用量压测证明不能支撑，必须调价/改套餐额度或缩小最大资源开销，并同步重算第 12 章，不能偷偷恢复 `ceil(n/50)` 扣费。

### 11.2 余额桶与扣减

- 订阅额度（`subscription`）每个账期发放且默认不跨期，账期结束处理剩余余额失效事件；按量包（`purchased`）单独持有且永不过期；试用/促销（`promo`）有明确到期日。
- 消费顺序：先在有到期时间的 `promo` 与 `subscription` 桶中按最早 `expires_at` 顺序消费（同一到期时间先 `subscription`），最后消费永不过期的 `purchased` 桶。对外明确展示这一顺序；任何调整必须经 E-15 决策并升级 `billing_policy_version`。
- 一次查询需扣 1 credit，可跨一个 bucket 就能完成；余额检查和扣减在同一数据库事务，对钱包行 `FOR UPDATE`，同一 query 通过 `billing_charges.query_id UNIQUE` 防双扣。
- 任务开始前可执行额度预检，但不预扣；排队期间额度不足或订阅到期，计算可完成为ready但不扣费；显式claim时余额不足返回402且保留ready至24h领取期限，充值后重试claim，不暴露未付费内容。
- 退款：原 charge 钱包恢复原桶，若已到期的订阅桶退款则按明确政策处理（按ADR-12给30天promo补偿桶，不让过期额度凭空永久化）；任何回退保持 ledger 不可变，走 `refund` 反向流水。
- 账务是**余额桶+不可变流水及严格对账**，而非未经定义的复式会计；运营账户、销售收入与支付渠道真实财务会计另由收款平台对账完成。

### 11.3 支付、税务及状态

| 通道 | 角色 | 准入条件 |
| --- | --- | --- |
| Stripe | 主支付，先开发接入 | 真实账户/主体和本产品资格、税务及发票/退款责任落实后启用；未来香港公司仍需单独审批 |
| PayPal中国 | 补充支付，纳入开发 | 核验用户现有账户商业API/订阅及提现能力，独立验签/对账，未批准不显示可用按钮 |
| Creem | 备用资格验证 | 已注册/部分审核无真实收款提现；核验本产品及中国个人结算，未经选用不开发生产适配器 |
| Dodo Payments | 备用资格验证 | 核验中国个人、香港同名卡/Wise及产品准入；未经选用不开发生产适配器 |
| Paddle | 保留旧方案参考 | 当前不开发、不启用；以后如需采用另行决定 |

**Webhook**：验签→原始事件（最小必要字段/加密）落库→幂等处理→钱包/订阅状态变更；重复/乱序和部分失败必须可重放，按 `provider,provider_event_id` 唯一；事件时间不等于最终订单状态，服务端主动对账。每日自动比对订阅活跃状态、交易金额、退款和本地 grant 流水；差异告警并禁止重复权益发放。

**退款/取消**：首月 7 天退款政策仅在收款提供方条款允许且已由创始人确认后公开；正式退款政策含已消耗 credits、不可退款采购包、争议/退款渠道通知与消费者适用法律。取消在期末生效，法律或付款供应商要求立即终止时优先遵从。Stripe Payments/Billing与PayPal直连方案不自动提供MoR责任；销售税/VAT、发票及销售主体义务须落实，不能沿用MoR包办的承诺。

**余额透明**：`GET /v1/usage` 和后台必须显示订阅/按量/促销桶的余额与到期日、最近 charge/refund、重复请求复用行为。每次成功返回 `meta.credits_charged=1`；失败、低样本与等待返回 0。不同入口（REST、Web、MCP）同一规则，不存在隐形免费的 MCP 查询。

**现金保护**：上线前保留至少 3 个月可承担的运营现金，对收款冻结、争议退款、超额数据成本设预算闸门；任何按量包销售必须先确认数据源使用许可和未来供应能力。

## 12. 成本模型、压力场景与单位经济

2026-11-16定价原则（用户明确）：优先取得持续、可核验的稳定供数证据，再依据SoldBench自身完整实测成本、客户价值/支付意愿和同口径竞品方案决定价格与额度。截图中的$0.01仅参考，原稿$9/$29/$10及额度均为候选，不是必须维持的价格或采集成本硬上限；不能为了套用参考价格放宽数据质量。

### 12.1 不再把“页面成本”直接当成“查询成本”

`collector_cost_per_billable_query = (获准访问成本/许可费分摊 + 实际分页及允许的网络带宽费用 + CPU/内存/存储/队列/快照增量费 + 合规重试及失败任务分摊 + 采集程序维护工时折算) / 成功且可收费的查询数`。

**同时报告**：

- 平均成功查询总成本、P50/P95 成本及最差 5% 长尾成本；首次/最终成功率。
- `limit=50/100/200`、窗口 `30/90/180/365`、不同类目热词/长尾词、是否命中缓存、合法重试次数与上游分页/记录数。
- 免费请求总成本（匿名缓存查询、注册免费查询、低样本不计费查询）、支付费、退款和真实基础设施分摊。
- 来源合法访问许可费与再分发权利成本；**不包含第三方 Actor/按记录代抓取付费作为生产输入**；不能只按压缩后网页 MB 估算完整成本。

**重要**：旧版住宅代理流量、带宽、Apify Actor 每千条报价属于**历史市场参照**，不能视为自研采集已可用、已授权或已产生经营优势。生产不接第三方采集 Actor；必须用自研 Collector 的真实网络字节、CPU/内存、存储、允许访问许可、失败重试、维护与可收费率重新建模。

### 12.2 高利用率客户敏感性（仅流量示例）

假设 Pro $29/月、每月 10,000 次成功查询、缓存命中 70%、未命中率 30%、网络成本 $8/GB；此处把每次未命中**完整供应链实际流量**记为 0.5/1/2 MB，忽略授权费等：

| 每次未命中实际流量 | 未命中调用 | 每月代理流量 | 仅流量成本 | 扣 Paddle 假设 5%+$0.50 后可用收入 | 余量（未扣任何其他成本） |
| --- | --- | --- | --- | --- | --- |
| 0.5 MB | 3,000 | 1.5 GB | $12 | $27.05 | $15.05 |
| 1.0 MB | 3,000 | 3.0 GB | $24 | $27.05 | $3.05 |
| 2.0 MB | 3,000 | 6.0 GB | $48 | $27.05 | -$20.95 |

> 以上支付费率是演算假设；实际以签约金额、地域和费用为准。没有包含来源许可、CPU/存储、人力、退款、低样本未收费任务、退订、税费等。为保证 Pro 高使用率用户也有目标 ≥50% 的边际毛利，必须根据完整成本设置预算，而不是只期望平均缓存命中 70%。

**Starter** $9、2,000 credits 满额、缓存 70%、每未命中 0.5MB/$8/GB 时，仅代理费约 $2.40；假设支付费 5%+$0.50 为 $0.95，到手 $8.05；仍须减去来源许可和基础设施费。

### 12.3 三种实际需求分布情境（必须填入 `step0/unit-economics.csv`）

**采集自主性成本项**：除总成本外，独立填 `requests_per_result`、`pages_per_query`、`bytes_per_page`、`cpu_ms_per_page`、`storage_bytes_per_observation`、`failed_task_cost`、`manual_maintenance_hours`、`permission_cost`、`snapshot_reuse_ratio`、`no_data_unbilled_cost`。**定价 $9/$29 是待验证假设**，自研也可能亏损；若合法访问本身不可获得，不得用“自研更便宜”判断 GO。


| 情境 | 热/冷查询 | 预计行为 | 必须测的风险 |
| --- | --- | --- | --- |
| 乐观 | 热门重复查询多、缓存 ≥70% | 成本接近旧表估算 | 是否价格统计因过期而失效，缓存复用许可 |
| 基准 | 缓存 40%–60% | API 开发者存在大量不同型号/过滤条件 | 长尾分页、数据未核验且不收费的实际成本 |
| 压力 | 缓存 ≤30%，Pro 额度几乎满额 | 少数高用量客户消耗远多于收入 | 月度毛利、上游费用触顶、拒绝服务比例、退款 |

**GO 门建议**：在拥有可用于商业再分发的数据来源前提下，以**压力场景**与真实查询混合计算 Pro 边际毛利目标 ≥50%，至少不能出现长期负毛利；若不足，必须采取公开透明的套餐调整、额度调整、长期缓存优化或开发者配额保护，再复测。不能隐性按返回 comp 数额外收费。

### 12.4 经营模型及决策门

- 付费假设沿用 v1.2：60% Starter、40% Pro，混合客单价约 $17；只是计划测算，未包含离散用量/付费后留存差异，不能当成已验证 LTV。
- 现金盈亏平衡公式：`需要付费订阅数 = 固定月现金成本 / (混合每用户月净收入 - 混合每用户月可变供数成本)`。净收入须扣支付费用、退款及适用税费；毛利率与现金盈亏平衡单独呈现。
- 在第 0 步拿到真实查询价格、支付签约费、授权费用前，不保留 v1.2 “65–90 个订阅即可盈亏平衡”的确定性表述；该数字仅可作为旧版基准对照。
- 每月统计每个套餐 P50/P90/P99 查询量、每成功付费查询的自建采集总成本、免费账户与失败查询消耗、缓存命中率、退款/争议、自建 Collector 主机/网络账单与访问许可有效期。
- 任何新采集入口或新市场上线前重跑单位经济；自建采集成本超过预算闸门立即降级为异步/不可用，不继续无限亏损查询。

## 13. 运营、监控、安全与事故手册

| 周期 | 自动/人工动作 |
| --- | --- |
| 每日 | 来源许可有效性、自建 Collector 状态、首次/最终成功率、统计样本及价格核验率、缓存命中率、P95 延迟、API 计费流水、支付订单对账、实时成本；异常推送 |

| 每日（自建采集） | Collector 健康/熔断状态、入口准入有效性、挑战/403 趋势、字段解析漂移、任务 backlog、fresh/stale/expired 分布、CPU/内存/网络/维护工时 |
| 每周 | 对上线楔子类目抽样 100 条人工复核，六组实验组另按附录 D 做回归；检查来源许可/退款工单、SEO 真实性与状态页 |
| 每月 | 用真实配额和发票重算第 12 章；按套餐核对边际毛利与留存、失效数据删除及投诉处理 SLA |
| 每季 | 数据库/R2 恢复演练、律师/平台条款与许可审查、竞品同口径巡检、访问权限与密钥轮换检查 |

| 告警级别 | 触发 | 动作 |
| --- | --- | --- |
| P0（合规/越权） | 来源许可被撤销、收到应停止的正式通知、数据越权泄露、双扣或用户跨租户数据暴露 | **立即停止受影响来源/接口或扣费**，保留审计证据，按法律/隐私事件 SOP 处置，未批准前不恢复 |
| P1（业务） | 可用来源全站不可用、API 5xx >2%、支付 Webhook 中断、连续 30 分钟抓取/供应成功率 <80% | 30 分钟内响应，降级到有权缓存并明确 stale 或拒绝服务 |

| P1（Collector 断源） | 自研 Collector 进程停止、上游不可达或全部来源熔断 | Web/API 保持运行，关闭新采集并触发降级；告警到人；**禁用第三方 Actor 自动接管** |
| P2（类目质量） | 任一上架类目错配/价格误差越门、价格字段完整率 <97%、单类目成功率 <90% | 当日关闭受影响类目新付费查询或标记 `quality_degraded`，核实后恢复 |
| P3（增长和效率） | 缓存命中率 <50%、内容页过期 >3 天、月度单位成本超过预算预警 | 一周内复盘；若有持续经营亏损则升级 P1 |

**Runbooks**：

- RB-1 上游访问/许可异常：区分合同/法律禁用与暂时技术故障 → 禁止来源新获取 → 只在许可允许时提供已存缓存并显示时间/覆盖 → 通知受影响用户与平台联系窗口（如适用） → 法务及准入确认后才恢复。
- RB-2 来源数据结构变化：暂停受影响解析器 → 用有权保存的历史样本离线回归 → 10% 范围灰度验证 → 全量重放，变动中位数 >3% 复核。
- RB-3 计费异常：立即暂停新增收费（不代表无条件免费放开自研采集预算）→ 依据 `credit_ledger`、`billing_charges` 和支付平台逐单对账 → 多扣先退款补偿 → 发布事件总结。
- RB-4 统计错误：锁定受影响 `engine_version`/candidate hash → 隔离数据/下线受影响统计 → 修复并版本升级 → 对可能受影响客户说明事实和更正范围。
- RB-5 数据权利变动/删除：按 `source_clearance` 定位原始观测、事件、查询快照、Redis、SEO 页面、分享链接 → 停止分发/执行约定删除 → 生成审计记录并告知相关方。

- **RB-6 自研 Collector 故障/恢复**：立即停新任务/切断采集请求 → 不重启 Web/API → API 从 Postgres/允许的快照出数并标注 fresh/stale/expired → 校验 503 不扣费 → 检查访问许可/错误码/解析版本 → 若遇限制/挑战则不绕过 → 经批准健康探针、灰度回填、去重/质量验证 → 恢复采集。连续 72h 不可恢复时暂停新收费承诺、公开数据更新事故并提供客户支持。
- **RB-7 第三方抓取依赖误入生产**：CI 依赖审计或网络出口检测到 Apify Actor、scraper-as-a-service API 被作为生产入口 → 阻断上线/立即禁用 → 查证调用、账单、数据权利和来源污染范围 → 移除依赖并重跑独立性测试。

**安全**：API key 只存强哈希与短前缀，支持吊销 ≤60s；后台 MFA；Webhooks 验签与重放保护；Postgres 最小权限；R2 加密/访问控制；隐私政策说明 IP 哈希和查询日志；异常查询/账户注册防滥用不过度指纹化。备份每日、异地副本每周、季度演练，恢复后必须校验 wallets/ledger/charges 无缺漏。

## 14. 路线图、依赖与开发 Story（agent 执行顺序）

**阶段纪律**：正式产品开发只在第 0 步四项商业/质量门 + 自研独立性/断源门全部 `GO` 后开始；已获准离线 PoC 可在第 0 步开展。以下是单人团队的计划区间，不是对产品进度的保证；未过验证不得以“避免闲置”为由提前写生产采集、支付或营销功能。

| 阶段 | 建议周期 | 交付物及验收门 |
| --- | --- | --- |
| 0 共同验证 | D-7 前置 + 连续 14 天；必要时再 7 天 | T-0.1…0.14；自建 Collector 许可、线上稳定/匹配/成本、需求 + 断源独立性门全过；`verdict.md = GO` |
| 1 自建 Collector + 可审计数据层 | 第 4–7 周（相对立项日） | 从 PoC 独立实现生产 Collector/Fetcher/Parser/熔断、DB 观测与事件、离线回放/断源；不引入第三方代抓取；线上按准入规则稳定 7 天 |
| 2 精准匹配与统计 | 第 6–9 周 | R-01…R-10、query_comparables、整数价格引擎、fixture 和盲测；楔子类目质量门通过 |
| 3 账户、API 与计费 | 第 9–13 周 | 认证/key、余额桶、API/异步任务、获选支付通道审核及沙盒/生产可行的最小闭环；无双扣、无越权 |
| 4 免费工具与内容 | 第 13–16 周 | 查价工具、结果/复算、基本用量后台、10–20 个独立价值的 SEO 页、方法说明与分享 |
| 5 MCP、运维及收费上线 | 第 16–18 周 | MCP、OpenAPI、一致性回归、状态页、备份恢复、安全审查、真实客户付费试点；第 2 章上线门逐条签字 |
| V1.5 | 上线后依客户使用数据排期 | 批量/历史/第二市场，逐能力重新做来源权利与经济门 |

**Epic**：E1 基础设施与权利台账；E2 **自研 Collector**/观测与事件；E3 属性/查询匹配/质量；E4 纯函数统计；E5 账户/钱包/支付；E6 任务 API/契约；E7 Web/SEO；E8 MCP/开发者分发；E9 安全、监控、删除和恢复。

**每个 Story 必须同时验收**：实现 + 单测 + 契约/迁移（若涉及）+ 负例 + `docs/progress.md` 证据；字段、额度和价格规则有变化时先改规格。以下编号替代 v1.2 的 S-01…S-14，不应把旧代码/任务表与新版编号混用。

| 新编号 | 阶段 | Story | 完成判据/关键依赖 |
| --- | --- | --- | --- |
| S-01 | 1 | 初始化 monorepo、CI、dev/staging/prod 配置及安全模板 | `lint/test/build/typecheck/openapi-check` 全绿；无凭据；第 0 步 GO 已归档 |
| S-02 | 1 | `source_clearances` 准入与自建 Collector `AccessGuard` | 无有效许可 ID 时 0 网络请求，支持撤销后的传播/停用测试 |
| S-03 | 1 | DB migration：观测、刊登、售出事件及唯一约束 | PG16 实例可迁移/回滚；同 listing 多售出、无事件键不可乱计数 |
| S-04 | 1 | **自研 Fetcher + Parser + Pagination + IdentityResolver** | 只能使用获准访问方式；外部 Actor 调用 0；结构变更/字段缺失 fail closed；离线 fixture 可复现 |
| S-05 | 1 | 自建 Collector 作业调度、资源预算/限速/熔断、证据存档与质量日报 | 超预算无网络请求；AccessGuard 强制检查；Worker 崩溃不影响 API/Web；无第三方代抓取 |
| S-23 | 1 | Collector 独立进程/主机及生产依赖审计 | 启动无需外部 Actor/API；停机不影响 Web/API；网络出口清单证实 0 第三方代抓取调用 |
| S-24 | 1 | 采集运行与权限快照表、Parser 回归/灰度 | `collector_runs/circuits/health/configs` 可迁移；许可过期/401/403/挑战触发停止，不进行规避 |
| S-06 | 2 | 全局属性抽取与 R-01/R-02/R-05/R-06/R-07/R-08/R-09/R-10 | 每规则正反单测、版本化和保留原始证据 |
| S-07 | 2 | 查询级匹配 R-03、离群诊断 R-04、query_comparables | 同一 listing PSA 9 与 PSA 10 结果不同；强属性错配排除、解释可复算 |
| S-08 | 2 | 统计引擎及第 7 章真实 fixture | 以整数分精确复现 median/type7/trim；小样本、未知议价及运费缺失单测 |
| S-09 | 2 | 质量报告、coverage 与楔子类目盲测 | Precision/Recall/价格误差报告和抽样 CI；不输出未经校准分数 |
| S-10 | 3 | 账户全链路：注册、验证、登录、密码重置、删除及 MFA 后台 | 安全回归、速率/反滥用、账户隔离、隐私流程通过 |
| S-11 | 3 | API key：创建、作用域、吊销、轮换 | 哈希仅存、密钥仅创建展示、撤销 60s 失效、越权 403 |
| S-12 | 3 | 余额桶、credits 账本、billing_charges | 10/100 并发查询不出现负数和双扣；跨期、补偿、退款和按量包测试通过 |
| S-13 | 3 | 查询执行/缓存/异步工作流及 source budgets | 同 canonical query 10 分钟只扣一次；202/200/错误/作业重试状态机全覆盖 |
| S-14 | 3 | REST 端点与 OpenAPI 3.1 契约 | 价格为 `*_cents`、错误码正确、`GET /v1/jobs`、权限与资源授权测试通过 |
| S-25 | 3 | 断源数据状态与 API 降级契约 | `fresh/stale_acceptable/expired/forbidden` 全链路，≤72h `allow_stale` 免扣，超过窗口 503 免扣，状态页可读 |
| S-15 | 3 | Stripe主支付与PayPal补充接入；Creem/Dodo备用资格验证 | 产品审核记录、沙盒 webhook 乱序/重放、生产小额对账、无权益重复发放 |
| S-16 | 4 | 匿名额度、预缓存查询、每日预算与隐私防滥用 | 匿名不能触发未获许可新请求；预算和 IP/cookie 隐私测试 |
| S-17 | 4 | 首页、结果、价格/质量解释和剔除重算 | 移动端 3 步查询；用户重算不改 server snapshot；低样本不展示中位值 |
| S-18 | 4 | 账户后台及定价/账本页面 | 分桶余额、单次收费、过期时间、账本追溯与官网价格同源 |
| S-19 | 4 | 类目/单品页、sitemap、指南、方法及投诉页 | 10–20 页真实数据+独立解释；无价值/过期页 noindex；文案法务检查 |
| S-20 | 4 | 分享与隐私权限 | share token 到期/撤销、安全脱敏、不能查看别人的完整 result |
| S-21 | 5 | MCP、llms.txt、SKILL.md、开发者文档 | 两主流客户端、余额不足、排队、10 分钟重试与 REST 计费一致 |
| S-22 | 5 | 监控、告警、runbooks、恢复与全量验收 | Collector 停机 0/24/48/72h 演练、数据权利撤销、账本恢复一致、支付/许可事故模拟、第 2 章门禁逐条签字 |

| S-26 | 5 | 上游完全断开演练与恢复幂等 | 0/24/48/72h 模拟中 API/Web/计费管理持续运行；恢复后无重复成交/双扣且数据质量复核通过 |
| S-27 | 5 | 自研 Collector 毛利/维护压力验收 | 10,000 查询额满/30% 缓存/多页长尾压力模型；真实许可、计算、存储和维护费纳入；满足第 12 章 GO 门 |

**旧任务迁移说明**：v1.2 S-06/S-07 重复统计工作合并进 v1.4 S-08；旧 S-13（匿名额度/预算）必须在 v1.4 S-17 免费 UI 之前完成（新版 S-16）；旧 S-02 拆成新版 S-02/S-03；旧 S-08 拆成 S-12/S-13/S-14；旧 S-09 变成 S-15。对既有代码仓库接手时，应通过 ADR 把旧 issue ID 映射到新版，不允许直接以同编号覆盖无关任务。

**独立审查门**：每阶段有非实现者的 review 记录（可以是独立 agent 但其结果必须附实际命令输出和人工抽样）；高风险财务与来源许可的审核不能只由代码 Agent 自我确认。未满足明确证据保持 `NOT_READY`，不得将计划完成当作生产完成。

**自研采集开发锁**：S-02、S-04、S-05、S-23、S-24 在第 1 阶段全部通过才可投入正式数据/质量阶段；S-25 是第 3 阶段的 API 门；S-26、S-27 与 S-22 一起构成收费发布门。任何代码审查发现 Actor/第三方代抓取在线依赖即阻断 PR，不能以“临时备用”豁免。

## 15. 风险登记、停项条件与 Plan B

| 风险 ID | 风险 | 级别 | 应对与停止条件 |
| --- | --- | --- | --- |
| RK-1 | eBay 自建采集访问许可/商业再分发权不足 | **极高** | 第 0 步硬门；没有明确允许自建网络采集及商业化的权利链 **NO-GO**；不得靠账号/代理/代抓取绕过 |
| RK-2 | 上游访问终止、存档权利到期、采集停机 | 极高 | 自建 Collector 熔断 + 有权快照分级降级；断源演练；不可继续分发时下线相应数据，停止受影响收费能力 |
| RK-3 | 实际成交价无法核验（Best Offer） | 高 | 默认不纳入中位数；明示价格核验率；若核心类目价样本稀缺，不发布该类目 |
| RK-4 | 同 listing 多次成交/分页截断导致销量失真 | 高 | `sale_events` 身份与 coverage；仅输出 observed sales，禁止用样本量冒充真实销量 |
| RK-5 | 成本高、长尾用户冲垮订阅毛利 | 高 | 第 12 章高用量压力场景，失控则调公开套餐或暂停新实时供数 |
| RK-6 | CompSniper/SoldComps 等竞争及免费替代 | 高 | 盲测证明楔子类目精准匹配、证据解释和可靠契约；无差异不扩营销 |
| RK-7 | 收款审核与争议 | 中高 | 双候选平台独立审核，清楚描述数据权利；无可接受收款通道不收费 |
| RK-8 | 单人维护过载 | 中 | 4 周内运维人时持续 >60% 则冻结新功能，改进监控自动化或减类目 |
| RK-9 | 计费事故/越权 | 高 | 可重复演练并发扣费、退款、webhook 乱序与分享隔离；异常自动暂停扣费 |
| RK-10 | SEO 无独立价值、内容被判低质 | 中 | 首发少量有解释的真实内容页，效果验证后再规模化 |
| RK-11 | 质量指标“可信分”被误解为价格保证 | 中高 | V1 不给未经校准的单一 0–100 评分；显示分项、局限与人工更正渠道 |

| RK-12 | 第三方 Actor/代抓取 SDK 偷偷进入生产依赖 | 极高 | CI 锁生产依赖 + 出口审计 + billing 账单抽检；发现即阻断/停用，代码移除后重验 |
| RK-13 | 自研 Collector 维护成本、源页面变更和稳定性恶化 | 高 | 源结构 golden fixtures、每日健康/成本报表、解析器版本化、质量灰度；无法恢复即数据降级而非盲目返回错误价 |
| RK-14 | “网站不停”被误解为“实时数据不停” | 高 | 页面/API 分级展示最后观测时间与 `freshness_state`，不在断源时对外宣传实时价格 |

**退出与转型方案（不是生产数据抓取备胎）**：如果无法取得 eBay 自建采集许可或自研方案经济上不可行，本项目保持 NO-GO；以下方案属于经创始人重新批准的**业务转型**，不得悄悄接入现有 SoldBench V1 在线供数。

| 方案 | 条件与价值 | 限制 |
| --- | --- | --- |
| B-1 授权数据供应商业务重定位 | 若创始人愿意从“纯自研采集”目标转型为许可数据分销商，另立项目与新 GO 门 | **不作为当前生产备份或自动切换路径**；变更必须单独书面批准和重新核算定价 |
| B-2 用户自有/授权数据计算服务 | 用户提交有合法使用权的数据，SoldBench 提供匹配与统计 | 仅在约定客户范围内使用，不能擅自汇总后对外查询 |
| B-3 转为纯自有计算引擎部署 | 只向客户有权提供的数据集提供清洗/匹配/统计引擎，不收集通用市场数据 | 改定位与收费，不把客户数据混成公开售出库 |
| B-4 更换目标市场 | Mercari/Poshmark 等逐个重新评估市场需求与来源权利 | 各市场单独遵守第 0 步，不能把新市场当作自动合规 |
| B-5 暂停产品并保留代码资产 | eBay 自建采集缺权利或无法稳定运行时保留自有 matcher/statistics/前端 | 停止营销/实时服务承诺，等待条件变化；不采用隐蔽第三方抓取替代 |

**明确 NO-GO**：无法获得**自建自动采集所需的 eBay 访问许可**或再分发权利、依赖第三方 Actor 才能持续供数、断源 E2E 未通过、没有可获批上线的收款路径、数据可靠度不足且无法改善、满额客户显著负毛利且无法合理调价，或缺少持续付费意愿。NO-GO 的处理为停止/重新设计商业模式并更新新版本，而不是直接绕开禁令启动 V1。

## 16. 获客计划（上线后的前 90 天）

**起算点**：首发有合法稳定数据源、真实可用免费工具及符合质量门的楔子类目之日；不能在“第 0 步尚未 GO”的情况下承诺公开 SEO 页或引用未获许可的成交数据。目标渠道仍为 SEO + 开发者生态 + 社区，暂不投付费广告。

| 意图 | 关键词示例 | 页面/内容 |
| --- | --- | --- |
| 工具 | ebay sold listing price checker、sold price lookup、what did it sell for | 免费查价首页，提供足够真实的可查示例 |
| 精准型号 | `<item> <grade> sold prices`、`<model> resale value` | 楔子类目与具体版本/评级说明页 |
| 方法 | how to find ebay sold prices、understanding best offer prices | 原创指南 + 真实价格可信度解释 |
| 对比 | terapeak alternative、sold comps api comparison | 有日期和同口径对照的对比页 |
| 开发者 | sold comps api、resale pricing api、sold comps mcp | Quickstart、OpenAPI、MCP 文档和示例应用 |

| 期间 | 行动 |
| --- | --- |
| 上线 1–30 天 | 发布 10–20 个高质量楔子类目/单品页、2 篇原创方法指南和开发者文档；与试点客户完成网页研究及真实 API 集成，分别记录从首次查询到取得可用结果的全过程 |
| 上线 31–60 天 | 用 Search Console 观察被索引/有实际点击的页面与关键词；补 4–6 篇客户真实问题指南；社区答疑，不复制粘贴广告 |
| 上线 61–90 天 | 依据真实收录/注册/转化扩大至最多 30–50 个有独立价值的页面；验证 1–2 个 SDK/集成案例；不以自动生成 100 页为目标 |

| KPI | 90 天建议目标 | 解释 |
| --- | --- | --- |
| 目标客户试用 | ≥10 个真实目标账户（含第 0 步延续） | 分别看网页查价/研究的复用、API集成复用及专业数据需求验证，拒绝无意向注册充数 |
| 免费工具可用查询率 | 有数据源的推荐示例 ≥95% | 仅测可用示例，不冒充长尾真实覆盖 |
| 访问 → 注册 | 目标 4%，低于 2% 查免费工具体验 | 建议实验目标，不当成已验证行业基准 |
| 注册 → 付费 | 目标 3%，但以真实使用后的付费意愿优先 | 按来源流量和首发类目分组 |
| 付费用户 30 天留存 | 目标 ≥70% | 数据质量、响应时间、价格和信任为主要原因分析 |
| 真实搜索索引 | 跟踪有效收录页的点击与转化，不设强制 120 页 | 不制造无数据或近重复模板页 |
| 毛利/供数成本 | 每周查看 Pro 重度用户与免费层资源消耗 | 从第一天就保护真实单位经济 |

**增长纪律**：所有 SEO 页面数据必须有可公开的来源使用权、时间、质量/覆盖解释；凡使用竞争对比价格/功能，标注核查日期，不把他人宣传页的数据当成自己验证的效果。若 SEO 无法带来有意向的卖家、交易商、商家及数据/API客户，先按客户群检查楔子、网页研究与集成场景，不先扩大内容数量。

## 附录 A. 竞品基准与核查纪律（2026-11-14）

以下保留 v1.2 的竞品框架，但把**官方网站营销描述、第三方推断、独立实测**严格区分。旧版价格尤其是 SoldComps 多站/多版本的 requests 与 credits 口径不能混成一组，**不以该表自动触发代码定价**；正式定价前必须人工逐页截图存档并记录日期。

| 竞争者 | v1.2 收录的参考信息（需复核） | SoldBench 应比较的真实维度 |
| --- | --- | --- |
| CompSniper | 曾宣传 Free 100/月、$9/2000、$29/10000、较广市场覆盖、较长历史与 MCP | 同参数 API 每有效请求价格、上限、真实价格验证率、匹配 Precision/Recall、数据新鲜度 |
| SoldComps | v1.2 的 `credits` 新版与旧请求制数字并存，且不同站点公开标价可能不一致 | 明确对比 URL、产品版本、计费单位/返回条数/时间窗口；不能用 50,000 credits 直接对比 50,000 queries |
| Soldgraph | 宣传多市场聚合 | 各市场是否提供真实成交价、具体条款、覆盖范围和 API 证据 |
| Apify actors（仅竞争观察） | 第三方代抓取服务，**SoldBench V1 生产禁用** | 仅用于理解市场收费，不得作为自研采集成功、合法性或成本门通过证据 |
| eBay Product Research（旧称 Terapeak） | eBay 官方面向用户的成交研究工具 | 官方可展示数据与**开发者可再分发权**完全不同；不可仅因网页可见就用于 API 售卖 |
| 130point | 免费查价/Best Offer 研究 | 价格可信度、许可来源、是否确有可比的 API 和规模化供数 |
| PriceCharting / ZIK Analytics | 品类价格指南/卖家研究套件 | 不直接按“调用数”比较，考察目标客户使用场景是否相同 |

**每季度保存**：`competitor_name, product_url, checked_at, price, currency, request_or_credit_definition, limit, history, marketplaces, verified_claim_or_marketing, evidence, tester`。竞品页面数据并非同日获取时不得在首页标成实时对比。

**禁止**：未经授权转售竞品 API 数据；将对手的“官方授权”“Best Offer 准确价”“完整历史”等宣传直接当作 SoldBench 的事实基础；用未知或已过时的竞争价证明自身套餐便宜。

## 附录 B. 术语表（v1.4）

| 术语 | 定义 |
| --- | --- |
| comp | 某次查询中符合属性要求的可比售出事件；并非一条商品刊登天然可比所有查询 |
| listing | 来源平台的商品刊登；可能多次被观测，不一定代表唯一一次成交 |
| sale event | 有来源证据的一笔售出事件；事件身份未知时不得假设成交次数 |
| source observation | 某次有权访问的数据源响应或记录观察，需记录时点、准入和保留范围 |
| source clearance | 商业获取、存储、公开/统计/再分发权限的准入决策及书面依据 |

| owned Collector | SoldBench 自行编写、部署、调度、解析、存档并运维的数据采集程序；不等于自动拥有平台访问权 |
| Collector circuit | 自研采集停止/探针/恢复的受控状态；法律/访问拒绝后不自动绕过 |
| freshness_state | fresh / stale_acceptable / expired / forbidden / never_observed；与来源观测更新时点和许可状态共同决定 |
| scraping-as-a-service | 按请求/结果代用户抓取的第三方 Actor/API；本版生产不得依赖 |
| Comparable Precision | 被保留为可比的记录中实际上符合查询条件的比例（人工金标） |
| Comparable Recall | 所有应纳入可比的真实候选记录中最终保留下来的比例（需有可复核候选全集） |
| price status | `verified_actual` / `displayed_only` / `unknown`，实际成交价与刊登展示价严格分离 |
| Best Offer | eBay 议价成交；普通显示价可能不等于实际成交价 |
| observed sales | 已获得并核验的成交事件样本数；不是全部市场成交量 |
| coverage status | 完整/部分/未知，严格限定数据来源、类别和时间窗口 |
| p25 / p75 | 已核验可比实际价格样本的第 25/75 百分位数，Type 7 线性插值 |
| credit | V1 每次成功且 ≥8 条已核验价格样本的标准查询消耗 1 credit；limit 可至 200 |
| wallet bucket | 订阅当期额度/购买永久额度/促销额度彼此独立的余额分组 |
| MoR | Merchant of Record，收款平台的具体责任以合同和适用地域为准 |
| 楔子类目 | 第 0 步的质量与商业测试最有优势、首发主推的一个细分类目 |
| MCP | Model Context Protocol，在本产品中共享 REST 查询鉴权和计费体系 |
| SSR | 服务端渲染；不自动保证 SEO 收录或内容品质 |
| data_as_of | 支撑响应的来源观测时点；不同于成交当天日期 |
| billing_policy_version | 信用点扣费、额度桶及退款规则的固定可追踪版本 |

## 附录 C. 环境变量、密钥与运行配置

```dotenv
# 基础
NODE_ENV=production
API_PUBLIC_BASE_URL=https://api.soldbench.com  # 目标origin，路径自身含/v1；部署时配置
WEB_PUBLIC_BASE_URL=https://soldbench.com    # 已注册，DNS/TLS与服务器待部署时配置
MCP_PUBLIC_URL=https://soldbench.com/mcp
SUPPORT_EMAIL=support@soldbench.com
DATABASE_URL=postgres://...
REDIS_URL=redis://...
S3_ENDPOINT=...                       # 仅获许可、允许保存的原始数据
S3_BUCKET_RAW=raw-observations
S3_BUCKET_BACKUP=backups

# 版本与统一定价源
WEDGE_CATEGORY=cards_graded
ENGINE_VERSION=1.4.0
CLEANER_VERSION=1.4.0
BILLING_POLICY_VERSION=1.4.0
# 价格、额度、限流全部由 packages/shared/pricing.ts 统一导出并绑定版本

# 自建 Collector / 合规准入
SOURCE_CLEARANCE_REQUIRED=true
SOURCE_REGISTRY_TABLE=source_clearances
SOURCE_ALLOWED_ONLY=true

COLLECTOR_ENABLED=false               # 没有明确网络采集许可不得改为 true
COLLECTOR_MODE=offline_fixture           # approved_http | approved_browser | offline_fixture
COLLECTOR_EXTERNAL_ACTOR_ALLOWED=false   # 禁止代抓取服务生产接入
COLLECTOR_FETCH_CONCURRENCY=1           # 候选值，必须低于被批准上限
COLLECTOR_MAX_PAGES_PER_JOB=5           # 候选值，许可+测试决定
COLLECTOR_MAX_BYTES_PER_JOB=20000000    # 候选保护阈值，按实测调整
COLLECTOR_CIRCUIT_FAIL_CLOSED=true
COLLECTOR_KILL_SWITCH_ENABLED=true
COLLECTOR_OUTAGE_DRILL_MODE=false        # 仅 staging/test 可开启
COLLECTOR_SOURCE_STATUS_POLL_SECONDS=60
DATA_FRESH_MAX_AGE_HOURS=24             # 候选类目默认，需第 0 步签字
DATA_STALE_MAX_AGE_HOURS=72             # V1 默认允许陈旧窗口上限
DATA_EXPIRED_CURRENT_QUERY_STATUS=503
# 若获批准的访问方式包含凭证，全部密钥管理；不记录登录 cookie/令牌，也不允许它们绕过许可
RAW_STORAGE_REQUIRE_CLEARANCE=true
DATA_RETENTION_POLICY=strict_source_permissions

# 查询、缓存、额度
ANON_DAILY_LIMIT=5                   # 仅已准入缓存
COLLECTOR_DAILY_NETWORK_JOB_BUDGET=300 # 首发候选，仅在合法准入范围内启用
JOB_TTL_HOURS=24
QUERY_REUSE_WINDOW_SECONDS=600
SOLD_RESULT_DEFAULT_LIMIT=50
SOLD_RESULT_MAX_LIMIT=200
SOLD_MIN_VERIFIED_SAMPLE=8
DEFAULT_PRICE_BASIS=item_plus_observed_shipping
BILLING_SAME_PRICE_FOR_CACHE=true

# 收款（仅在审核通过的通道启用）
PADDLE_API_KEY=__SECRET_MANAGER__
PADDLE_WEBHOOK_SECRET=__SECRET_MANAGER__
DODO_API_KEY=__SECRET_MANAGER__
DODO_WEBHOOK_SECRET=__SECRET_MANAGER__

# 可观测
LOG_LEVEL=info
ALERT_WEBHOOK_URL=__SECRET_MANAGER__
SENTRY_DSN=
```

**配置红线**：生产启动时校验 `SOURCE_CLEARANCE_REQUIRED=true`、价格/版本/套餐唯一配置、数据库迁移版本和来源许可有效状态。`SOURCE_ALLOWED_ONLY` 不能被环境变量切换为 `false` 来跳过合规门。敏感日志按 tenant、请求、来源 hash 追踪，不记录 cookie/session/password/key 明文。配置上的 `$9/$29` 与 credits 若未经 v1.4 商业 GO，则前端先以测试环境展示，不公开收费。

## 附录 D. 测试策略、黄金样本与质量验收

| 层 | 测试要求 | 发布阻断 |
| --- | --- | --- |
| 来源权利 | 每源 `source_clearance` 有效性、各字段再分发权限、retention 删除、被撤销后缓存/公开页下线回归 | 任何未经准入数据不得进入生产 API |

| 自建采集独立性 | CI 依赖、容器镜像、网络出口审计：无 Actor/代抓取 SaaS 生产服务；Collector/Worker 可独立自托管重建 | 任何按结果第三方抓取服务或隐藏网络依赖阻断 |
| 采集授权与禁绕过 | 缺少许可 0 网络请求；401/403/验证码/登录墙/终止通知触发熔断、禁用与审计 | 自动绕过访问限制、自动切换账号/出口的修复路径阻断 |
| Collector 故障隔离 | 停 Collector、关闭其主机、阻断上游，API/Web/用户/账单状态连续运行 | 断源导致页面/API 基础功能 500/崩溃则阻断 |
| fresh/stale/expired 契约 | 0/24/48/72h 逐状态演练；超期不返回当前价格，允许 stale 的结果不扣费，恢复后回放去重 | 假实时、无时间戳、旧数据错误收费、恢复重复事件阻断 |
| 解析与实体 | listing vs sale event、未知 event key、重复观察/多次售出、日期精度、运费缺失、来源换币精度 | 错把观察次数当销量或未知实际价当实际价则阻断 |
| 匹配清洗 | R-01…R-10 正反样本、同 listing PSA 9 与 PSA 10、强属性版本、大小/年份/评级、离群误杀 | 上线楔子类目 Precision 目标 ≥92%、Recall 目标 ≥85%，并报告 95% CI；超误差门阻断 |
| 统计纯函数 | 金额整数分、Type7 分位、截尾 5%、空样本、n<8、未知覆盖、未核验 B/O、复算候选 hash | 与固定逐条 fixture 的每个输出字段精确一致；不得使用合成数字绕过测试 |
| 价格误差 | 对独立且同价格口径、同日期窗口、同属性的参考结果做盲测 | 对符合样本要求的测试查询，中位价偏差目标 ≤6%，披露不可比较项；不得用样本量掩盖偏差 |
| 召回测试 | 人工独立建立候选真值；以每查询来源可见候选集为分母，不假设市场完整 | 单报告同时提交 Precision/Recall/漏删原因和样本量 |
| API 契约 | OpenAPI 同源，200/202/低样本/错误码、权限与 share token、curl/TS/MCP 三入口 | 任何不一致阻断 |
| 计费 | 1 credit/有效查询，不因 limit=200 收取 4 次；同规范参数 10 分钟复用；100 并发、回放、跨期、退款、Webhook 乱序和失败恢复 | 负余额、多扣、重复 grant 或账本不平即阻断 |
| 性能 | 缓存 P95 ≤800ms，允许实时请求 P95 ≤15s，长任务 202；结果页 4G LCP ≤2.5s | 记录环境和真实百分位，不许只报告平均值 |
| 安全隐私 | Key 哈希/吊销 60s、tenant 越权、匿名限额、cookie/IP 处理、删除与恢复演练 | 可读取他人查询、分享账单、暴露原始秘密即阻断 |
| E2E | 匿名缓存查价、注册后查价、API key、用量后台、支付升级、异步排队、MCP 查价、来源撤销 | 关键路径失败阻断收费发布 |

**抽样与统计纪律**：原 v1.2 的 600 条（六类 ×100）是第一轮探索回归集，不是显著性已足够的最终生产保证。需要按来源/查询头尾/具体属性分层加样；Precision/Recall 附上 Wilson 或可解释的置信区间，保留所有标注分歧及最终仲裁。只统计“已保留条目错配率”会忽略被误删的正确 comp，因此 Recall 必须同时评估。

**黄金数据 fixture**：`packages/core/test/fixtures/v14_gameboy_58_verified.json`（由原版合成样本复制重命名，具体文件以交付附件为准）包含 121 个候选观测、64 条可比，其中 58 条已核验价格、6 条未核验，58 条价格逐项能用本章 Type7 计算到第 7.3 节及第 9 章一致的结果；最少同时记录销售时间（35 条落 30 天内）和 sale format（54 fixed-price、4 verified best-offer）。数据为人为构造，不能用于对外 SEO/广告。

**强制金额与账本断言**：

```text
assert(stats.n_comparable == stats.n_price_verified + stats.n_excluded_unverified_price)
assert(credits_charged in [0, 1])                     # 标准单查询
assert(limit in range(1, 201))
assert(no_charge_if(query_status in ['queued', 'running', 'failed', 'expired']))
assert(no_charge_if(stats.n_price_verified < 8))
assert(balance_in_every_wallet >= 0)
assert(at_most_one_charge_per_query_id)
assert(total_credits_consumed == sum(successful_unique_query_charges))
assert(quality.score is None)                         # V1 未完成校准
assert(archive_coverage is None if coverage_unknown else 0 <= archive_coverage <= 1)
```

**黄金数据完整价格多重集合（单位 cents）**：`2900×1, 3000×12, 3001×1, 4200×2, 5450×11, 5470×1, 5800×2, 5999×1, 6800×10, 7600×3, 8500×12, 10000×1, 10800×1`，合计 58 个。按升序，索引 14/15=4200、28/29=5800、42/43=7600；去掉首尾各 2 个后 54 条均值正好 5930。35 条成交日期在最近 30 天，23 条在更早但仍处于 90 天窗口内；另外添加 6 条展示价不可核验的可比记录和 57 条硬属性错配记录。这样可在没有外部 fixture 文件时独立复现第 7/9 章算例；任何测试输出不一致必须修正文档和 fixture，而不是忽略。

## 附录 E. 待创始人拍板及默认决策（v1.4）

**默认建议≠法律授权，也≠商业 GO。** 所有 P0 项有书面结论才能收费发布，其中带 `*` 的项目在**第 0 步任何线上采集/阶段 1 开发前**必须由创始人及所需专业方确认；不得由 Agent 代替批准。

| ID | 事项 | 级别 | v1.4 默认/决策门 |
| --- | --- | --- | --- |
| E-01 | 正式品牌及域名 | P0（上线前） | **SoldBench** 为当前定版工作品牌/代码名 `soldbench`；`soldbench.com` 拟用，须由创始人确认注册、DNS 控制和近似商标核查后才能配置生产 URL |
| E-02 | 探索期验证预算 | P0 | 旧 $200 仅覆盖小额技术实验，不含合规数据授权/律师/收款费用；超支创始人批准 |
| E-03* | 数据权利法律评估 | **P0** | 美国平台/数据许可律师书面确认逐个来源的允许行为、衍生数据和 API 再分发；无结论不能上线对应源 |
| E-04 | 六组类目排序 | P1 | 默认评级卡牌优先；其余球鞋、手表、电子游戏、GPU、收藏杂项是候选，未达门不发布 |
| E-05* | 收款通道与主体资格 | **P0** | Creem/Dodo优先核验、Paddle备选；Stripe需求待真实资格，PayPal补充评估。逐家如实审核，不把待审、已注册或可付款等同产品/出款通过 |
| E-06 | 第二市场 | P1 | 默认 Mercari 优先调研，但必须有独立来源权利与需求/成本门 |
| E-07 | $79 套餐 | P2 | V1 不设；上线后按真实高利用率/毛利/大客户咨询再决定 |
| E-08 | 多语言 | P0 | 2026-11-16用户确认V1英语＋简体中文，其他语言按需求扩展；DEC-12及多语言专项约束完整流程和验收 |
| E-09* | 首发楔子类目 | **P0** | 默认评级卡牌；第 0 步盲测匹配/价格核验与付费需求共同决定 |
| E-10 | 标准 credit 定义 | **P0** | **一次成功且 ≥8 条可核验价格样本的查询扣 1 credit**，至多返回 200；不按 `ceil(n/50)` |
| E-11* | 第 0 步法律/商业双验证 | **P0** | 合法自建访问及商业再分发、收款、自研 14 天稳定/经济、访谈需求、断源独立性全部通过才 GO |
| E-12 | 匿名/实时预算 | P1 | 未登录 5 次/日，只用缓存；全站每日实时获许可数据请求预算初值 300，实测调整 |
| E-13 | 年付、大客户 | P2 | 上线 3 个月复盘；不可在 V1 先卖未来功能 |
| E-14 | 异步任务有效期 | P1 | 默认 24 小时，排队及失败不收费；需要任务过期/重试 UI |
| E-15 | 余额桶优先级 | **P0** | 默认对有期限的 promo/subscription 按最早到期优先（同日 subscription 优先）→ 永不过期 purchased；对外明示，调整时升级 billing_policy_version |
| E-16* | 来源保留与权利撤销 | **P0** | 每源分别设保留、可公开字段和终止清除流程；不默认永久留原始 HTML |
| E-17 | 质量评分公开策略 | **P0** | V1 `quality.score=null`，先发布可解释分项与样本警告；校准后另定版 |
| E-18 | 小批量 API 是否提前 | P1 | 需第 0 步客户试点证据及毛利证明，默认 V1.5；无 CSV UI |
| E-19* | 满额 Pro 毛利门 | **P0** | 候选 ≥50% 边际毛利；第 0 步数据不够时先调公开权益/价格并复验，不得静默另计 comp 费 |
| E-20 | SEO 首发页面数量 | P1 | 10–20 个高质量、有权公开、有统计解释的页面；不硬设 120 收录目标 |

| E-21* | **自建 Collector 是唯一生产采集方式** | **P0** | 核心调度/获取/解析/缓存数据管道 100% 自研自托管；Apify/Actor/第三方代抓取 API 禁止生产依赖，不能用临时 fallback 例外 |
| E-22* | eBay 网络自动采集的明确访问许可 | **P0** | 如 eBay 要求事先明确许可，未获得前 Collector 默认禁联网；律师意见不能代替许可；无法取得则 NO-GO |
| E-23 | 断源数据新鲜度与收费策略 | **P0** | 候选 fresh≤24h、stale≤72h、超过 72h 当前查询不可用；stale 显示需 `allow_stale` 且不收费，权利撤销无条件不展示 |
| E-24* | 上游彻底断开 0/24/48/72h 验收 | **P0** | API/Web 账户/账单等继续运行、历史数据只在权利允许与时限内展示；恢复去重、无双扣，方可收费上线 |
| E-25 | 域名与品牌源文件迁移 | P0 | 仓库/包/容器/配置/SEO metadata 全面 SoldBench 化；旧品牌不得出现；域名控制权确认前保留模板 URL |

**决策记录**：每项拍板后在 `docs/adr/ADR-<ID>.md` 记录日期、决策人、证据、影响字段/接口/套餐、回滚。表中已明确的普通默认事项可由开发 Agent 执行并标注，带 `*` 项仅供准备，不代表可自行批准。

**执行起点**：先完成 E-03、E-05、E-09、E-11、E-16、E-19、**E-21、E-22、E-24** 的证据和签字；仅按第 3 章允许的方式验证自研 Collector 14 天与断源演练。`step0/verdict.md=GO` 前不启动 S-01 及之后产品开发。

## 附录 F. 外部规范与核查来源（2026-11-14）

以下为 v1.4 修订时用于核查关键风险/工程限制的**公开原始出处**。链接不自动代表获得平台商业授权；对手的价格/功能仍需按附录 A 保存带日期截图并逐项验证。

1. **eBay User Agreement（访问与商业化限制）**：<https://www.ebay.com/help/policies/member-behavior-policies/user-agreement?id=5414>。重点关注自动化采集、技术措施绕行与信息商业化需取得许可的条款。实际适用版本和法域由律师核对。
2. **PostgreSQL 16 Table Partitioning（UNIQUE/PK 约束）**：<https://www.postgresql.org/docs/16/ddl-partitioning.html>。声明式分区的唯一/主键约束必须包含分区键，故 v1.4 暂不用 `sold_at` 月分区。
3. **Google Search Central Spam Policies（Scaled content abuse）**：<https://developers.google.com/search/docs/essentials/spam-policies>。批量生成无独立价值的页面可能构成规模化内容滥用，故首发质量优先。
4. **竞争者及服务费**：定价、免费层、API、限额、MCP、历史深度属于动态事实；本版不把 v1.2 表中的价格/市场声称作为已核验事实。请在商业 GO 前由责任人更新附录 A 的链接、截图和时间戳。

5. **eBay site interference policy（爬取到其他站点的限制）**：<https://www.ebay.com/help/policies/member-behaviour-policies/site-interference-policy?id=4371>。本文因此要求自建程序先取得相应访问依据，不能以工具所有权替代权限。
6. **生产自研与停机准则**：SoldBench 的内部技术决策（ADR-08/09/10），并非任何外部供应商的可用性承诺。

**维护**：每次重大平台条款/许可、API/统计口径或定价变更，应同步更新本附录核查时间与 ADR。本文是工程规格与风险控制文件，不代替律师意见、支付平台批准或真实数据源授权。


2026-11-16支付执行补充：用户账户与最新候选、Stripe资格路径及现有OpenAPI渠道缺口，见 [收款渠道评估与接入路线](docs/收款渠道评估与接入路线_20261116.md)。原Paddle/Dodo接口不是多渠道已实现证据；选型后先补对应DTO/事件/验收再编码。

2026-11-16最终支付决策：Stripe先接入作为主支付，PayPal纳入补充接入；Creem、Dodo先核验已有账户/申请资格作为备用，Paddle不在当前开发范围。执行以 [Stripe与PayPal接入规格](docs/Stripe与PayPal接入规格.md) 为准，替换本文件及评估稿早先候选优先级。OpenAPI1.3.0已补目标契约，不代表已有生产接入或账户批准。

运行交付补充：2026-11-17查询、账本、owner主图读取的离线契约见[查询账本与交付实施契约](docs/查询账本与交付实施契约.md)。收费标准和真实准入不变，历史快照不自动升级计算版本。
