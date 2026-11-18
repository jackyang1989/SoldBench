# 公开页与工作台逐页对照

2026-11-18，808b987。用新浏览器对两个语言的首页真实输入和提交，结果 [浏览器走查](evidence/run/browser-walkthrough.md)。本机[44 个页面探针](evidence/run/local-page-routes.json)使用 Hono 空服务进行静态 HTTP 对照，503 项另到完整本机服务确认业务条件。营销抓取文字为网页公开证据。登录后对手工作台、一次收费、导出及实时结果的真实性未验证。70%/20%/10% 按用户指定设计研究比例。

## 公开页面

| SoldBench 页面与目标 | 当前行为、对手观察 | 优先级与具体验收 |
|---|---|---|
| / 和 /zh-CN，首次查价 | 有文字字标、三项轻导航、无样例成交表；表单 404。CompSniper 公共 Docs 有首次调用、配额与工作流章节。sold-comps.com 首页有输入、趋势、示例表和 JSON，SoldComps.io 导航直达查价、Agents、文档和定价 | U1 P0，输入后进入直接结果或缓存未命中。中文切换不改变费用；移动桌面同语义。首页用有出处的例屏，保留一次合成提示 |
| /markets、/categories/:slug，发现覆盖 | 当前 404。CompSniper Pricing 拆站点与来源，SoldComps.io Docs 写实际支持站点及历史窗 | U4 P1，只列允许数据和属性，更新时间/状态可操作；未开放和撤销不出结果。AT-043/074 |
| /agents 和 /mcp，安装支援 | /agents 404，/mcp 是协议。SoldComps.io Agents 有宿主安装、用量和证据边界，CompSniper 有 MCP 及 Skill 安装页 | U3 P1，两个真实宿主演示，网页明确 key 如何安全配置、重试/停止与领取。AT-045/057 |
| /docs，开发上手 | 302→英文 Markdown。存在两种语言的八篇资源，缺产品导航和可见文档体验。CompSniper Docs 分类、搜索、TOC、速率与错误集中可找 | U3 P1，做双语侧边目录、锚点、可复制脚本、可见搜索、版本入口。AT-050/055/057 |
| /pricing，判断是否付费 | 404，候选报价仅本机模拟。三家各有定价页，CompSniper 公开档和同表用量，SoldComps.io 给条数 on-cost，sold-comps.com 给按次及配额 | U4 P1，说明 Free、订阅与按量包、样本/复取/取消条件、已批准价格。AT-037/055 |
| /compare/:slug 或 /alternatives，知情选择 | 404。SoldComps.io 定价底部索引 Alternatives，sold-comps.com 首页有比较入口 | U4 P1（内容细项 P2），按市场/时间/实际价资格/费用/分发/来源证据公开版本，缺证列未验证。AT-043 |
| /guides/:slug，解释研究 | 404。SoldComps.io 导航索引指南、使用案例、方法与卖家工具 | U4 P1（内容细项 P2），10–20原创按可信字段发布，过时或失权 noindex。AT-043 |
| /changelog，订阅变化 | 200 Markdown。CompSniper Changelog 可阅读日期和行为变更 | U4 P1（内容细项 P2），明确日期、迁移、兼容、原版链接和内容可访问；AT-057 |
| /methodology，理解可信度 | 404。SoldComps.io 定价与工具提供方法入口 | U4 P1，阈值、样本分母、Best Offer 与运费、Type7、合成边界和问题反馈。AT-017/051 |
| /status，了解供数 | 后端状态接口，页面流程未完成。CompSniper 文档的开放市场是静态比较，不作为实际状态 | U4 P1，按类目水位、可用窗口、延迟和事件时间线显示。AT-048 |
| /login、/register、/verify-email、找回，建立账号 | GET 目标入口均 404。三家公开首页有 Sign in/Get key，引导入口可见，登录后未核 | U1 P0，安全 return_to，提交后保留用户任务。错 token、找回/重试、验证后首额可见。AT-031/032 |
| /contact、/support、/terms、/privacy | 页面均 404，首页 mailto。SoldComps.io 定价尾部有明确退款/条款/隐私，sold-comps.com 首页有联系入口 | U4 P1，受控提交/回执，真正经营主体、条款归属与语言签收。AT-051/055 |
| /share/:token，私有研究分享 | 有后端投影，旧/失效令牌用统一不可用。对手对应页面 NOT VERIFIED | U4 P1，令牌沙盒/源码和双语可见错误、绝不共享 owner/账本、失权销毁。AT-044 |

## 工作台

