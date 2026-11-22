# SoldBench 项目交接

交接日期：2026-11-22（Asia/Singapore）。交接内容涵盖产品、代码、可复验证据、剩余工作和上线条件。任务状态与排期以[开发排期与任务台账](开发排期与任务台账.md)为准，本文用于找到接手起点。

## 1. 先接哪里

| 项目 | 接手信息 |
|---|---|
| 仓库 | 私有仓库 `jackyang1989/SoldBench`，远端 `https://github.com/jackyang1989/SoldBench.git` |
| 主分支基线 | `main` 已合入 `codex/collector-revocation-batch` 收尾（§157）、主图维护状态运营读侧（§158）与任务信封绑定的 eBay US 已售搜索 DOM 结构化解析（§159） |
| 当前工作区 | 本机主检出 `/Users/jianouyang/Project/SoldBench`（在 `main` 上推进）；旧隔离工作树 `/Users/jianouyang/.codex/worktrees/soldbench-media-recovery/SoldBench` 保留未改，勿再基于已合入分支继续做合成撤权延伸 |
| 已完成增量 | TASK-014/015/016/039/061 的撤权主图分批清理回执（§157）、主图维护状态接入采集监督与双语运营台（§158）、信封绑定 eBay US 已售搜索 DOM 结构化解析与漂移/挑战熔断保护（§159）均已通过全量回归与独立归档恢复演练 |
| 接下来做什么 | **停止在合成数据撤权清理上继续扩展**；优先扩展真实 eBay US 已售页面多布局变体解析、品类强属性结构化提取、非合成原始 HTML 响应接入管线与抓取出错熔断稳定性 |

接手后先在主检出确认分支与工作区状态：

```sh
git status --short --branch
git worktree list
git log -n 5 --oneline main
```

保留已有未提交改动。若该分支已被某个工作树检出，进入对应工作树续接。需要新隔离工作树时按 Codex 的工作树入口建立。用户要求每个整包验收后安全合并到 `main`，不要把未验候选或其他人的改动带入主线。

## 2. 产品边界和决定

SoldBench 是直接服务**个人卖家、收藏品交易商、二手商家、开发者、SaaS 企业、专业数据使用者**的成交查价与研究系统。卖家在 Web 查价、看成交明细和主图。交易商与二手商家用成色、版本和强属性筛选、核查证据、保存研究。开发者和 SaaS 通过 REST、MCP、示例和用量审计集成。专业数据用户需要能解释的样本、时间口径、价格分布和获准导出。网页、REST、MCP 与 Worker 共用查询、统计、权限和计费服务。[功能与页面规格](功能与页面规格.md)

- **市场与语言。** 首发专注 eBay US、USD，首发类目由第 0 步证据签收。界面和事务邮件覆盖英语与简体中文，切换语言沿用同一查询与账本。后续增加国家站点时同步交付当地所需语言及地区适配。多年历史、批量查价、OAuth、其他平台及专业类目按 TASK-044–056 分阶段推进，范围见 [竞品能力实施规格](竞品能力实施规格与路线图.md) 和[多语言专项](多语言与商业交付补充规格.md)。
- **供数与研究。** 自研自托管采集，成交主图是首发要求。挂单、观察、成交事件分别存储，重复观察不增加成交数。强属性错配排除，未核实的 Best Offer 实际价和所需运费保持未知。价格、分位数、样本门槛、显式领取收费与撤权即时拒读依 [AGENTS.md](../AGENTS.md) §5 及 [ADR-12](adr/ADR-12.md)。
- **设计。** 当前设计依据是仓库内 [SoldBench Prototype.html](<../SoldBench Prototype.html>) 与[整站原型实施基线](整站原型与设计实施基线.md)。复用同一套设计语言和组件，页面数据与动作接实际服务。原型中的演示快照、假计数、模拟账户与收款状态仅可作为设计参考。竞品参考顺序是 CompSniper、SoldComps.io、sold-comps.com，产品差距看 DEC-13 和任务映射。
- **支付与报价。** Stripe 主通道，PayPal 补充。Creem/Dodo 只做备选资格核验。定价以稳定供数、自身完整实测成本、客户价值及竞品价格为输入，截图中的成本阈值只供参考。当前可验证的是本机合成生命周期，真实资格和收费按 [支付规格](Stripe与PayPal接入规格.md) 与 DEC-07。
- **品牌和部署。** 已确认注册 `soldbench.com`。部署目标为网站 `https://soldbench.com`、API `https://api.soldbench.com/v1`、文档 `https://soldbench.com/docs`、MCP `https://soldbench.com/mcp`、客服 `support@soldbench.com`。服务器由用户决定在开发后购买，随后验证 DNS、TLS、子域名和邮件。

