# SoldBench 离线 Collector PoC

TASK-003/005/006 / 2026-11-16。自有TypeScript代码，Node22.18+内置类型擦除执行。运行源码使用Node内置模块，开发依赖锁定TypeScript和Node类型。所有报告为`offline_fixture`、`onlineVerified=false`、`sourceApproval=NOT_CLEARED`。

## 运行

在项目根目录，使用Node22.18+：

```sh
npm ci
npm --prefix step0/collector-poc ci --ignore-scripts
npm run build
node --test step0/collector-poc/tests/*.test.ts
node step0/collector-poc/src/cli.ts
```

PoC 复用主工程的统计模块，先构建 workspace，再从根目录运行 `npm run test:step0`。`npm --prefix step0/collector-poc run typecheck` 严格检查 `src/`。统一检查入口预载 `offline-network.ts`，阻止 Node 测试进程访问外网。

默认demo写入本目录`artifacts/demo-state.json`和`artifacts/demo-report.json`，不修改原始黄金fixture。连续运行复用同一run/checkpoint，不增加重复事件。独立输出可以指定：

```sh
node step0/collector-poc/src/cli.ts --state /tmp/soldbench-own-demo-state.json --report /tmp/soldbench-own-demo-report.json
```

外部report必须使用新路径，不能覆盖已存在文件；如需重复演示使用默认artifacts或另选新report路径。`COLLECTOR_ENABLED`只允许未设置或`false`，`DATA_MODE`只允许未设置或`offline_fixture`；CLI不支持URL、网络模式或凭证。不要传生产文件/客户数据做state。

## 实际覆盖

- 每次fixture派发前、提交前再次guard；任何network mode/启用采集配置被拒绝。离线读取允许标记可中途撤销。
- page严格绑定source/query/cursor、合成schema、字段类型和覆盖时间；正常空态与200错误文档区分。
- 401/403、登录墙/挑战立即持久化熔断；schema变动隔离停止；429按Retry-After、5xx按有限退避处理，最多3次并受deadline和请求/字节预算共同限制。演示用逻辑时间，不进行真实等待或伪造实际运行天数。
- 每页观测、事件、隔离及checkpoint在一个本地JSON原子提交；完整采集完成后才更新该source/query覆盖水位，取各页最保守值。失败保留上次完整水位，不更新为now。
- 来源事件键去重；同listing有独立合成事件键可形成两条候选。未知身份只留观测和隔离；冲突事件保留原证据并标conflicted，不静默覆盖。没有通过标题/价格猜测逐笔成交。
- 原子文件替换、fsync与排他lock；预留预算先持久化，重启不能重置预算。崩溃或响应丢失后重放不增加同事件。

fixture是自定义`Page`接口JSON，记录仅含listing/event身份和合成标题。真实eBay DOM、字段及实际成交价需取得获准样本验证。新增`pricing.ts`独立探索整数分、有理数Type7和截尾均值，以完整候选快照计算，再按limit裁切明细。未知身份、冲突事件、未核验价格、运费/换汇证据缺失均保守处理。强属性匹配由输入的可比判断提供，实际taxonomy及R规则仍需后续实现。

原始121/64/58黄金文件由显式合成适配器转换，全部统计和质量字段逐项复核，另通过既有Python Fraction算法交叉检查0/1/7/8/29/30/58、半分及大整数。黄金文件中的UTC时间仅用于原算例。`time.ts`另验证来源日精度和IANA时区，含DST与整个日区间落窗规则。`availability.ts`和断源集成测试验证持久化覆盖水位读取及恢复事件去重。

## 报告口径

`storedCandidateEvents/observations/quarantined`是本PoC文件内累计调试计数，不是当前查询统计或市场销量；candidate不等于已核验可比成交。`attempts/fixtureBodyBytes`是持久化预留的尝试数和fixture正文大小，可能包含派发前故障的保守预留，不是真实网络流量或采集经营成本。`dataAsOf`是该source/query最后完整提交的合成覆盖水位，失败后可能保留旧值，必须结合outcome看。

默认fixture跨两页重复一个事件，同时包含同listing的第二个独立事件及一个身份不明观测：应得到2条候选事件、4条观测、1条隔离记录，水位为2026-11-15T23:00:00Z；没有中心统计或收费。

## 安全边界与恢复

