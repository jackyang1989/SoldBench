# SoldBench

目标地址：网站 `https://soldbench.com`，REST API `https://api.soldbench.com/v1`，开发者文档 `https://soldbench.com/docs`，MCP `https://soldbench.com/mcp`，客服 `support@soldbench.com`。这些是正式部署目标；服务器、DNS/TLS和邮件配置待开发后实施。

面向个人卖家、收藏品交易商、二手商家、开发者、SaaS 企业和专业数据使用者的成交研究与定价参考产品。网页提供直接查价与研究体验，REST API 支持程序集成，MCP 支持 Agent 工作流，三者共享数据、匹配、统计和计费规则。生产数据由自研、自托管 Collector 在明确许可范围内获取。首发默认评级卡牌，最终由第 0 步验证确定；Game Boy 文件是统计合成夹具，不代表首发类目或真实成交证据。

## 当前状态（2026-11-17）

用户已允许完整离线工程，真实来源许可前只使用synthetic/fixtures，禁止网络采集、真实收款和生产部署。当前已有PG采集管线、HTML合成解析、主图私有存储、账户/密钥、异步查询账本、研究交付和MCP协议适配；这些均为离线工程，**没有真实eBay供数、完整产品网页、真实支付或MCP主流宿主验收，也未达到竞品生产功能对等**。OpenAPI1.13的65个操作是契约数量，不能当作实现数量。用户最新要求优先采集，已否决UI草稿被隔离，不在活动工程中继续沿用。实现和证据以[任务台账](docs/开发排期与任务台账.md)为准；[Agent接手指南](docs/Agent接手指南.md)说明交接，原始[v1.4规格](<SoldBench 开发规格书 v1.4.md>)和[黄金合成夹具](v14_gameboy_58_verified.json)保留。

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

## 采集系统优先开发与离线演示

按用户要求，当前主线为[自研采集与证据管线](docs/采集管线实施契约.md)。已提供PG持久化入队/租约/预算/检查点、fixture-only worker、观察与成交去重、私有主图文件及撤销清理；真实eBay adapter、逐字段可得性及线上稳定性仍未验收。

异常结构/错误页、分页循环、既有成交事实冲突会记录隔离摘要并暂停来源采集；争议事件不能继续作为可信输入读取。正常旧证据在纯采集中断后仍检查现有权利，不因暂停一律作废。隔离不包含失败页原文，没有自动恢复/换入口流程。

```sh
npm run db:start
npm run collector:demo
npm run collector:maintain

# HTML正文→PG证据→8张本地生成主图→统计，一条命令离线演示
npm run collector:html-demo

# 只准备任务与合成响应包；从输出复制 artifactPath
npm run collector:demo -- --prepare-only
npm run collector:worker -- --fixture=/absolute/path/to/collector-fixture-JOB_ID.json --max-pages=1
# 下个周期用同一响应包续跑；未到重试时间时会报告 not_claimed
npm run collector:worker -- --fixture=/absolute/path/to/collector-fixture-JOB_ID.json
npm run collector:worker -- --fixture=/absolute/path/to/collector-fixture-JOB_ID.json --status=true

# 固定Worker子进程、V8 heap上限、周期超时及TERM/KILL宽限；不会自动重试
npm run collector:run -- --fixture=/absolute/path/to/collector-fixture-JOB_ID.json --heap-mb=192 --max-ms=60000 --grace-ms=2000
```

此命令在本机开发PG16或明确指定的专用本机数据库运行，使用原合成黄金fixture与本机生成图片；有数据库写入但没有外部来源请求，输出写入忽略提交的`.local/`。不是生产采集启动命令。先确保没有指向真实业务库的DATABASE_URL，配置与迁移要求见管线契约；没有凭证、准入或G0变化。

独立worker的响应包与run固定绑定，不得换包续跑；状态含实际job终态、游标、预算和lastSuccessAt。退出0不代表完整采集完成，可能是retry/not_claimed。每个进程写带PID的私有周期状态文件（路径见heartbeatPath），不能把重复启动实例的退出当作持租约实例停机；运行事实以PG租约/检查点为准。没有生产daemon、在线采集或真实稳定性结论。

HTML演示也支持`npm run collector:html-demo -- --prepare-only`，输出的artifactPath可交给同一个collector:worker分多周期续跑。样本与profile位于`tests/fixtures/html/`，全部由本项目编写；不是eBay网页捕获或已核验生产选择器。解析器不执行脚本、不访问HTML中的图片/iframe地址，主图只从本地响应包读取。真实eBay的45项字段仍全部未核验。

