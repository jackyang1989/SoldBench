# 查询语料与独立标注规程

TASK-004 的离线准备于 2026-11-16 形成。`corpus.csv` 包含六组各 20 条、每组计划头部和长尾各 10 条。头尾分层来自人工编排，搜索量尚待实测。`corpus-manifest.json` 固定当前草稿 hash，创始人签收与人工金标待补。

## 冻结与抽样

1. 创始人及类目审核者逐条确认型号、版本、评级、语言、成色和附件口径。当前 `expected_attrs` 只是预期约束，审核后细化为对应 taxonomy 的强属性。
2. 记录所有修订及原因，重新生成 hash，经创始人签收后冻结。线上固定语料期间保留失败查询，禁止以更换难例改善成功率。
3. 取得来源准入后保存允许持有的完整候选集合及 hash。每组首轮探索至少 100 条，覆盖头尾、正反例、未核验议价、运费缺失、日期边界和身份不明记录。
4. 正式盲测预留独立 holdout，登记查询及事件分组，避免同事件跨开发集和留出集。留出比例由实际类别和样本规模确定并在调参前冻结。

## 标注与仲裁

从 `labels/template.csv` 复制新文件，每条关联 query、候选 hash、来源和受控证据引用。两位独立审核者分别判断可比性、实际成交价、事件身份和主要排除原因，保留原标注及分歧。仲裁者在新记录中说明理由与依据，原记录只追加版本。

审核者先看原始证据，模型预标和竞品结论在独立判断后揭示。无法证实的实际价、时区或身份标 unknown，强属性冲突标排除。每个实际价必须能指向成交依据，展示价本身不足以证明 Best Offer 的实际价。

## 报告与发布

按来源、细分类目和头尾分别输出 TP/FP/FN、Precision、Recall、样本量及 95% Wilson 区间。分母为零输出 null。价格误差只对有人工核验实际价的同口径集合计算，同时披露剔除数及原因。不能把六组合计作为失败类目的发布依据。

开发人员运行 `python3 step0/tools/check_corpus.py` 检查结构和草稿 hash，独立审核者复算质量，创始人签收开放类目。当前人工标注数为零，线上精度、召回及覆盖均待验证。

## 本地质量报告入口

```sh
python3 step0/tools/quality_report.py step0/labels/quality-input-empty.json
```

输入schema为soldbench.quality-input.v1，evidence_kind为synthetic或human_adjudicated。snapshots每项包含query_id、带来源前缀的稳定candidate_ids、candidate_set_hash、candidate_set_complete、split及受控evidence_ref。split为development或holdout，按稳定事件分组后固定。rows关联query_id/candidate_id，包含gold_comparable（允许null）、predicted_comparable、gold_price_cents、predicted_price_cents。金额均为已经核验同一USD口径的整数分，未知填null。

human_adjudicated要求每行至少两个不同annotator_ids和adjudication_ref，快照另附证据引用。引用的真实性及独立性由非实现者核验。CSV原始双人标注在仲裁后汇成该JSON，保留原始记录，不能把模型预标当人工金标。

工具对照候选manifest查缺失/重复标注，未知或缺失真值使该组Precision/Recall保留null。不完整候选快照的Recall保留null。TP/FP/FN/TN及样本数始终可诊断，Wilson区间按95%输出。Recall仅在已观察候选范围解释，市场覆盖继续独立披露。

价格中位偏差按每个query分别计算，禁止混合不同商品价格。沿用既有黄金算例的整数/有理数算法，双方有价样本均至少8条才形成中心统计，金标中位为0时相对误差null。未知实际价的排除数量以人工价格字段和计数核对。报告提供类目、头尾和开发/留出分层，releaseApproved始终false，质量总分null。当前空输入模板输出零标注及null指标。

## 每日分母与类目签收记录

- **冻结前**。标注负责人导出 6 组 × 20 条，共 120 条查询。每组预定 10 条头部和 10 条长尾。每条记录规范属性、批准窗口、站点、query ID、版本和 hash。按来源稳定事件分组切 development/holdout，并登记所属快照，重复 listing 的观察不得扩增成交；身份无法确认的记录单独报告。未核验字段保持 unknown。
- **每个获准自然日**。汇报 day × 类目 × 头尾的计划、未启动、停止、首试成功、最终语义成功、可收费资格及各失败原因。批准重试保留在原任务，缺页、空结果、挑战、HTTP 错误页、预算停止和未执行要分别记录。成功率和可收费率用固定计划分母。价格核验率、事件识别、运费/主图完整性分别列分子与分母；主图还列有效图片权利与实物可读。失败日不能从报告删去。
- **盲测交付**。保存两份独立人工标注、分歧与仲裁、生效证据、候选与留出 hash。逐类目报告原门槛、头尾支持量、置信区间与 FAIL/INSUFFICIENT/READY_FOR_REVIEW。低覆盖、未知身份或无足量金标的类目保留限制，不向其他类目借样本。报告签收行填写 `category / source clearance / run window UTC / parser + cleaner / coverage / precision + recall / price deviation / missing fields / result / reviewer / founder / proof`。
- **两个独立观察窗口**。TASK-007 连续 14 天受准入、冻结和独立原始证据约束。起止日、观察计划、停机/续跑在执行前签收。G1 继续按实际生产型部署观察 7 天，单独记录资源、隔离、后台恢复与告警。只有通过质量和准入的类目才可提交开放评审。[逐日执行](online-validation-plan.md) · [阶段签收](verdict.md)
