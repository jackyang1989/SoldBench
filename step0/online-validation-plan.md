# 连续14天验证的离线准备

TASK-007的真实执行等待来源准入。当前仅准备冻结计划与日志分析工具，执行模式offline_fixture。120条语料仍为草稿，创始人签收后应冻结hash、开始日期、批准速率/页数/并发/预算、类目及时间窗口。

每天每查询一次，按固定语料顺序分配UTC 00/08/16三个时段，各40条，共14天1680个计划任务。这个默认日程仅供准备，实际频率以批准额度和签收计划为准。分母保留所有计划任务，未执行和失败均入报告。分页和增量重试记在同一个计划任务下，每页请求按Collector已有的最多3次及总预算/deadline控制。

```sh
python3 step0/tools/stability_report.py --start 2026-12-01
python3 step0/tools/stability_report.py --start 2026-12-01 --results /path/to/permitted-results.jsonl
```

开始日仅为示例。工具读取语料和本地JSONL，每行包含task_id、mode、started_at、finished_at、attempts、first_semantic_success、semantic_success、billable、pages、bytes、cpu_ms、cost_cents、evidence_ref。task_id格式为`YYYY-MM-DD/query_id`，mode限offline_fixture或authorized_online。一次完整任务只写一行终态，attempts记录全部分页和重试请求总次数。

semantic_success为预算和deadline内取得符合该query和结构的有效结果，HTTP200错误页必须填false。first_semantic_success表示全部所需页在第一次尝试即语义成功，需要原始分请求证据，不能从attempts总数反推，因为正常分页也会产生多次请求。billable另要求权利有效、新鲜且合格价格样本至少8条。字段完整性、实际价核验率与Precision/Recall由字段/金标报告另核验，不以成功标志替代。

报告按日、类目、头尾输出计划/启动/首试语义成功/有界最终成功/可收费数、资源和成本。已报告任务的耗时P95、成本P50/P95及最贵ceil(5%×n)任务平均成本单列，费用分位数用Type7有理数。已报告任务只要一项成本未知，该组成本分布保留null。计划缺失任务使计划总成本保持null，已知观察成本及样本数仍透明列出。混合离线/在线记录直接拒绝。authorized_online输入必须带证据引用，报告保留externalEvidenceVerified=false等待独立核验，G0签署由创始人负责。

连续线上14天须逐日有效证据齐全，遵准入和真实自然日执行，保留原始失败记录。工具不发送请求、不调度联网任务，真实运行器在许可取得后按实际来源字段实现。
