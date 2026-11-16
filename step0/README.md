# 第 0 步执行入口

当前 `NOT_READY`，已有合成统计夹具、完整OpenAPI/SQL设计及校验，已有 [离线Collector PoC](collector-poc/README.md)，尚无网络Collector；无来源准入、线上运行、访谈、支付审批、成本实测或签署GO证据。采集专项见 [稳定性规格](../docs/采集稳定性专项规格.md)，实际准入准备见 [access-rights](access-rights.md)。先读 [AGENTS](../AGENTS.md)、原稿§3、[TASK-001…010台账](../docs/开发排期与任务台账.md)。

## 允许现在推进

1. 维护规格和决策，登记已知与缺失证据。
2. 用有权持有的离线fixture实现自研PoC、parser、质量/日期/价格/预算和断源模拟。代码仅放step0；默认禁外网。
3. 维护已准备的120条草稿查询及人工独立标注规程，完成获准候选标注和创始人冻结签收。
4. 准备访谈提纲与单位经济表；联系人员、实际花费、正式发信按用户具体授权执行。

当前新增可运行：`node --test step0/collector-poc/tests/*.test.ts` 与 `node step0/collector-poc/src/cli.ts`（Node22.18+，合成回放，零网络路径）。

原有可运行：`python3 step0/tools/verify_fixture.py` 及 `python3 docs/contracts/check_contracts.py`（依赖见contracts README）。它不会网络访问、不会建立数据库、不会更改原始JSON；可从任意目录执行。扩展PoC也必须显式offline/approved模式并fail closed，不能默认联网。

## 必须形成的证据包

| 产物 | 必填内容 | 谁提供/验收 |
|---|---|---|
| access-rights / source-clearance | 平台/入口/方法/字段/目的/地域/速率；获取/保存/统计/展示/分享/API各权限；生效/失效/终止；书面证据受控引用 | 创始人/专业方/平台 |
| legal-review引用 | 实际适用协议地区版本、风险备忘录及不能被意见替代的许可清单 | 专业方，原件不入公开仓库 |
| payment-review | 商业主体、产品与来源如实申报、获选渠道产品审核状态、实际费率 | 创始人/渠道 |
| corpus/labels | 六组各20、头/尾各10、属性、候选全集、标注来源、分歧/仲裁、冻结hash | 数据审核/创始人 |
| collector-poc | 自有源码、锁包/版本、离线测试、获准线上复现README、出口清单 | 工程/独立复核 |
| online-validation | 连续14天日志，首次/最终成功率、每类质量/缺失、完整资源消耗；失败日不删 | 工程/数据审核 |
| interviews | 10–15个真实目标受访者脱敏、问题/用量/预算/迁移障碍；≥3明确预算承诺目标 | 创始人/客户 |
| unit-economics | 乐观/基准/压力、满额Pro、免费/失败分摊、许可/维护费、现金与毛利分开 | 创始人/工程 |
| independence-audit | 源码/依赖/镜像/出口与账单；外部代抓取0；普通基础设施可迁移 | 非实现者 |
| outage-drill | 模拟0/24/48/72h/撤销/恢复，是否真实停机、时钟注入说明、限制 | 工程/独立复核 |
| verdict | 五门证据、OPEN、明确决定和创始人签署 | 创始人 |

证据结构模板见 [evidence-template](evidence-template.md)。没有证据就标缺失，不创建假合同/假访谈/假网络日志。获准线上前核验clearance，权限到期或收到停止要求即停；线上14天不可用离线回放压缩替代。

## 成本与语料模板字段

语料：`id,group,keyword,tier,expected_attrs,ground_truth_notes,freeze_hash,reviewer`。标注：`corpus_id,event_ref,is_comparable,price_status,price_evidence,expected_primary_reason,labeler,adjudicator,decision`。

资源：`run_id,source_clearance_ref,request/page/byte_count,cpu_ms,storage_bytes,retries,failed_cost,permission_cost,maintenance_hours,unit_price_basis,measurement_date`。经营：`scenario,plan,monthly_queries,cache_hit_ratio,insufficient_ratio,free_request_allocation,net_revenue,total_variable_cost,margin,assumed_or_measured,evidence_ref`。

分母为0时单位成本/毛利输出unknown，不能除零后填0。费率必须有测量/签约日期，原稿$8/GB与支付5%+$0.50只是旧演算假设，不作为真实账单。

## GO前的最小交接

先完成TASK-003离线PoC与TASK-004语料；填写TASK-001中实际有/缺的准入信息，保留可并行文档准备。TASK-005在现有复核工具上补边界夹具。当前不能跳到S-01脚手架、支付、正式页面。

整包运行入口为`python3 step0/tools/validate_offline.py`，开发依赖安装见PoC README。120条草稿见 [查询语料](corpus.csv)，标注与签收见 [质量规程](quality-plan.md)，断源模拟见 [演练说明](outage-drill.md)。

来源缺项用`python3 step0/tools/readiness.py`检查。成本输入与执行见 [成本工具](unit-economics/README.md)，真实数据表保留未知值，假设场景用于压力演算。已准备 [访谈提纲](interviews.md) 和 [14天验证计划与分析入口](online-validation-plan.md)，实际访谈和获准线上运行待执行。
