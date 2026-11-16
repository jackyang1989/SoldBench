# SoldBench

目标地址：网站 `https://soldbench.com`，REST API `https://api.soldbench.com/v1`，开发者文档 `https://soldbench.com/docs`，MCP `https://soldbench.com/mcp`，客服 `support@soldbench.com`。这些是正式部署目标；服务器、DNS/TLS和邮件配置待开发后实施。

面向个人卖家、收藏品交易商、二手商家、开发者、SaaS 企业和专业数据使用者的成交研究与定价参考产品。网页提供直接查价与研究体验，REST API 支持程序集成，MCP 支持 Agent 工作流，三者共享数据、匹配、统计和计费规则。生产数据由自研、自托管 Collector 在明确许可范围内获取。首发默认评级卡牌，最终由第 0 步验证确定；Game Boy 文件是统计合成夹具，不代表首发类目或真实成交证据。

## 当前状态（2026-11-16）

用户已明确授权先做完整离线产品工程；按 [ADR-13](docs/adr/ADR-13.md) 在真实来源许可前只使用synthetic/fixtures，禁止网络采集、真实支付和生产部署。第一工程整包TASK-011/012/013/019/020正在开发及审查：当前有monorepo、PG16迁移、查询/统计核心、SSR/API开发壳、双语消息、图片处理原型与许可预检，但**没有真实eBay供数、没有完整账户/收费/Search API/Dashboard/MCP，也没有CompSniper生产端到端功能对等**。OpenAPI含50个操作是设计契约，不代表50个operation已有服务实现。详细交接见 [Agent接手指南](docs/Agent接手指南.md)、当前唯一任务状态见 [排期台账](docs/开发排期与任务台账.md)。原始输入为 [v1.4规格](<SoldBench 开发规格书 v1.4.md>) 和 [合成夹具](v14_gameboy_58_verified.json)。

## 阅读入口

支付最终方案为Stripe主支付＋PayPal补充，Creem/Dodo备用资格验证；目标契约与实施要求见 [支付接入规格](docs/Stripe与PayPal接入规格.md)，实际账户批准及产品实现尚未完成。

收款个人资格、Creem/Dodo比较、Stripe与PayPal路线及待审核项见 [收款渠道评估](docs/收款渠道评估与接入路线_20261116.md)。

商业开工判断见 [开发前缺口审查](docs/商业系统开发前缺口审查.md)。首发英语＋简体中文，界面、邮件、格式、错误与验收规则见 [多语言与商业交付补充规格](docs/多语言与商业交付补充规格.md)。

国际扩展与命名讨论见 [国际站点规划与品牌评估](docs/国际站点规划与品牌评估_20261116.md)：逐站评审英国、德国等后续覆盖，区分国家站点与新增平台；当前未批准扩充V1或更名。

本次开工判定见 [开发就绪检查](docs/开发就绪检查.md)，区分已经冻结的规则与必须取得的实测/外部证据。

竞品补齐开发基线见[竞品能力实施规格与路线图](docs/竞品能力实施规格与路线图.md)：24组能力进入56个任务，首发203人日、后续116人日（总工作量，非剩余工期）。所有状态仅以任务台账为准。

新Agent建议先阅读 [Agent接手指南](docs/Agent接手指南.md)，了解六类客户、权威文件、当前代码与下一包入口；状态只以台账为准。

最新市场判断见 [竞品核查与差异化建议](docs/竞品核查与差异化建议_20261116.md)：统计、清洗和MCP已经是竞争基线，优势须靠细分类目的严格匹配、合格样本和实际工作流验证；该研究不自动修改V1范围或AT门。

