# 成交搜索与覆盖

GET /v1/sold?q=Nintendo%20Switch%20OLED 返回 202、query_id 和 job_id。当前实现仅 eBay 美国站和 USD。limit 默认 50、上限 200；中心统计使用完整快照，不随展示截断。先筛型号、容量和版本等强属性，混合机型不能代表同款价。改变 limit 会改变规范参数，但 MCP 的展示上限不会。缺失字段不造值。历史仅覆盖获准留存观测；请求 90 天不代表保证 90 天完整覆盖，更不代表全市场销量。未开放三年历史或其他平台。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。
