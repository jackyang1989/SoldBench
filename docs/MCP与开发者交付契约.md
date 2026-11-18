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

## A6 上手、费用恢复与版本验收（2026-11-19）

| 证据字段 | 写入条件 | 808b987 基线 |
|---|---|---|
| contract_defined | 冻结 OpenAPI 或明确工具定义有此操作 | 65 个 REST 操作，MCP 工具有独立定义 |
| route_registered | 构建的实际路由表可定位 | REST 63/65；categories、data-status 未挂载 |
| fixture_runnable | 输入使用合成模式且操作可通过本机服务发起 | 查价、作业轮询、显式领取、已交付读取、日志、模拟支付各按环境准备 |
| behavior_verified | 有同版正反例、请求响应、必要时账本和隔离证据 | 逐操作查证，A1–A5/D3 保留差异；发布验收另验 |

从干净环境使用 [仓库示例及安装说明](../developer/skills/soldbench/references/examples.md)，创建专用本机 PG16 的 demo，使用其输出的私有环境文件。该文件须由两个 shell 及宿主进程读取一致的 API/worker 设置。不要将凭据写入共享配置、参数、截图或日志。上线目标地址待域名和 TLS 签收，以下入口均指已启动的本机实例。

| 顺序 | 动作及断言 |
|---|---|
| 准备身份 | 演示 key 来自本机工具；网页验收另从空账户验证邮箱并用 Session 创建 key，保存一次显示的明文。查价、作业和日志分别服从操作 scope。撤销后再次请求须拒绝；已付结果仍可由有效 owner 身份取回。 |
| 首次调用 | 保持默认 Nintendo Switch OLED，运行 `node developer/examples/sold.ts`、`python3 developer/examples/sold.py`、`sh developer/examples/sold.sh`。三个客户端使用同一 owner 与条件。让 worker 暂停或固定排队，记录 202、job_id、query_id；恢复 worker 后按 GET job 轮询，记录 completed 及首次 GET 的 409 result_not_claimed。 |
| 领取与复取 | 明确同意最多 1 credit 后，沿原 query ID 显式 POST claim。执行现有客户端的 `--claim` 测试可在同一十分钟复用窗重新拿到原结果。脚本每次运行仅在本次进程内复用自己的键。集成应用要在发出前持久保存原 query_id、授权和幂等键；断线后先 GET 原结果，仍 409 时沿原键重试。再执行其余客户端应为同一原快照且费用 0。 |
| 错误与账务 | 控制本机限额和来源水位，分别采 429（Retry-After、有界等待）与 503（供数不可用说明、request_id），确认等待/失败为 0。申请额度不足留下可领取状态。GET /v1/usage 核对账本且 GET /v1/requests 用 cursor、page_size、channel、operation、status 核对日志。error_code 来自响应字段。 |
| 输出 | 记录 request_id、状态码、候选 hash、实际积分、是否复取。REST 默认 50、最多 200；MCP 同一计算身份仅展示最多 20 行，统计使用完整获准快照。UI 从已读结果调整显示行数属于本地呈现，改变新查询传入的 limit 遵当前查询规范并需明确提交。 |

### 两个拟验收宿主

选用 VS Code 的 Copilot harness 与 Claude Code 作为 TASK-037 两个目标，尚需以实际版本试跑。两者的工作区 `.mcp.json` 可用以下 HTTP 入口及环境变量引用。VS Code 也可用个人 Copilot 配置。将 URL 中端口替换为本机演示输出的实际端口，并由可信宿主继承私有进程环境。目标域名切换需要服务端部署证据。配置路径与格式应按实际宿主版本确认。[VS Code 配置](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) · [Claude Code 配置](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)

```json
{
  "mcpServers": {
    "soldbench": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${SOLDBENCH_API_KEY}"
      }
    }
  }
}
```

在每个宿主记录实际产品、客户端及协议版本、配置作用范围、服务端 SHA 和测试账号角色。按 `initialize → tools/list → sold_search(search) → status → result → 用户同意 → claim → result/sold_stats` 保存空账号、拒绝费用、同意领取和撤销 key 四类结果。确认在用户拒绝时无扣费，与 REST 用同一合成条件复取时不双扣。记录 20 行演示可在 58 价格输入夹具中进行。SDK/HTTP 探针证据另存，两个宿主目前均为待验收。

### 发布与兼容

发布记录按日期和版本列操作 ID、变更前后请求与响应、受影响 scope/身份/费用、旧客户端兼容窗口、迁移步骤和回退门。权限增加、查询规范变更、日期精度和历史语义先进入 DEC 及影响检查；冻结后同步 OpenAPI 及 fixtures、Web/REST/MCP、Skill 与中英文 changelog。A1–A5/D3 参考协议差异卡，当前错误字段说明按 A6 纠正。破坏性 REST 更新按原稿 §9.1 升到 /v2，发布弃用通知并保留 /v1 至少 6 个月。下线或更改已公布行为时须核对客户使用面并由负责人签出迁移期和兼容回归。操作清单由构建生成，行为证据由对应 TASK 记录。[协议差异](接口与数据契约.md) · [验收](验收矩阵.md)
