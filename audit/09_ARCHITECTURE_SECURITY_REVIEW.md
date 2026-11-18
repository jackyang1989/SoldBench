# 09 · 架构、安全与运营

审计基线 808b9875，2026-11-18。沿 v1.4 §4/8/13、DEC-05/08/11、ADR-12/13 核查本机产品、PG16、采集、研究与支付 worker、媒体、管理及隐私恢复。结论为 **RELEASE_BLOCKED**。保留共享查询服务、PG 事务账本和独立采集进程。生产数据库权限、部署资源、告警接收人、密钥保管人及外部恢复证明均为 **NOT VERIFIED**。

## 从请求到持久状态

| 边界 | 已实现的保护与行为 | 限制、风险及验证 |
|---|---|---|
| Hono → 领域服务 | apps/api/src/index.ts 登记请求 ID、no-store、CSP、nosniff；MCP、REST 研究经 QueryService，运营端调同一补偿事务 | SSR 主页为 fixture。预发布在 CDN 和反代验证 no-store、Secure cookie、真实 origin，检查代理日志对分享 token、Authorization 的脱敏 |
| 查询 → PG → 交付 | owner 锁、作业 CAS、租约、去重和显式领取；packages/query/src/index.ts、迁移 0010。重试、重启和余额竞争见 tests/query-billing.test.mjs:215、429、585 | PG 为强依赖。每进程池上限 20，语句 10s，连接等待 5s（packages/db/src/index.ts:9）。扩容前按进程数核算连接预算，实测事务锁等待 |
| 来源和媒体 | 合成采集进程拒绝 HTTP 跳转，读取检查权限，媒体私有，源 URL 加密；0013–0016 控制刷新、退休及预算，0022 绑定存储归属 | 真实出口、对象服务和 CDN 清除无运行证据。演练技术熔断和权利撤销，后者即使有旧查询也应拒读对象与导出 |
| 迁移和隔离 | 0001–0022 顺序追加；迁移 SHA、advisory lock、逐文件事务。关键唯一约束见 0010、0018；owner 分页见 tests/query-billing.test.mjs:671 | compose 用户/密码供 loopback。上线前分开 DDL 与运行账号，逐迁移评估锁表、旧版兼容、回退空间。离线入口差异见 S1 |
| 数据量 | 0005 采集队列、0017 请求日志、0021 工单有指定索引；清理设批上限。暂保 PG 队列，Redis 无独有权益记录 | 没有真实基数/分区收益。按每表日增长、90 天留存、查询计划、索引与备份体积、最坏回放估容量；先定向索引与清理再考虑分区 |
| 故障域 | API 与 Collector 解耦，已有快照/账户功能无需在线采集。tests/readiness.test.mjs:97 覆盖故障及 24/48/72h 界线 | 历史 150 个本地分享请求、50 并发、p95 31.09ms，见 step0/evidence/outage-readiness-20261118/validation.json。16GB 开发机、热分享与本机 PG；目标 2vCPU/4GB 下混合搜索/领取/支付、冷缓存和移动 4G 未测 |
| 后台与 API | 查询、支付、隐私与保留任务复用 PG，scripts/query-worker.mjs 轮行处理，适合小团队 | scripts/dev.mjs:22 在 worker 非零退出时终止 API。上线需独立进程监督。停 worker 保留已交付只读及账单，暴露积压年龄，重启只发一份权益 |

## 安全边界与检验

- **口令、会话、MFA**。scrypt 独立盐、固定参数；敏感密文 AES-GCM、HMAC 分用途，见 packages/auth/src/crypto.ts:29、57。Cookie HttpOnly、SameSite=Lax，写请求按 origin/CSRF 与当前身份复核。验证/重置、管理员 MFA、恢复码并发见 tests/auth-access.test.mjs:69、104、148、222、324。预发布验证真实邮件、过期、HTTPS、反代及密钥轮换。
- **密钥、租户、导出**。数据库只存 key 摘要，创建/旋转只展示一次，scope、owner、撤销在权限事务复核；tests/auth-access.test.mjs:148、186。查询历史存在认证契约差异 A3。导出依当前字段权利。实际代理、跟踪平台与基础设施日志的脱敏需在部署后用合成凭据验证。
- **注入、输出、外部调用**。抽查 PG 调用绑定参数，清理任务的动态表名取固定集合（packages/auth/src/privacy.ts:182）。HTML 使用 React SSR；HTTP 夹具只访问指定 loopback、拒绝重定向、限制响应（packages/collector/src/http-transport.ts）。XSS、CSP、图像解码和第三方出口须随正式前端/来源接入重验。
- **滥用与管理**。用户、网络和匿名交付预算分层；管理写入限会话、同源、CSRF、当前角色与近期认证，管理员另需 MFA，命令具备 CAS、幂等与原因摘要（apps/api/src/operations.ts:73、operations-domain.ts:33，tests/operations.test.mjs:128）。支持入口只识别 socket 对端，每小时 8 次成功新申请；反代后用户可能共用预算。预发布验证独立客户不会相互耗尽配额，外部自填转发头不具备授信。
- **软件供应链**。CI 的 actions 固定 SHA，contents 只读、关闭 checkout 凭证持久化；npm ci 使用锁文件。安装 apt/pip/npm 与业务测试的断网约束应分别审计。本轮 npm audit --offline --ignore-scripts --json 退出 0，缓存报告 0 项，当天在线通告未验证。对 apps、packages、infra、脚本、测试、step0、docs、CI 与配置样例做三类常见高置信私钥/密钥格式匹配，未命中；未覆盖所有凭据格式。上线前按最终镜像、锁文件与通告快照复核。
- **删除与出站**。近期认证后同事务禁用会话、key、分享并撤匿名发布，分批清查询正文，保留财务事实。回执 30 天有效，支持响应丢失后查询（packages/auth/src/privacy.ts:61、107、182）。第三方支付终止、法定保留、给用户的正式通知与邮件服务待验收。
- **请求重放**。支付回执和交易分别防重，来源命令有版本与幂等键。验证时同时比较账本、订阅、余额与审计记录。重复 webhook、过期会话、跨 owner 游标、错误商户与错误事件签名的已有用例见 tests/payments.test.mjs、tests/query-billing.test.mjs。渠道原生验签见 10 的 B1。