## 3. 已经做了什么

下表按交付面给出离线实现、代码入口和证据位置。台账 §4 维护原 TASK 的状态，较新的分包证据保留在对应章节。

| 领域 | 已做的工作及代码入口 | 可核实的记录 |
|---|---|---|
| 工程与数据库，TASK-011/012/017 | TypeScript 工作区，Hono API、React SSR、PG16、独立查询 Worker 和采集监督进程。32 个增量迁移，本机无 DDL 权限启动、断进程和旧包回滚演练。入口 `apps/api/src/server.ts`、`scripts/query-worker.mjs`、`packages/db/migrations/` | 台账 §101、§109、§122、§129 |
| 来源准备，TASK-001/003–009 | 45 字段权利和来源事实清单、120 条查询草稿、1,680 时段的验证计划、质量盲审、断源演练、成本和访谈准备。入口 `step0/`。实际来源字段仍待核验 | [第 0 步](../step0/README.md)、台账 §94、§96、§110、§112、§139–143 |
| 采集与商品主图，TASK-013–016 | 本机 JSON/HTML 分页回放、任务信封绑定的 eBay US 已售搜索 DOM 结构化解析（`createEbayUsSoldSearchHtmlProfile`）、原响应摘要、观察与事件去重、独立租约、预算结算、降速/熔断、缺包和迟到恢复、定时计划、主图绑定/转码/补采/到期与撤权分批清理。私有通道和过期原包维护。入口 `packages/collector/src/`、`packages/media/src/`、`scripts/collector-supervisor.mjs` | 台账 §91–93、§98–100、§139–159 |
| 查价与研究，TASK-019/020/027/028/031/032/036/059 | 黄金 121/64/58、可比性及混型号判定，显式领取、详情/主图/诊断、只读复取、人工排除重算、单结果 JSON/CSV、受控公开分享、已交付快照保存和对照。入口 `packages/core/src/`、`packages/query/src/`、`apps/api/src/queries.ts` | 台账 §54–57、§63–76、§86、§92、§95 |
| 账户与账本，TASK-023–027/033/039 | 本机注册/验证、会话、TOTP、恢复码、API key、用量/日志、积分桶和原子结算、删除及旧备份防反弹；双语事务邮件从离线发件箱交付。入口 `packages/auth/src/`、`packages/billing/src/`、`apps/api/src/auth.ts` | 台账 §40–41、§47、§65、§89、§102、§106、§130–131 |
| 支付，TASK-029 | Stripe/PayPal 本机签名事件、订阅及退款生命周期、只读对账、晚到事件与旧库补放，入口 `apps/api/src/payments.ts`、`packages/billing/src/payment-lifecycle.ts` | 台账 §49、§68、§70、§73、§108、§132–134 |
| 英中网页与运营，TASK-031–036/057–061 | 原型 Search/Research/账户/Playground、公开索引和内容页、CMS 审核/定时/回滚、工单、审批与执行、用户 360、来源监控及主图维护状态读侧已接本机服务。入口 `apps/web/src/`、`apps/api/src/operations.ts`、`apps/api/src/ops-telemetry.ts` | 台账 §63–78、§84–88、§95、§103、§105、§121、§147–149、§158 |
| 开发者与运行交付，TASK-037–040/042 | OpenAPI 1.27.0、双语 Docs、Playground、REST、MCP、Skill 与 TS/Python/curl 示例。可从独立归档解包、启动、验证客户端以及恢复撤权、账务和仍有权主图。入口 `developer/`、`apps/api/src/mcp.ts`、`scripts/package-offline.py`、`scripts/rehearse-offline.py` | 台账 §83、§88–89、§95、§104、§122–131、§154–159 |

