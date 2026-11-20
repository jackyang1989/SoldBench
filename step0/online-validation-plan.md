# 连续14天验证的离线准备

TASK-007的真实执行等待来源准入。当前仅准备冻结计划与日志分析工具，执行模式offline_fixture。120条语料仍为草稿，创始人签收后应冻结hash、开始日期、批准速率/页数/并发/预算、类目及时间窗口。

每天每查询一次，按固定语料顺序分配UTC 00/08/16三个时段，各40条，共14天1680个计划任务。这个默认日程仅供准备，实际频率以批准额度和签收计划为准。分母保留所有计划任务，未执行和失败均入报告。分页和增量重试记在同一个计划任务下，每页请求按Collector已有的最多3次及总预算/deadline控制。

```sh
python3 step0/tools/stability_report.py --start 2026-12-01
python3 step0/tools/stability_report.py --start 2026-12-01 --freeze-plan /path/to/campaign-plan.json
python3 step0/tools/stability_report.py --plan /path/to/campaign-plan.json --results /path/to/permitted-results.jsonl
```

开始日仅为示例。冻结文件保存全部 1,680 个任务的 ID、UTC 时段、类目、分组，记录计划、语料及整轮摘要。冻结命令只创建新文件。配合 `--corpus` 可指定独立保管的原始 CSV。复核会用该 CSV 重建计划，比对整份冻结文件。修改原关键词、顺序或时间都需要重新保存和签收，并保留旧证据。

本地 JSONL 每行包含 `task_id`、`mode`、`started_at`、`finished_at`、`attempts`、`first_semantic_success`、`semantic_success`、`billable`、`pages`、`bytes`、`cpu_ms`、`cost_cents`、`evidence_ref`。`task_id` 格式为 `YYYY-MM-DD/query_id`。一次完整任务只写一行终态，`attempts` 记录全部分页和重试请求总次数。`authorized_online` 批次须使用 `--plan`，每行提供对应的 `campaign_sha256` 和受控证据引用，任务实际启动不得早于冻结时段。冻结摘要仅用于绑定证据，真实批准和权利材料另行复核。

semantic_success为预算和deadline内取得符合该query和结构的有效结果，HTTP200错误页必须填false。first_semantic_success表示全部所需页在第一次尝试即语义成功，需要原始分请求证据，不能从attempts总数反推，因为正常分页也会产生多次请求。billable另要求权利有效、新鲜且合格价格样本至少8条。字段完整性、实际价核验率与Precision/Recall由字段/金标报告另核验，不以成功标志替代。

任务在准入守卫或熔断处停止时，保留启动和失败记录，attempts/pages为0，first_semantic_success/semantic_success/billable均false。该任务继续留在计划分母和启动数，不能从报表中删除。已提交页数不得大于请求次数。

报告按日、类目、头尾输出计划/启动/首试语义成功/有界最终成功/可收费数、资源和成本。已报告任务的耗时P95、成本P50/P95及最贵ceil(5%×n)任务平均成本单列，费用分位数用Type7有理数。已报告任务只要一项成本未知，该组成本分布保留null。计划缺失任务使计划总成本保持null，已知观察成本及样本数仍透明列出。混合离线/在线记录直接拒绝。authorized_online输入必须带证据引用，报告保留externalEvidenceVerified=false等待独立核验，G0签署由创始人负责。

在获准样本校验中，图片需核对主图角色、同一成交/观察归属与可解析尺寸。另列主图缺失与实物可读分母，标记来源许可和解析版本。一次本地主图抽检不能替代真实源的字段证据。

连续线上14天须逐日有效证据齐全，遵准入和真实自然日执行，保留原始失败记录。工具不发送请求、不调度联网任务，真实运行器在许可取得后按实际来源字段实现。

## 批量故障回放

```sh
python3 step0/tools/replay_campaign.py
```

该回归从六组各选head/tail一条，12查询×14逻辑日=168任务，分别执行瞬时故障和整源拒绝两组，共336个合成任务。完整120条冻结计划的真实线上验证继续独立执行。输入日期、成交价和可比判断由工具明确生成，费用保持null，输出保留offline_fixture、onlineVerified=false及NOT_CLEARED。

瞬时场景固定注入429、503和页预算不足，期望138次首次语义成功、158次最终成功及10次预算停止。该数字是回归断言，实际来源指标需要真实日志。整源场景在第25个任务返回403，持久化公共停止标志，后续143个任务的派发为0，计划记录保留。已保存快照按逻辑时钟从fresh到stale再expired，权限仍用独立模拟读取守卫。

本回放的semantic_success衡量该计划采集任务的完整结果，billable只记录本任务新结果的候选资格。缓存读取另用cached_freshness/cached_readable/cached_verified_samples描述，actualChargePerformed始终false。正式产品中有效fresh缓存查询的收费仍按既有共享规则实现，不能套用此采集任务报表作为账本。

每查询使用独立PoC文件限制全JSON复制规模，公共来源停止标志使用另一原子文件。源码真实共享DB并发、进程间停止传播及生产恢复仍按后续PG16/部署门验证。CPU取本机进程用量，bytes记录合成正文预算预留，延迟使用逻辑时钟，成本及真实网络耗时仍未知。原始结果JSONL、控制state和逐日/类目/头尾报告保存在独立artifacts目录。
