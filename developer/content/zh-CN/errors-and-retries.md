# 错误、重试与审计

根据 error.code、request_id 和 details 处理错误。429 尊重 Retry-After，暂时 5xx/网络失败有限重试；400/401/402/403 和 quota_exceeded 停止盲重试。stale 须明确接受、免费且不得标 fresh；过期或撤销不继续分发。MCP 工具可能 HTTP 200 但 isError=true。

GET /v1/requests 要求 owner 和 usage:read，展示 30 天最小请求元数据、操作/渠道、错误码、实际 credit 和 charge/账本引用，不记录原始搜索词、密钥、请求体或 IP。资金事务成功后审计写失败不能改成扣费失败；应查账及复取，不能另扣一次。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。
