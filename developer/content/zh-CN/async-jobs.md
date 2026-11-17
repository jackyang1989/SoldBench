# 异步交付与显式领取

查询返回 202。有限次数轮询 GET /v1/jobs/{job_id}；queued/running 非终态，failed/cancelled/expired 为失败终态。completed 不代表已结算。GET /v1/sold/{query_id} 可读免费/已交付结果；409 result_not_claimed 需要调用方明确同意后，携带固定 Idempotency-Key POST claim。每有效查询最多 1 credit。领取响应不确定时以同 key 重试或 GET 现有结果，不再发一条查询补偿。轮询及重复 GET 免费；作业成功不代表结果永不过期，需保留 expires_at。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。
