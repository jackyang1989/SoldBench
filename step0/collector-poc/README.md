# SoldBench 离线 Collector PoC

TASK-003 / 2026-11-16。自有TypeScript代码，Node22.18+内置类型擦除执行，无外部包、HTTP客户端、浏览器或第三方采集依赖。当前仅实现合成fixture回放，所有报告为`offline_fixture`、`onlineVerified=false`、`sourceApproval=NOT_CLEARED`。不是生产Collector，不支持切开关后联网。

## 运行

在项目根目录，使用Node22.18+：

```sh
node --test step0/collector-poc/tests/*.test.ts
node step0/collector-poc/src/cli.ts
```

测试为Node内置runner；没有安装依赖步骤或外部包lockfile。Node22本机验证版本见证据。原生执行会擦除类型，**不是TypeScript静态类型检查**；正式工程的tsc/lint/build和CI仍在G0后TASK-011建立。本轮不宣称这些检查已完成。

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

fixture是自定义`Page`接口JSON，**未使用或验证真实eBay DOM、字段、网络权限或actual成交价**。记录只含listing/event身份和合成标题，不参与金额归一、匹配或价格统计；原始121/64/58黄金统计仍用既有独立工具核对。后续必须拿有权使用的真实样本实现生产shape/解析器并独立验证，不能把synthetic_event_key当来源提供的真实事件证明。

## 报告口径

`storedCandidateEvents/observations/quarantined`是本PoC文件内累计调试计数，不是当前查询统计或市场销量；candidate不等于已核验可比成交。`attempts/fixtureBodyBytes`是持久化预留的尝试数和fixture正文大小，可能包含派发前故障的保守预留，不是真实网络流量或采集经营成本。`dataAsOf`是该source/query最后完整提交的合成覆盖水位，失败后可能保留旧值，必须结合outcome看。

默认fixture跨两页重复一个事件，同时包含同listing的第二个独立事件及一个身份不明观测：应得到2条候选事件、4条观测、1条隔离记录，水位为2026-11-15T23:00:00Z；没有中心统计或收费。

## 安全边界与恢复

本地文件存储只支持一个写进程；第二进程冲突立即失败，不实现生产数据库并发、lease、outbox投递或灾难恢复。这里的观测/checkpoint原子性证明不能替代正式PG16事务和并发验收。

正常关闭释放`.lock`；进程崩溃可能留下锁。确认对应进程已退出、保留原state证据后，由执行者清理自己这份临时锁，再按同run/fixture重放。不得删除他人运行锁或客户/资金数据来恢复。熔断没有自动绕过或重置入口；测试使用全新临时fixture空间，未来真实源恢复必须按准入及人工批准探针设计实现。

测试中封锁fetch、HTTP/HTTPS和TCP/TLS入口，并用正控证明守卫生效；正常PoC路径访问这些入口为0。这是该测试范围的证据，不代替宿主级流量审计、第三方依赖审计或线上许可验证。

## 下一步

TASK-003代码及证据交非实现者复核；当前不自行签收已完成。TASK-004补120查询语料/金标规程。随后TASK-005补金额/日期/身份/统计边界，TASK-006做0/24/48/72h断源语义模拟。真实来源清楚且获准后才进行TASK-007连续14天网络验证；G0之前仍不写正式账户/支付/前端。
