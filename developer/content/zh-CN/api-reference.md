# 接口参考

通过 [OpenAPI 文档](/openapi.json) 查看参数、响应结构和稳定错误码。通过 [本机路由状态](/docs/implementation-status.json) 核对哪些路由已注册、哪些仍在契约中。路由注册本身不代表功能已启用或验收。[Postman 集合](/soldbench.postman.json) 中的 API 密钥为空，也没有自动领取结果的脚本。

## 研究接口

- 通过 `GET /v1/sold` 提交规范查询，再轮询返回的作业。符合条件的结果应先向用户展示最高费用并取得确认，再调用 `POST /v1/sold/{id}/claim`。
- 使用 `GET /v1/sold/{id}` 读取已交付结果，使用 `GET /v1/sold/{id}/comps/{event_id}` 核查单条证据，通过返回的 `/v1/media/{image_id}` 相对地址读取获准主图。
- 用 `GET /v1/sold/{id}/diagnostics` 查看纳排原因，使用 `GET /v1/sold/{id}/calculation-inputs` 取得获准的完整样本输入，或使用 `POST /v1/sold/{id}/export` 导出已交付快照。
- 使用 `GET /v1/requests` 查看本人请求，用 `GET /v1/usage` 查询额度桶和账本。

集成前可以打开 [浏览器调试台](/zh-CN/playground)，或阅读 [错误与安全重试](/docs/zh-CN/errors-and-retries)。