`collector:run`仅传必要本地DB/目录和OS环境，不把支付、会话密钥或Node preload传给worker；等待子进程退出后才报告结束。V8 heap不是RSS/CPU隔离，启动器被SIGKILL时仍依赖部署监督器清理子进程；宿主出口和生产资源限制尚未验收。

账户与访问服务已提供注册验证、登录/找回、会话撤销、CSRF、TOTP/恢复码及Key创建/旋转/撤销。开发服务首次生成私有随机auth secret文件，邮件仅进入加密本地outbox。接口与重试依据[账户契约](docs/账户与访问实施契约.md)和[ADR-14](docs/adr/ADR-14.md)，真实邮件/生产身份验收及完整网页尚待实施。

查询/账本离线服务接入持久化快照、异步计算、owner显式领取、Free周期、唯一charge、对账、当前权利主图和完整计算输入，见[实施契约](docs/查询账本与交付实施契约.md)。npm run dev同时启动API和独立query worker；也可单独运行npm run query:worker -- --once或--watch。无匹配快照明确503。默认私有图片目录为.local/collector-media，MEDIA_ROOT须与采集器一致。GameBoy演示保留原旧水位，不伪装实时价；当天流程可使用当天生成的HTML合成演示。

采集补采与内部报告（仅离线）：

```sh
# 原页面作业完成后，按同一已绑定响应包补采主图；不重抓页面
npm run collector:media -- --fixture=/absolute/path/to/collector-fixture-JOB_ID.json
# 同一个资源受控启动器也支持媒体周期
npm run collector:run -- --fixture=/absolute/path/to/collector-fixture-JOB_ID.json --media-only=true
# 按实际PG记录保存来源健康快照，source取采集命令的UUID
npm run collector:report -- --source=SOURCE_UUID
```

collector1.5将临时图片失败、共享来源退避、预算/租约恢复和当前许可读检纳入持久化链路；媒体失败不会修改成交身份/统计。命令退出0不代表所有媒体完成，应核对mediaResults及健康报告。未测成本为null，未创建冻结计划时执行率为null；创建后按应发生数计算且含漏跑，真实eBay字段仍unverified；没有线上采集或连续稳定性结论。详细规则见[管线契约§12](docs/采集管线实施契约.md)。

周期刷新计划：`npm run collector:refresh -- --action=create --source=UUID --config=UUID --query='q=Game+Boy+Color' --key=UNIQUE_ASCII_KEY_16_PLUS --interval=3600 --lag=300`；再运行`npm run collector:refresh -- --source=UUID`按固定计划补发生项/入队；停止用`--action=retire --source=UUID --plan=UUID`。仅offline_fixture，不执行来源请求。独立worker使用匹配job/profile的固定响应包执行；报告分母包含漏调度，排队不算执行。详见[管线契约§13](docs/采集管线实施契约.md)。

HTTP获取联通演示：`npm run collector:http-demo`。它启动仅绑定127.0.0.1的本机样本服务，经真实HTTP获取2页合成HTML和8张生成主图，再走同一解析、PG证据、WebP私有存储与共享统计。输出`transport=loopback_fixture`、`localHttpRequests=10`、`externalNetworkRequests=0`及证据报告；不是eBay采集命令。请求有超时、正文上限、取消和断流处理，禁止跟随重定向、压缩正文和配置外部origin。获准真实来源及适配仍待完成。

研究后端已提供owner详情`/v1/sold/{id}/comps/{event_id}`、分页`/diagnostics`、`POST /v1/sold/{id}/export`（JSON/CSV、权威/调整）及`/v1/requests`请求审计；共用已领取快照/当前字段权限，免费复取，不重抓。需要现有已核验session或对应scope的API key。字段许可缺失会裁剪逐条数据，不能以旧DTO绕过；说明/属性未采到会返回明确missing。见[研究交付契约](docs/查询账本与交付实施契约.md)。网页与真实供数未验收。

## 开发者离线接入

先运行 `npm run db:start`，再运行 `npm run developer:demo`。演示准备合成 HTML、8 条成交、8 张主图、不可登录的合成账号与私有 API key，只输出环境文件路径，不打印密钥。默认文件为 `.local/developer-demo.env`，权限0600；重跑撤销旧演示key。环境文件同时配置实际API和Worker使用的本机密钥目录、媒体目录和数据库。启动服务前，在私有终端：

