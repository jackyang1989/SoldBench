# MCP 与开发者交付契约

2026-11-17，TASK-037离线工程。继承原稿§9.4、ADR-12/13、查询账本契约和DEC-13；不会启用真实来源/支付/发布。

## MCP

采用官方TypeScript SDK v2固定2.4.0，无状态Streamable HTTP，兼容官方当前2026-07-28协商和2025-11-25 stateless客户端；不自写会话/JSON-RPC状态机。POST /mcp只接受Bearer API key，不接Cookie/session；每请求及每次业务动作复查key/scopes，沿QueryService共用owner限流和账本。Origin存在时须精确匹配本机配置，Host须为配置域名端口，当前只监听loopback。请求体128KiB，总处理时间有界，错误不含token/SQL/堆栈。

仅两个工具：

- sold_search(action=search,query=SoldQuery)：共享normalizer提交查询，返回job/query及轮询路径；默认不自动领取/扣费。规范query默认limit与REST一致（50），MCP交付仅展示前20行，不改变统计/收费/底层候选hash。
- sold_search(action=status,job_id)：同GET jobs，需jobs:read；不泄漏未领取结果。
- sold_search(action=result,query_id)：免费复取已交付结果；未领取付费结果返回稳定result_not_claimed及claim提示。
- sold_search(action=claim,query_id,idempotency_key)：调用方在明确同意最多1credit后显式请求，同POST claim原子结算；轮询/失败/重复领取沿原规则免费。
- sold_stats(query_id)：仅从本人已可读快照读取stats/quality/supplemental/meta，未领取不绕过；不因“stats”自动发起新查询。

工具错误使用isError=true和结构化稳定code/message/details/request_id；协议/鉴权错误由SDK/HTTP适配返回相应状态。MCP输出保留候选hash/版本/新鲜度/合成标记与实际费用，前20条截断需注明mcp_presentation_limit。数据字段、图片引用与REST权限相同，不回上游URL/私有对象key。无OAuth元数据或自动外部发现，不代用户添加宿主配置。

MCP每个业务调用写RequestAuditService，channel=mcp；具体search/status/result/claim及stats可区分，不重复记查询收费。Key撤销/来源撤销每次立即拒绝，断源后仍能读取有权历史；同owner同规范query跨REST/MCP复用，不以MCP展示20条修改query.limit制造重复收费。

## 开发者交付

公开只读静态资产：/.well-known/skills/index.json、/.well-known/skills/soldbench/SKILL.md及references、/llms.txt、/llms-full.txt、/openapi.json；文档地址为/docs下双语Markdown与本地搜索索引。由版本库输入/冻结OpenAPI生成固定路径，不允许URL参数读任意文件。目标生产地址仅作为未来部署配置，当前示例默认loopback且清楚标记synthetic。

示例读取SOLDBENCH_API_KEY环境变量，不硬编码/打印密钥，不在浏览器保存。展示202→有界轮询→明确允许后claim→免费GET及中位数/样本量；429遵Retry-After、5xx有界退避，400/402/403和quota错误不盲重试。claim响应不确定时重用同幂等key或GET结果，不新建查询补偿网络错误。TS/Python/curl必须实际运行本机集成；金额为整数分，未知不作0，样本不是市场销量。

Skill只是产品客户端指南，不修改用户环境、发送消息、建立收费订阅或授予采集权。参考文件分离接口说明/例子；SDK官方Skills扩展非必需，先交付稳定可发现静态Skill包。

验证：官方SDK客户端与独立HTTP协议探针、两协议版本协商、无key/错key/撤销、未知工具/非法参数、scope隔离、job等待/402/claim幂等/REST复用、MCP20行与全量统计、当前字段/源撤销、日志费用一致；两主流宿主客户端、生产TLS/域名及真实来源仍单独验收，不用协议测试冒充。

参考：官方[SDK发布](https://github.com/modelcontextprotocol/typescript-sdk/releases)、[Server说明](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/README.md)、[2026协议迁移](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)。这些是接口依据，不是SoldBench已部署证明。

## 交付入口与限制

双语8页Markdown位于developer/content/{en,zh-CN}；/docs转en快速开始，/docs/search最多20条本地全文包含匹配，不代表已设计文档网页。构建从冻结OpenAPI、owned内容、Skill与示例生成固定注册表，HTTP不按输入路径读文件。/docs/implementation-status.json只标路由存在，contract-only与真实验收分开。

TS/Python/curl示例读取私有环境变量，--claim为明确允许，省略停在409；curl需同目录Python客户端做JSON与轮询，HTTP由curl执行，首参数--disable忽略用户curlrc，不跟重定向。最多3次暂时失败重试，Retry-After超过30秒返回retry_later，不提前重试；轮询40次有界。凭证不入argv/输出，UUID验证后只构造固定本源路径。MCP请求体流式128KiB，30秒请求信号、拒绝批量；stats-only返回comp计数0并注明stats_only。

developer:demo仅专用本机PG、synthetic非登录身份与0600密钥文件，重跑撤销旧演示key。环境文件含LOCAL_STATE_ROOT、MEDIA_ROOT与本机数据库等一致配置；先导入，再启动实际API和query-worker，避免各自生成不同认证authority。真实来源、真实账号/邮件与实际支付审批不因演示解锁。CI固定官方Action提交运行离线脚本；未观察GitHub执行前不写远端通过。