本地文件存储只支持一个写进程；第二进程冲突立即失败，不实现生产数据库并发、lease、outbox投递或灾难恢复。这里的观测/checkpoint原子性证明不能替代正式PG16事务和并发验收。

正常关闭释放`.lock`；进程崩溃可能留下锁。确认对应进程已退出、保留原state证据后，由执行者清理自己这份临时锁，再按同run/fixture重放。不得删除他人运行锁或客户/资金数据来恢复。熔断没有自动绕过或重置入口；测试使用全新临时fixture空间，未来真实源恢复必须按准入及人工批准探针设计实现。

测试中封锁fetch、HTTP/HTTPS和TCP/TLS入口，并用正控证明守卫生效；正常PoC路径访问这些入口为0。这是该测试范围的证据，不代替宿主级流量审计、第三方依赖审计或线上许可验证。

## 交接

TASK-003/004/005/006按整包交非实现者复核。120条查询为待签收草稿，人工金标待取得获准候选数据后制作。下一可执行范围为TASK-001/008的离线来源资料、成本及访谈工具准备。TASK-007等待真实准入后连续14天验证，阶段状态以台账为准。

2026-11-16边界复核修复了保留对象属性名作为cursor时的错误分类，FixtureTransport仅查自有响应键。运行绑定包含parser版本。旧state保留原样，旧run与新parser绑定冲突时使用新state/report路径做新版本回放，或由显式新run开始复核，禁止删除原证据来恢复。统计探索只接受30/90/180/365查询窗口，具体可商用窗口仍待来源证据。

## 采集、快照与统计贯通

parser为offline-page-parser-1.1.1，engine为offline-exploration-1.1.1。原page.v1兼容身份回放，新增明确标synthetic的page.v2，每条记录携带结构化Candidate。Candidate包含合成的可比性与价格资格输入，实际eBay字段提取和taxonomy匹配仍待获准真实样本。

```sh
node --import ./step0/collector-poc/src/offline-network.ts step0/collector-poc/src/study.ts
```

`--output-dir PATH`可指定独立输出目录。命令将原始黄金文件通过显式适配器转为三页v2夹具，缺listing_id使用synthetic前缀，缺币种使用XXX，原UTC时点仅用于复现算例。每页的观察、事件、正文hash、观察ID清单和checkpoint原子提交。候选集合严格来自已完成run的清单，保守水位来自该run的各页覆盖时间。

snapshot.ts构建完整候选快照。读取时核对快照hash、查询/来源/版本、当前观察清单与事件状态，再复用pricing.ts出数，并在返回前再次读取模拟权限。用户视图limit只裁切明细。未知运费、价格核验不足、身份不明和强属性排除分项保留诊断。全局事件指纹不包含query-specific comparable，原始判断保留在各run观察中。

新快照用同目录临时文件、fsync和原子链接发布，已存在路径拒绝覆盖。发布前失败清理临时文件，发布后遇目录fsync故障须先读已有快照核验，再选择新路径恢复。旧state与证据均保留。

观察数量对账包含去重的未知身份、冲突及时间不合格候选，排除后再形成可比集合。unknown事件在快照中用来源/刊登/原始观察指纹识别重复候选，保持在可比之前排除，不能当已核验成交。`excluded_before_comparable`与可比数之和等于n_observed，价格排除另与可比数对账。没有来源候选指纹的未知输入保留逐条诊断，不能凭同价合并。观察去重键与query-specific comparable均不参与全局事实冲突判断。

贯通演练从实际计算的58条合格样本驱动0/24/48/72h与撤销读取，Collector报告仍只描述采集，study-report单独标statisticsComputed=true。模拟读取允许不代表来源准入，全部输出保留sourceApproval=NOT_CLEARED、onlineVerified=false和actualChargePerformed=false。读取无新派发，后续run覆盖时间不能使旧快照变新鲜。真实账户、账本和Web/API验收按后续阶段执行。

批量回放由`python3 step0/tools/replay_campaign.py`准备12条分层查询和168个逻辑任务，campaign.ts在禁网进程中分别执行瞬时故障和整源停止。每条查询独立保存观察和页证据，公共控制文件保留停止标志，停止后其他查询派发为0，重开控制文件后仍拒绝派发。计划/原始结果/报告口径见step0/online-validation-plan.md。
