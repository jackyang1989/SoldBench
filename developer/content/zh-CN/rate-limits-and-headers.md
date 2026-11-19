# 限流与请求头

限流按账户计算，多创建 API 密钥不会增加可用次数。遇到 `429` 时至少等待 `Retry-After` 指定的秒数，再按有限次数重试。每个作业同时最多保留一个轮询，终态后停止。速率限制和余额是独立检查。

## 请求和响应追踪

- 仅从可信服务端发送带 API 密钥的 `Authorization: Bearer`，避免将密钥放在示例 URL 或截图中。
- 以同一查询 ID 重试领取时沿用 `Idempotency-Key`。变更操作需使用新键，结果不明确时先取回原查询或作业。
- 使用 `X-Request-ID` 关联本人请求日志或报给客服。私有响应的缓存行为由相应接口的 `Cache-Control` 决定。
- `meta.credits_charged` 表示本次响应的扣费，`meta.query_total_credits_charged` 表示当前查询的扣费。重新打开仍获准的已交付结果不会再扣费。

参见 [异步作业](/docs/zh-CN/async-jobs)、[错误恢复](/docs/zh-CN/errors-and-retries) 和 [服务状态](/status)。