最新主线候选 `3bb00b6` 的全量记录为 29 套、308 项应用测试、5 项接口兼容，零失败、零跳过。214 文件的独立运行包（SHA-256 `0c8f238dc64ab772b25be65be841e544da7b97c77ba2d595148987f8248f2429`）完成恢复、过期清理与客户端演练，合成采集 2 页、8 张主图，外部来源请求为零。证据和 SHA-256 见台账 §156–159。GitHub Actions 最近核对的主线运行在创建作业前报 `startup_failure`，作业数为零。不能从该状态推断 runner 或仓库设置的根因。[GitHub Actions 记录](https://github.com/jackyang1989/SoldBench/actions/runs/44851600259)

## 4. 最新收口与采集能力增量

### 已完成第一包：撤权主图分批维护（台账 §157）

- `packages/media/src/private-store.ts`、`packages/collector/src/worker.ts`、`scripts/collector-supervisor.mjs` 已完成分批撤权清理：撤权即刻拒读；文件按最多 50 个生成名称清除并同步目录，之后分批清除最多 50 条持有 `object_key` 的媒体引用，最后统一收口非对象记录状态并确认 `collector.media_cleanup` outbox。同页待处理主图按创建时间与外部商品 ID 确定性排序。

### 已完成第二包：媒体维护状态进入运营台（台账 §158）

- **TASK-016/061，AT-052/080。** `scripts/collector-supervisor.mjs` 的 `recordProgress` 已持久化最近一次实际维护的数据库时点和状态（`idle`、`processed`、`backlog_pending`、`store_unmatched`、`failed`），普通轮次不抹除上一条维护记录。`apps/api/src/ops-telemetry.ts` 在 `collector_media_cleanup` 表投影已确认字段，`apps/web/src/site.js` 已补齐英中列名和状态描述。发生撤权后仍可查看授权运营人员所需的清理状态，不输出私有路径或源证据，并以现有 `outbox` 为完成依据。

### 已完成第三包：任务信封绑定的 eBay US 已售搜索 DOM 结构化解析（台账 §159）

- **TASK-014/015/016，AT-003/004/009/056/074。** `packages/collector/src/html.ts` 在完全保留既有 `root_attributes` 合成模式兼容的同时，新增 `bindingMode: "envelope"`、`parseNaturalSoldDate` 与 `createEbayUsSoldSearchHtmlProfile()`：由任务信封绑定 `sourceId`、`queryHash`、`cursor`、`asOf`，直接从 eBay US `.srp-river-results` / `li.s-item` DOM 提取已售记录，自动剔除 `.s-item--sponsored` 广告与 `s-l64`/`s.gif` 占位图，从 `/itm/…` 提取规范链接与 `listingId`，解析 `"Sold Nov 15, 2026"` 自然语言日期，将 `"Best offer accepted"`／划线价归为 `displayed_only` 排除出默认价格统计，支持 `_pgn` 分页与首屏结果计数，并在挑战页或 DOM 结构漂移时 Fail-Closed 熔断/隔离。

### 接下来优先执行（2026-11-21 纠偏后路线）

1. **止损停建合成数据撤权边角：** §157–§158 已完成既有 `codex/collector-revocation-batch` 批次的撤权清理与运营读侧闭环；此后不得再针对合成数据/本地 spool 撤权扩展边角任务，所有采集新工时一律服务于真实网页抓取与结构化提取稳定性。
2. **扩展真实 eBay US 已售 DOM 解析覆盖（基于 [采集管线实施契约](采集管线实施契约.md) §23）：** 扩充真实列表页与详情页多布局变体（含价格区间、多币种、促销/划线价、运费未知与 Best Offer 标注、分页与空结果辨识）、类目强属性结构化提取及 DOM 漂移识别测试样本。
3. **非合成原始响应摄入与隔离恢复验证：** 打通外部获取或离线归档的真实 eBay HTML 原始响应直接进入信封绑定解析、去重入库与失败隔离重放链路，确认在无 `offline_fixture` 假设下的持续稳定产数。

## 5. 新 Agent 必读顺序

| 顺序 | 阅读 | 读完确认什么 |
|---|---|---|
| 1 | [AGENTS.md](../AGENTS.md)、[v1.4 产品规格](<../SoldBench 开发规格书 v1.4.md>) §0/§3 和相关业务章 | 用户指令、首发范围、来源边界、数据和扣费不变量 |
| 2 | [决策登记](决策登记.md)、[ADR-13](adr/ADR-13.md)；触及查询时读 [ADR-12](adr/ADR-12.md)，触及身份时读 [ADR-14](adr/ADR-14.md) | 哪些是离线工程冻结规则，哪些还需要真实或经营签收 |
| 3 | [功能与页面规格](功能与页面规格.md)、[工程实施规格](工程实施规格.md)、[接口与数据契约](接口与数据契约.md)、[OpenAPI](openapi.yaml)；再按下表读领域文档 | 正常路径、错误、权限和服务边界；版本与相关代码输出一致 |
| 4 | [任务台账](开发排期与任务台账.md) §4 和 §156–159、[验收矩阵](验收矩阵.md)、[交接模板](执行与交接模板.md) | 领取的 TASK、依赖、AT、当前候选、完整验收以及可回退点 |
| 5 | [README](../README.md)、[发布与恢复手册](发布、回滚与撤权恢复手册.md)、本包源码及实际测试 | 能在本机复跑对应故障和正常流程，再从证据推进下一包 |

| 接手方向 | 专项阅读 |
|---|---|
| 正在接手的采集包 | [采集管线实施契约](采集管线实施契约.md) §16–23、[采集稳定性专项](采集稳定性专项规格.md)、[搜索字段与统计](搜索页采集字段与统计契约.md)、[真实来源权利档案](../step0/access-rights.md) |
| 网页、内容和运营 | [原型 HTML](<../SoldBench Prototype.html>)、[实施基线](整站原型与设计实施基线.md)、[原型补齐规格](原型功能追踪与补齐规格.md)、[运营后端契约](运营后端实施契约.md)、[多语言规格](多语言与商业交付补充规格.md) |
| 查询、统计、身份和资金 | [查询账本与交付](查询账本与交付实施契约.md)、[账户与访问](账户与访问实施契约.md)、[Stripe 与 PayPal](Stripe与PayPal接入规格.md)、[账户删除与恢复](账户删除与恢复保护实施契约.md) |
| REST、MCP、竞品或扩展 | [MCP 与开发者交付](MCP与开发者交付契约.md)、[契约验证说明](contracts/README.md)、[竞品能力实施路线图](竞品能力实施规格与路线图.md)、[国际站点规划](国际站点规划与品牌评估_20261116.md) |

`audit/`、`docs/baselines/` 和带早期日期的研究报告用于还原当时的差异。遇到旧稿显示某功能尚未开发或列出旧 OpenAPI 版本时，核对新版规范、最新台账、源码及实际入口。`/docs/implementation-status.json` 可核对本机 REST 注册范围，功能验收仍追到原 TASK 和 AT。

## 6. 本地复现与验收

准备 Node 22（CI 固定 22.23.3）、PostgreSQL 16、Python 3 与本机 Chrome。测试脚本在本机专用临时 PG 库运行；系统沙箱需要允许 PG 共享内存。浏览器验收通过 `SOLDBENCH_BROWSER_BINARY` 指向本机 Chrome 可执行文件。外部依赖安装完成后，测试以合成数据和本地服务运行。

```sh
# 首次准备依赖；已有可用环境可直接从构建开始
npm ci
npm --prefix step0/collector-poc ci --ignore-scripts
soldbench_venv="$(mktemp -d /tmp/soldbench-python.XXXXXX)"
python3 -m venv "$soldbench_venv"
. "$soldbench_venv/bin/activate"
python3 -m pip install -r docs/contracts/requirements.txt

npm run build
node scripts/test.mjs tests/collector-pipeline.test.mjs
npm run check
npm run test:step0
python3 docs/check_docs.py
python3 -m unittest discover -s tests -p test_runtime_package.py
git diff --check
```

在**干净候选提交**上重新构建，然后打包并独立解包恢复。演练日志使用新的路径，命令拒绝覆盖旧日志。

```sh
npm run build
soldbench_evidence_dir="$(mktemp -d /tmp/soldbench-acceptance.XXXXXX)"
python3 scripts/package-offline.py pack "$soldbench_evidence_dir/runtime.tar.gz"
python3 scripts/rehearse-offline.py "$soldbench_evidence_dir/runtime.tar.gz" \
  --restore --clients --require-spool-retention --log "$soldbench_evidence_dir/rehearsal.log"
```

本机开发演示依 [README](../README.md) 从 `npm run db:start` 启动专用开发库。采集用 `npm run collector:http-demo` 回放两页合成 HTML 和 8 张主图；开发者研究可用 `npm run developer:demo -- --research`，随后在私有终端载入生成的 0600 环境文件、启动 `npm run dev` 并运行示例。六类客户集成回归入口是 `node scripts/test.mjs tests/customer-journeys.test.mjs`。测试日志、生成的环境文件及任何账号凭据不要提交到仓库。

## 7. 真实上线还缺什么

正式 G0 状态为 `NOT_ISSUED`。当前配置为 `COLLECTOR_ENABLED=false`、`DATA_MODE=offline_fixture`、`PAYMENTS_MODE=offline`。以下前置在[第 0 步判定](../step0/verdict.md)及任务台账登记。

1. **来源与主图（TASK-001/007/014–018）。** 取得真实来源的访问、保存、统计与分发依据，主图分别核验访问、保存、处理、展示、再分发及留存。准备获准原始样本和 45 字段的逐项证据，沿现有 Collector 接真实入口并验证 14 个连续自然日，另做 G1 的 7 日生产型观察。现有 loopback 回放、合成选择器及统计样本用于复现工程行为。
2. **实际价格与商业验证（TASK-004/008/021/041）。** 锁定类目和人工金标，核对真实成交价、Best Offer 未知、运费、错配、缺图和重复事件；使用相同口径做独立盲审。稳定供数后实测采集、维护、失败、许可与支付完整成本，再评估满额成本、访谈、售价和配额。
3. **支付、邮件和部署（TASK-017/023/029/034/038–043）。** 商户资格和渠道沙盒、真实邮件送达、正式条款、服务器、DNS/TLS、报警、出口隔离、外部依赖、实际 MCP 宿主及跨机灾备待验。生产备份恢复目标按台账实测。真实试点与公开发布由阶段负责人根据证据签收。
4. **工程复核。** 本机测试、真实线上集成和独立复核分别记录。GitHub Actions 要拿到实际作业和输出才能登记为通过。发布状态、定价、数据覆盖和 SLA 均以实际验收和用户签收为依据。

接手工作到这里请先停止一切假数据撤权/清理边角延伸，直接按 §4「接下来优先执行（2026-11-21 纠偏后路线）」与台账 §159 推进真实 eBay US 已售采集解析与摄入稳定性包；每包完成时把实际证据写回原 TASK，合并后顺排接续。
