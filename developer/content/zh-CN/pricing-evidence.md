# 价格与研究证据

价格为 USD 整数分，未知为 null。默认实际价统计排除未知接受报价、强属性不匹配和口径所需但未知的运费。分位 Type 7、最终 half-up、两端各 floor(5%×n) 截尾；合格样本 <8 中心统计 null、8–29 有限、≥30 足量；质量总分始终 null。IQR 离群仅标记，不静默删样本。

详情与诊断展示当前获准字段的 present/missing/withheld 状态及纳排决定。导出基于完整获准价格输入，不随展示 limit 截断；调整导出可排除指定事件，不修改权威结果或产生新收费。图片使用受控引用，每次读检当前权利，不回上游 URL。快照保存过也不能绕过撤销。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。

泛词查询请读取 `quality.comparison_scope` 和 `mixed_models` 警告。混合样本的统计描述多款观察到的型号，给用户提供可选型号以继续查价。`single_model_label_observed` 表示样本共享一个型号标签，仍可能有不同品牌、容量和版本。`unresolved` 表示缺少足够的结构化型号证据。旧快照或当前无属性权限时，该字段可能缺省。