## 值班人员实际能做什么

| 操作 | 现有接口或证据 | 首发最小交付 |
|---|---|---|
| 数据源暂停/撤销、采集积压、质量事件 | /admin/sources、命令、探针与 /admin/jobs；限离线来源，探针不会重启采集 | 权利投诉 → 定位 clearance/epoch → 拒分发 → 检查积压清理与抽样回放 → 有权负责人复开 |
| 查询失败和 API 用量 | 失败作业可受控重排，检查 owner、幂等和尝试上限；请求日志分 owner | 按请求 ID 串联工单、作业与账本。先做低样本率、排队年龄和连续失败汇总 |
| 额度、支付、退款和争议 | /admin/billing、指定 charge 的 refund-credit 留审计；没有任意余额增减 | 现金退款和退 1 credit 要分别追踪。渠道日结差异和受控人工处理优先 |
| 用户及异常账号 | 身份读取检查 user status/role 与 MFA；已有暂停访问测试。无完整管理页 | 受控停用/撤销、理由和复核；客户分群与全功能 CRM 延后 |
| 支持/下架 | 同源提交获 202 编号，未接通知，记录到期清理 | 限定最小读取权限、处理责任人与回复途径，见 S2 |
| 调价、预算和利润 | offline-v1 报价绑定，真实成本输入空，见 10 | 首发用签署版配置与月度对账，旧交易留原报价。复杂可视化调价后台延后 |
| 部署、告警、回退 | 本机 compose、/health、/ready、RB-1 至 RB-7 及自动迁移 | 按变更版本、观察窗口、停止新收费/采集、兼容旧读者及对账演练，指定接警人 |

## 待整改事项

| ID / 级别 / 状态 | 事实、触发和影响 | 拟修复、依赖和验收 |
|---|---|---|
| S1 / P1 / 开放 · 离线 DB 目标 | apps/api/src/server.ts:13–19 仅付款夹具开启时检查目标为本机，随后自动迁移；scripts/migrate.mjs:4 直接接收环境 URL。误配有效外部 DB 可能执行 DDL。query worker 无条件检查说明已有保护可复用。静态控制流判定，未触及外部数据库 | 离线入口建池前统一校验。生产迁移独立为显式受控步骤。模拟连接器验证非本机目标在 DNS/连接前拒绝，专用 PG16 正常升级。工程负责人，TASK-011/012 |
| S2 / P1 / 开放 · 支持与下架 | apps/api/src/operations.ts:103–173 仅提供提交与管理来源/任务/账务/审计。缺工单领取、回应或 SLA；匿名提交没有回访字段。tests/operations.test.mjs:72 验证提交、去重与清理。用户收到 accepted 却无法确认处理，权利投诉可能过期 | 先用受控队列或经授权帮助台承接，按角色读取最小必要正文并审计；提供私密状态回执或同意留联系方式。合成 takedown 与账务异议验证收件、分派、处置、回执、到期、支持角色隔离。TASK-034/035，先定联系人和留存 |
| S3 / P0 / 发布阻断 · 灾备与撤权 | scripts/privacy-recovery.mjs 和 privacy.ts:269、329 只导出/恢复 account 标记。签名保护真实性，缺外置最新性证明。step0/evidence/account-privacy-20261118/validation.json 保留源撤销和生产备份/RPO/RTO。旧而有效的清单或缺失来源标记，恢复时有重新开放过期数据风险；未观察到生产泄漏 | 外置最新水位、密钥和备份保管、账户与来源撤销清单。隔离恢复主库/对象，逐测 key、媒体、分享、历史、账本；拒绝旧清单，核验最新性并对账后才接流量。记录恢复点、切换和耗时并按 DEC-11 的 RPO 24h/RTO 4h 签收。TASK-039/040/042，运维与非实现者 |
| S4 / P1 / 开放 · 故障域与监控 | scripts/dev.mjs:22 在 worker 非零退出后终止 API；apps/api/src/index.ts 的 ready 仅 SELECT 1。原稿 §13 的延迟/积压、撤权清理及支付差异告警尚无部署拓扑验收。短时停机与积压状态绿都有可能 | 保持本机入口，预发布独立监督 worker/API/Collector，显示可读性、作业陈旧程度、通道状态。逐个终止组件，实测已交付读取可用、超预算拒绝新任务、告警到人及恢复无重扣。TASK-038/040，需实际环境与接警人 |

**反方复核**独立确认 /v1/queries 的偏差局限于同一 owner 的认证方式；取消作业涉及 204 空体与 200 JSON 的差别。两项均可在 apps/api/src/queries.ts:96、229、248 与 OpenAPI 的 listQueries/cancelJob 交叉定位。正式源许可、生产供应链、外网边界及运维人员签收均为 NOT VERIFIED。