```sh
set -a
. .local/developer-demo.env
set +a
npm run dev
# 另一个终端也导入同一环境文件，再运行：
node developer/examples/sold.ts --claim
python3 developer/examples/sold.py --claim
sh developer/examples/sold.sh --claim
```

`--claim` 明确允许最多1个合成credit；省略时停在未领取状态。curl版需要同目录sold.py与Python3；三者使用真实本机HTTP、拒绝重定向、同幂等key有界重试，不打印密钥。金额与样本量不是实时市场证据。详见[开发者契约](docs/MCP与开发者交付契约.md)。

本机 `/docs/en/quickstart` 和 `/docs/zh-CN/quickstart` 为双语Markdown，`/docs/search` 为本地搜索，不代表已完成专业文档前端。`/openapi.json`、`/llms.txt`、`/llms-full.txt`、`/.well-known/skills/index.json`、`/soldbench.postman.json` 由固定输入生成；`/docs/implementation-status.json` 区分本机路由存在与contract-only，不代替验收。`POST /mcp` 是官方SDK无状态适配，两主流宿主与生产TLS待实测。

`.github/workflows/offline.yml` 固定官方Actions提交，安装PG16后运行同一套离线检查、step0及开发者资产检查。远端执行结果以GitHub实际记录为准。构建需Python3及契约依赖（含PyYAML）。`LOCAL_STATE_ROOT` 仅控制本机认证密钥目录，默认`.local`；演示自定义目录时先导入对应私有环境文件，再启动API/Worker。

## 支付离线演练

默认关闭支付模拟。使用专用本机 PG16，执行 `PAYMENT_FIXTURES=true npm run payment:fixture -- init` 生成两份本机签名密钥，再以相同环境启动 `PAYMENT_FIXTURES=true npm run dev`。创建、查看和取消需本人会话，写入还需同源 Origin 和 CSRF。以 `offer_version=offline-v1` 创建本机支付意图，checkout URL 只显示状态。

用 `PAYMENT_FIXTURES=true npm run payment:fixture -- deliver /path/to/fixture.json` 写入独立确认并投递合成通知。CLI、API 和 Worker 共享 `LOCAL_STATE_ROOT`。Webhook HTTP 200 表示已收妥，最终到账看本人支付、订阅和用量。完整格式、事件归属和限制见[支付接入规格](docs/Stripe与PayPal接入规格.md)。


## 匿名查询与分享（后端）

只发布明确选中的合成快照。先用 `PUBLIC_FIXTURE_AGGREGATES=true npm run developer:demo` 准备获准的本机聚合夹具。启动 API 和 Worker 后运行开发者示例并领取，取得 `query_id`，再在同一环境运行 `npm run public:fixture -- publish <query_id>`。匿名浏览器同源调用 `POST /web/search`，使用相同参数。缓存未命中返回注册或稍后再试提示，访客不会启动采集或创建计算作业。

分享使用近期认证的本人会话和幂等键创建，首次返回一次性展示的链接。可从列表撤销，短期 token 仅存哈希。所有公开回复都带合成标记，只含聚合统计与质量，实时检查当前来源权利。专业页面、浏览器可见流程和线上代理隐私仍需验收。详见[公开结果实施契约](docs/公开结果离线实施契约.md)。

## 账户删除与本机恢复演练

本人可用近期认证和 CSRF 提交删除。请求先撤销登录、密钥、分享和匿名发布，Worker 随后清理私有资料及查询内容，保留不可变资金流水。客户端生成并私下保管独立随机回执。提交响应丢失时，可用 `X-Deletion-Receipt` 调固定回执查询路径。命令及专用测试库演练见[账户删除与恢复保护](docs/账户删除与恢复保护实施契约.md)。

## 支持与运营后端

`POST /support/requests` 通过同源表单受理反馈并返回编号。需要保留该幂等键以便重试。公开 `GET /status` 只显示本机模式和服务可用性。运营 API 通过浏览器会话授权，支持角色只读，写命令需管理员近期 MFA。来源暂停后仍可读取许可范围内旧快照，撤销会立即拒读并排队清理媒体。额度补偿复用原账本和幂等键。详见[运营实施契约](docs/运营后端实施契约.md)。
