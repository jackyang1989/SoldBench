# 来源准入准备记录

2026-11-16。用户明确目前没有来源许可，先做离线开发与准入准备。拟目标eBay US，不假定任何入口已获准；线上自动访问、原文存储、商业统计/分享/API再分发均未获证实。

唯一登记见 [source-clearance.csv](source-clearance.csv)，当前NOT_CLEARED不是有效source_clearances active记录。`COLLECTOR_ENABLED=false`、`COLLECTOR_MODE=offline_fixture`，生产来源ID不得用合成source替代。

待收集：实际适用地区和协议版本、允许方法/入口、字段、频率/并发/分页预算、原文/派生存储期限、actual价可得依据、逐条/统计/分享/API权利、到期与停止义务、平台要求的许可及专业方审核、责任人和受控文档hash。按 [采集专项](../docs/采集稳定性专项规格.md)逐项核对。

现可准备申请业务说明、离线框架/字段表、需求/成本及测试计划。未获准时没有14天线上成功率结论；账号、公开网页、技术可访问都不作为授权材料。

已准备20项 [字段能力清单](source-capabilities.csv)，当前全部unverified。`python3 step0/tools/readiness.py`列出逐项权利、期限、速率及字段证据缺口。该工具仅检查资料状态，审批原件及实际字段需责任人复核。获准测试的计划与报告口径见 [连续验证准备](online-validation-plan.md)。