| 页面 | 活动证据与对照 | 改进及验收 |
|---|---|---|
| Overview /account | 404，CompSniper 公开 Dashboard 入口，签入布局未验 | U1 P0，一处“新研究”主按钮，左导航和低高度账户区。空用户可走到首次任务 |
| Search /research、Results /results/:id | 404，而两家公开示例能看筛选/数据表/JSON。竞品实际导出未验 | U1 P0，单行统一控制高度、响应式列宽；标题/图原页直达、独立详情及原页面失效；统计和完整输入自由滚动。AT-025/035/056/059/074/075 |
| 历史 /account/queries | 404，API 支持复取但权限存在差异。竞品历史未验 | U2 P1，历史、过期、失权、只读仍免费。收藏提醒属于后续 |
| Async Jobs | 无独立活动页，jobs 有 API，取消需契约修正。竞品签入进度未验 | U2 P1，研究内显示状态、有效取消、重试领取、刷新；高频用户再加列表 |
| Playground /playground | 404，CompSniper docs 提供真实 Quickstart 与 API 参考，工作台未验 | U3 P1，显示状态/Headers/JSON/实际扣费，复制示例不含真实 key |
| API Keys /account/keys | 404，后端 scope/撤销/一次明文已验证。竞品签入按钮未验 | U2 P1，安全显示和复制、新旧轮换/404、恢复引导。AT-033/060 |
| Usage /account/usage 与 Logs | 404，后端账本与请求审计存在。sold-comps.com 营销描述用量 Dashboard，实测未验 | U2 P1，余额桶、循环和请求 ID 可筛选，按消费与错误状态核对。AT-036/058 |
| Billing /account/billing | 404，模拟 checkout，三家均有公开定价与升级入口，付费后台未验 | U2 P1，付前显示当期金额、回跳等到账和失败恢复、退款及取消期限 |
| Security /account/security | 404，会话撤销/TOTP/删除后端存在。CompSniper Docs 公开 2FA 说明 | U2 P1，明确会话与恢复码一次性展示、删除前提醒，与真实邮件分开验收 |
| Support 和 /admin/sources、jobs、billing、audit | 受控后端存在，缺专门可见任务屏。竞品内部运营未验 | U2 P1，先满足小团队停源、状态、账务、人审、审计和错误恢复，保留最小角色 |

## 设计反馈复核

