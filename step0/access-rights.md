# 来源准入准备记录

2026-11-16。用户明确目前没有来源许可，先做离线开发与准入准备。拟目标eBay US，不假定任何入口已获准；线上自动访问、原文存储、商业统计/分享/API再分发均未获证实。

唯一登记见 [source-clearance.csv](source-clearance.csv)，当前NOT_CLEARED不是有效source_clearances active记录。`COLLECTOR_ENABLED=false`、`DATA_MODE=offline_fixture`，生产来源ID不得用合成source替代。

待收集：实际适用地区和协议版本、允许方法/入口、字段、频率/并发/分页预算、原文/派生存储期限、actual价可得依据、逐条/统计/分享/API权利、到期与停止义务、平台要求的许可及专业方审核、责任人和受控文档hash。按 [采集专项](../docs/采集稳定性专项规格.md)逐项核对。

现可准备申请业务说明、离线框架/字段表、需求/成本及测试计划。未获准时没有14天线上成功率结论；账号、公开网页、技术可访问都不作为授权材料。

已准备 45 项[字段能力清单](source-capabilities.csv)，当前全部未核验。`python3 step0/tools/readiness.py` 对每个 eBay US 候选检查 45 个字段名，分别报告缺行、已有行但无实测、逐字段权利材料缺项和主图专项缺项。把字段设为 `available_verified` 仍须填写它自己的权利材料。当前工具只检查登记和引用是否齐备，权利原件、期限与实际用途由责任人复核。获准测试的计划与报告口径见[连续验证准备](online-validation-plan.md)。

### 主图单独授权

主图首发必须在来源准入表逐项登记 `media_capture`、`media_store`、`media_process`、`media_display`、`media_redistribution`。字段使用allowed/denied/unknown。为图片单独登记 `media_retention_days` 与受控 `media_evidence_ref`，保留证据原件和许可用途。使用 `python3 step0/tools/readiness.py` 检查缺项。主图候选、角色、归属证据和尺寸四项分别记录获准实测、证据引用与解析版本；缺目录行也会报告。该检查只验证材料填写及引用，仍须责任人验证真实依据与签署。没有主图权利时不得借用成交数据的通用许可。

## 逐字段审批、分发与清除

以 `source_candidate + field` 连接 [45 项字段底表](source-capabilities.csv) 与候选来源。底表新增权利、有效期和执行责任列，字段可获得性与实际使用批准是分别填写的事实。使用限制按来源与字段两层的交集执行。

| 申请记录 | 填写与复核要求 |
|---|---|
| `approved_field_entrypoint`、`rights_evidence_ref`、`region` | 明确获准的接口/路径或交付文件及条款版本，填写适用地区与受控原件引用、条款定位及 hash。获准样本的可用性继续写原有 `evidence_ref` 与 `parser_version` |
| `approved_uses` | 逐用途标 allowed/denied/unknown，覆盖自动获取、原始保存、派生保存与统计、站内逐行展示、分享、导出、API/MCP 再分发。系统内部字段注明仅限内部。卖家身份按获准用途处理，交付仅允许合规聚合 |
| `rights_effective_at`、`rights_expires_at`、`retention_days` | 记录 UTC 生效、到期和保留期限。字段期限受来源和使用目的约束。记录原始、派生和媒体期限差异，未知期间维持拒绝 |
| `revocation_trigger`、`cleanup_owner_role` | 登记撤权通知入口、拒读范围、需要清除的对象、快照、分享和导出缓存及执行人。审计引用保存在受控区，源内容按实际许可期限处理 |
| `approval_status` | 来源责任人填事实，创始人复核来源、用途和证据，运营确认可以停止与清除。权利变更保留旧版签收和新生效时间，重新核准后才开启相应范围 |

部分撤权更新权限版本和受影响用途。若统计依赖被撤销的用途，停止相应结果直至可出示仍获权的快照。撤回主图子权利时先拒读主图再处理对象和缓存，成交身份和价格仍依独立成交权利决定。整源撤销按手册检查现行分发面及旧备份。当前准备工具检查材料缺项，逐字段用途、实际许可和清除回执由责任人独立签收。[恢复手册](../docs/发布、回滚与撤权恢复手册.md)
