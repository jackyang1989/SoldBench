# 集成工具与账户安全

从 [TypeScript 示例](/examples/sold.ts)、[Python 示例](/examples/sold.py) 或 [cURL 示例](/examples/sold.sh) 开始。[快速开始](/docs/zh-CN/quickstart) 说明启动方式和显式领取流程。遇到失败时，保留查询 ID、作业 ID、请求 ID 和领取幂等键，以便确认原操作结果。若要生成客户端，可使用 [接口契约](/openapi.json)。

## 账户安全

在 [账户安全](/zh-CN/account/security) 中绑定基于时间的验证器、验证动态码，并私密保存只显示一次的恢复码。敏感操作可能要求重新认证。请分开保存浏览器会话凭据与服务端 API 密钥。

## Agent 与 MCP

用 [Agent Skill](/.well-known/skills/soldbench/SKILL.md) 向编码助手提供集成规则。使用 [MCP](/docs/zh-CN/mcp) 让获得授权的助手调用查价和结果工具。执行可能产生扣费的领取前应取得明确确认。实现变更见 [开发者更新记录](/changelog)。