活动首页使用浏览器默认 CSS，能直接看到页面层级、字标和合成提示。没有独立 Sign in 样式、后台侧栏/滚动条/账户区、新研究 CTA 簇或完整筛选表。历史稿可由台账 §43 的 stash 追溯，不能把历史问题计作现行视觉。后续用 320/390/768/1440px 和键盘证明无整页溢出、表格区域横滚、焦点/错误摘要、行列基线与顶部高度一致。将每种内容的最长文本、双语、真实空态和错误回到桌面与移动截图。竞品版式仅借鉴交互路径，不评价未看到的后台。三个公开源为 [CompSniper Docs](https://compsniper.com/docs) · [SoldComps.io Agents](https://www.soldcomps.io/agents) · [sold-comps.com 首页](https://sold-comps.com/)。

## 对照证据与不可比较项

2026-11-18 对三站的公开页面做同任务横向阅读。对手的价格、成交、覆盖与成功率为其自述。下表只用以支持交互和信息架构判断；未在任一站发起数据查询、注册或交易。CompSniper 的 Dashboard 实际跳转到登录，不能根据文档推断登录后的按钮、密度、列宽和边栏。内部工具本轮没有可用的竞品截图，没有完成受限页面逐页视觉对照。[CompSniper Dashboard](https://compsniper.com/dashboard)

| 同一任务 | 对照页面实际呈现 | SoldBench 的取舍与验收 |
|---|---|---|
| 首次查价 | CompSniper 首页并列关键词输入、示例行/摘要与 API 片段；SoldComps.io 首页给出首次用户怎样读中位数、排除行和如何细化关键词；sold-comps.com 让人先看紧凑的价格/日期行和响应 | 当前首页只有表单和说明。首屏保留一个主要搜索动作；结果先给已核验样本、口径和时点，API 引导居次。不要将竞品显示的型号混排、实时或历史覆盖写进自己的承诺。[CompSniper](https://compsniper.com/) · [SoldComps.io](https://www.soldcomps.io/) · [sold-comps.com](https://sold-comps.com/) |
| 查 API 错误、集成 Agent | CompSniper 文档入口可直达认证、限流、错误、分页与按任务的参考页；SoldComps.io Agents 展开不同宿主的连接方式；sold-comps.com Docs 并排给出多语言请求、说明 usage/requests | 建议 Docs 首屏从“获取 key—第一次调用—为什么未领取—核对账本”串起，Playground 进入已授权快照。固定本机稿/未来生产 URL 明确分隔。原料在 developer/content 与 examples；同页 HTML 和机器 Markdown 共用源。[CompSniper Docs](https://compsniper.com/docs) · [SoldComps.io Agents](https://www.soldcomps.io/agents) · [sold-comps.com Docs](https://sold-comps.com/docs) |
| 理解费用、状态和变更 | SoldComps.io 有按每次返回尺寸的算例；sold-comps.com 把各项服务状态及当前事件分开；CompSniper 的变更记录逐条附日期和涉及的行为 | 借鉴算例结构，以 SoldBench 同查询 50/200 条且至多 1 credit、轮询免费举例。状态页首屏区分许可、故障、延迟和空样本；缺状态显示未知。发布日志区分离线工程、预发布及公开可用。[Pricing](https://www.soldcomps.io/pricing) · [系统状态](https://sold-comps.com/status) · [Changelog](https://compsniper.com/changelog) |
| 学习属性与比较方法 | SoldComps.io 的指南按基础、卡牌和其他类目分组，把用户引回查询；Docs 有对比入口 | PAGE-W07/W08 首先解释单一获准类别的强属性和数据缺口，每篇给更新时间、复核人、方法与查价入口。Alternatives 用同日可核实的口径、权限、成本与覆盖列，未测项保留未知。[Guides](https://www.soldcomps.io/blog) · [Docs](https://www.soldcomps.io/docs) |

### 验收时应分别走查的页面

| 页面 | 首个成功动作 | 失败与权限验收 | 级别 |
|---|---|---|---|
| /verify-email | 已注册用户输入一次性凭证、看见可用权益 | 重放、过期和离线投件延迟可恢复；新用户仅一次 Free grant | U1 |
| /forgot-password、/reset-password | 提交后给通用确认，设置新密码 | 过期可重发，完成后旧会话不能继续研究；URL 不进入分析日志 | U1 |
| /contact 或 /support | 提交分类、描述及可选 request_id；得到回执 | 429 保留表单，提供重试时间；不得截取含密钥的请求头 | U4 |
| /terms | 选择语言，读取当次注册的条款版本 | 条款变更保存各版本与接受事实；实际主体、价格、退款和渠道需签收 | U4 |
| /privacy | 识别类别、保留、联系入口与删除回执 | 说明删除后保留账务原因、备份恢复处置；链接导航不自动提交删除 | U4 |
| /admin/sources | 有角色及近期 MFA 的操作者查看时效、权限与 epoch | 停源和撤权各自确认；冲突保留原因、刷新状态；避免按钮误授权 | U2 |
| /admin/jobs | 查找某次未完任务，判断是否可重排 | 终态、预算、停源和权利撤回各自拒绝；与用户 job/领取语义区分 | U2 |
| /admin/billing | 按 charge 查询流水并申请唯一额度补偿 | 两次提交仍可对账；现金退款走渠道、列当前进度；无余额编辑 | U2 |
| /admin/audit | 从事件定位 source / job / charge 及原因 | 无权看原文/key；导出删除与恢复证据可供非实现者复核 | U2 |

页眉、页脚、搜索与深链另需在同一份原型逐项量测。当前页眉只有文本品牌和三条导航，页脚只有 mailto，缺品牌文字和页间导航；无法重现历史版“字标太小”的尺寸。当前未定义页面布局 CSS、canonical、hreflang 或结构化产品内容，noindex 符合离线阶段。后续只对签收后的公开内容启用索引；账户、分享和测试内容继续隔离。以 320/390px 和桌面两种语言的最长标题、未知运费、空图、空状态和键盘焦点截图验证，不以 CSS 值或可打开页面作为通过条件。[活动首页](../apps/web/src/index.tsx) · [页面规格](../docs/功能与页面规格.md)

详情中的 listing_url 有 present/missing/withheld 状态，当前 fixture 仅接受受控的 HTTPS example.test 子域。不得把 fixture 域或自行拼出的 eBay ID 做成可访问的真实证据。上线前在获得许可的素材上，分别验标题/图片直达原页和独立详情按钮。主图仍由本服务授权读取。已下架、失效或无许可时，展示本次合成/历史证据的可用字段与状态。对手的网页原始链接可访问性与 SoldBench 的源链接有效率均为 NOT VERIFIED。[research.ts](../packages/query/src/research.ts)

独立浏览器复核测量双语首页 320/390/768/1440px，各档 `scrollWidth=clientWidth`。390px 英文的文本标签与输入无额外间距，输入占位截断且提交按钮换行。手机 Dashboard、工作台表格与完整键盘流程仍待活动页面。 [浏览器记录](evidence/run/browser-walkthrough.md)