1. [AGENTS.md](AGENTS.md)：工程规则、阶段权限和接手步骤。
2. [原始产品规格 v1.4](<SoldBench 开发规格书 v1.4.md>)：产品范围、统计与计费基线，已同步ADR-12勘误；原始副本在docs/baselines。
3. [采集稳定性专项规格](docs/采集稳定性专项规格.md)：先核实eBay已售与实际成交价可得性、14天线上门及恢复指标。
4. [项目审查与优化建议](docs/项目审查与优化建议.md)：缺口、冲突、优化优先级。
5. [功能与页面规格](docs/功能与页面规格.md)：逐页输入、动作、失败恢复与权限。
6. [工程实施规格](docs/工程实施规格.md) / [接口与数据契约](docs/接口与数据契约.md)：模块、状态、事务、数据和接口。
7. [决策登记](docs/决策登记.md)：已可执行的解释与必须确认的商业决定。
8. [开发排期与任务台账](docs/开发排期与任务台账.md)：唯一任务状态入口，含原 S/T 编号映射、依赖和验收。
9. [验收矩阵](docs/验收矩阵.md) / [执行与交接模板](docs/执行与交接模板.md)：可复现证据要求。
10. [第 0 步入口](step0/README.md) / [GO 判定记录](step0/verdict.md)：先做当前允许的工作。

补充执行契约见 [ADR-12](docs/adr/ADR-12.md)，可运行验证与SQL隔离说明见 [contracts README](docs/contracts/README.md)。当前缺少来源许可，先按离线流程开发。

## 当前可运行检查

已有 [离线Collector PoC](step0/collector-poc/README.md)，仅合成fixture回放；未验证真实eBay获取。TypeScript工程要求Node22.18+，安装锁定依赖后使用当前工程命令：

```sh
node --test step0/collector-poc/tests/*.test.ts
node step0/collector-poc/src/cli.ts
```

第0步离线检查包含源码严格类型检查、离线测试、120条草稿语料结构、黄金夹具、文档及契约。依赖安装需要网络；安装后测试过程使用本地依赖，Node测试预载禁网守卫。

```sh
npm --prefix step0/collector-poc ci --ignore-scripts
python3 step0/tools/validate_offline.py
```

执行日志、退出码和源码hash写入忽略提交的`step0/artifacts/`。版本化复核证据随工作包放在`step0/collector-poc/evidence/`。语料草稿及标注要求见 [质量规程](step0/quality-plan.md)。

用户于2026-11-16确认soldbench.com已注册；DNS/TLS、邮件域验证和上线仍需实际配置与验证。

夹具和文档检查仅用Python 3标准库；契约检查还需PyYAML/jsonschema/referencing，版本与安装方式见 [契约验证入口](docs/contracts/README.md)。在仓库根目录执行：

```sh
python3 step0/tools/verify_fixture.py
python3 docs/check_docs.py
python3 docs/contracts/check_contracts.py
```

这些检查验证夹具与文档一致性，不代表真实网络来源、支付或生产端到端验收通过。工程命令为`npm run lint`、`npm run typecheck`、`npm run build`、`npm test`、`npm run contracts`；运行前需`npm ci`。开发服务器使用回环地址、离线fixture、支付offline和Collector关闭：

```sh
npm ci
npm run db:start
npm run db:migrate
npm run dev
```

本地服务可用性/SSR/API壳不代表产品Search功能已实现。PG16集成测试启动独立临时数据库；在受限环境需要允许Postgres共享内存系统调用。

## 开发顺序

先按台账领取已解锁TASK。第0步离线PoC和完整离线产品工程均已获用户授权；只有来源访问、图片真实采集/再分发、真实支付、发信和生产发布继续受各自阶段门限制。缺少准入时继续离线验证及证据准备，不以模拟结果替代线上14天验证。

排期按一条实施线估算，有效工作日与连续观察日、外部等待分开；原稿第 14 章的 18 周为早期概算，新台账是拆分后的执行估算，不是上线承诺。

搜索页字段/过滤/分母/趋势/格式分组的最新实施依据是[搜索页专项](docs/搜索页采集字段与统计契约.md)，需连同AT-074/075读取；旧OpenAPI尚不含全部增量，不得按已实现接手。
