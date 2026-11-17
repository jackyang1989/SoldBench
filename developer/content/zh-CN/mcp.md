# MCP 与 Agent Skill

POST /mcp 为无状态 Streamable HTTP，Bearer API key 鉴权；支持 2026-07-28 和 legacy 2025-11-25。无 Cookie、OAuth 或持久订阅流。Host 须匹配配置 origin，传入 Origin 也须完全一致。请求 ≤128 KiB，不支持 JSON-RPC 批量。

sold_search 分 search(query)、status(job_id)、result(query_id)、claim(query_id,idempotency_key) 四动作；领取需要明确授权。sold_stats 仅读已有可读快照。MCP 最多展示 20 条，但完整统计和 REST 查询身份不变。检查 structuredContent、isError、实际 credits_charged 和 synthetic 标记。

Skill 索引为 /.well-known/skills/index.json，写客户端前阅读 SKILL.md 和引用。Skill 教如何集成，MCP 执行工具；都不授予来源访问权，也不允许静默消费。宿主配置须明确，密钥使用其支持的安全存储。生产目标 https://soldbench.com/mcp 尚未部署，本机工程入口为 http://127.0.0.1:3000/mcp。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。
