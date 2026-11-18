# 项目资料清单

盘点对象为 Git 提交 `808b9875d0f5a0ff005ddb37b8fb1c579b7ec7cd` 的全部 476 个文件。起始工作区无已跟踪变更及非忽略的新文件。日期取该路径最近一次 Git 提交作者时间（含时区），不取文件复制时间。原名保留在路径末段。版本栏无独立声明时，以该提交作为精确版本。

版本裁决按 AGENTS → v1.4 活动原稿与勘误 → DEC 与专题 ADR → 冻结契约 → 实现 → 分层验收证据。v1.3 通过 v1.4 修订记录可追溯，本树没有独立的 v1.3 原件。原始 v1.4 在 docs/baselines，已否决的视觉草稿在台账 §43 的 stash 引用。已提交树内没有 PDF、DOCX、XLSX 或图片截图库。

范围还检查了忽略路径的文件类型。node_modules、dist、tsbuildinfo、step0/artifacts 是依赖、生成资源和重复运行输出；.local 含旧 QA 运行器/状态及本机数据库，凭证、私有状态和数据库页未转录。历史 evidence 的版本以各自 manifest/日志为准。下面的“现行”表示当前树资产，未将设计、测试文件或历史日志提升为生产功能。

| 精确路径（含原名） | 标题或内容 | 类型／模块 | 文件版本 | 最近提交 | 状态、问题及处置 |
|---|---|---|---|---|---|
| `.env.example` | 离线模式与回环入口 | 环境样例 / 项目基线 | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `.gitattributes` | .gitattributes | 工程配置 / 项目基线 | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `.github/workflows/offline.yml` | 离线工程、PG16 与契约检查 | CI / .github | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `.gitignore` | .gitignore | 工程配置 / 项目基线 | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `AGENTS.md` | SoldBench Agent 执行规范 · 1. 目标与工作区 · 2. 阅读顺序与权威关系 | 说明/规格 / 项目基线 | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `README.md` | SoldBench · 当前状态（2026-11-17） · 阅读入口 | 说明/规格 / 项目基线 | 基线提交 | 2026-11-18T19:05:08+08:00 | 冲突/历史叠加，见 02 和 16 |
| `SoldBench 开发规格书 v1.4.md` | SoldBench 开发规格书 v1.4 · v1.3 → v1.4 本轮变更（保留 v1.3 的全部统计、计费与质量修订） · v1.4 技术决策（不可解释成可选项） | 说明/规格 / 项目基线 | 1.4 | 2026-11-18T17:47:05+08:00 | 现行，保留 |
| `agent.md` | Agent 入口 | 说明/规格 / 项目基线 | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `apps/api/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / apps/api | 0.1.0 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `apps/api/src/auth.ts` | mountAuth | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T08:16:17+08:00 | 现行，保留 |
| `apps/api/src/developer.ts` | mountDeveloper | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `apps/api/src/index.ts` | createApp | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T08:36:46+08:00 | 现行，保留 |
| `apps/api/src/mcp.ts` | mountMcp | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `apps/api/src/operations-domain.ts` | OperationsService | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `apps/api/src/operations.ts` | mountOperations | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `apps/api/src/payments.ts` | mountPayments | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `apps/api/src/public-results.ts` | mountPublicResults | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T08:07:47+08:00 | 现行，保留 |
| `apps/api/src/queries.ts` | mountQueries | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T08:07:47+08:00 | 现行，保留 |
| `apps/api/src/server.ts` | server | 执行/业务源码 / apps/api | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `apps/api/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / apps/api | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `apps/web/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / apps/web | 0.1.0 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `apps/web/src/index.tsx` | renderHome | 执行/业务源码 / apps/web | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `apps/web/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / apps/web | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `biome.json` | 键 $schema, vcs, files, formatter, linter, assist | 配置/结构化记录 / 项目基线 | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `developer/changelog.md` | SoldBench engineering changelog · 2026-11-18 — observed search context · 2026-11-18 — model scope on price samples | 说明/规格 / developer | 基线提交 | 2026-11-18T18:05:34+08:00 | 现行，保留 |
| `developer/content/en/async-jobs.md` | Asynchronous delivery and claims | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/en/authentication.md` | Authentication and keys | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/en/billing-and-credits.md` | Credits and payment boundaries | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `developer/content/en/errors-and-retries.md` | Errors, retries and audit | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/en/mcp.md` | MCP and Agent Skill | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/en/pricing-evidence.md` | Prices and research evidence | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `developer/content/en/quickstart.md` | Quickstart | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T18:16:22+08:00 | 现行，保留 |
| `developer/content/en/sold-search.md` | Sold search and coverage | 集成指南 / developer/content/en | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/zh-CN/async-jobs.md` | 异步交付与显式领取 | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/zh-CN/authentication.md` | 鉴权与密钥 | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/zh-CN/billing-and-credits.md` | 额度与支付边界 | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `developer/content/zh-CN/errors-and-retries.md` | 错误、重试与审计 | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/zh-CN/mcp.md` | MCP 与 Agent Skill | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/content/zh-CN/pricing-evidence.md` | 价格与研究证据 | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `developer/content/zh-CN/quickstart.md` | 快速开始 | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T18:16:22+08:00 | 现行，保留 |
| `developer/content/zh-CN/sold-search.md` | 成交搜索与覆盖 | 集成指南 / developer/content/zh-CN | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/examples/sold.py` | __init__, redirect_request, resource_id, sold_price, send | 执行/业务源码 / developer | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/examples/sold.sh` | sold | 执行/业务源码 / developer | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/examples/sold.ts` | ClientError, soldPrice | 执行/业务源码 / developer | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/examples/tsconfig.json` | 键 compilerOptions, include | 配置/结构化记录 / developer | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/skills/soldbench/SKILL.md` | SoldBench | 集成指南 / developer | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/skills/soldbench/agents/openai.yaml` | openai | 工程配置 / developer | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `developer/skills/soldbench/references/api-reference.md` | SoldBench client reference | 集成指南 / developer | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `developer/skills/soldbench/references/examples.md` | Running examples · Import the same private file in a second private shell before running a client. | 集成指南 / developer | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `docs/Agent接手指南.md` | SoldBench Agent 接手指南 · 1. 产品是什么 · 2. 仓库权威文件和读取顺序 | 说明/规格 / docs | 基线提交 | 2026-11-18T19:08:03+08:00 | 冲突/历史叠加，见 02 和 16 |
| `docs/MCP与开发者交付契约.md` | MCP 与开发者交付契约 · MCP · 开发者交付 | 说明/规格 / docs | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `docs/Stripe与PayPal接入规格.md` | Stripe与PayPal接入规格 · 1. 交付范围与启用条件 · 2. Checkout及渠道隔离 | 说明/规格 / docs | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `docs/adr/ADR-11.md` | ADR-11：v1.4 实施解释、冲突登记与任务入口 · 已明确的工程解释 · 尚不可自行裁决 | 决策 / docs | 1.4 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `docs/adr/ADR-12.md` | ADR-12：离线开发契约冻结与真实接入边界 · 1. 异步交付结算 · 2. 时间和未知事件 | 决策 / docs | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/adr/ADR-13.md` | ADR-13 · 完整离线产品工程与执行顺序 | 决策 / docs | 基线提交 | 2026-11-16T22:01:46+08:00 | 现行，保留 |
| `docs/adr/ADR-14.md` | ADR-14 · 身份凭据与安全命令的重试语义 | 决策 / docs | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `docs/baselines/SoldBench-v1.4-original.md` | SoldBench 开发规格书 v1.4 · v1.3 → v1.4 本轮变更（保留 v1.3 的全部统计、计费与质量修订） · v1.4 技术决策（不可解释成可选项） | 说明/规格 / docs | 1.4 | 2026-11-16T11:11:49+08:00 | 历史，保留不可覆盖 |
| `docs/check_docs.py` | require, text, defined_ids | 执行/业务源码 / docs | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `docs/contracts/README.md` | 契约验证入口 · Python环境 · PostgreSQL16验证 | 说明/规格 / docs/contracts/README.md | 基线提交 | 2026-11-17T16:39:38+08:00 | 冲突/历史叠加，见 02 和 16 |
| `docs/contracts/check_contracts.py` | construct_mapping, require, validator, walk, rejected | 执行/业务源码 / docs/contracts/check_contracts.py | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `docs/contracts/fixtures/auth-mfa-confirmed.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `docs/contracts/fixtures/auth-mfa-pending.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `docs/contracts/fixtures/auth-mfa-status.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `docs/contracts/fixtures/auth-token-expired.json` | 键 error | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `docs/contracts/fixtures/calculation-inputs-58.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/data-expired.json` | 键 error | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/job-completed-unclaimed.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/manifest.json` | 15 条数组记录 | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `docs/contracts/fixtures/result-unclaimed.json` | 键 error | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/search-supplemental.json` | 键 mean_cents, sample_count, shipping_summary, seller_summary, recent_30d, previous_30d | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `docs/contracts/fixtures/sold-200-50.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/sold-200-empty.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/sold-200-low-sample.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/sold-200-stale.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/sold-202.json` | 键 data, meta | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/fixtures/source-forbidden.json` | 键 error | 合成数据 / docs/contracts/fixtures | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/requirements.txt` | requirements | 工程配置 / docs/contracts/requirements.txt | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/contracts/schema.sql` | users、sessions、auth_tokens、api_keys | 数据库 / docs/contracts/schema.sql | 基线提交 | 2026-11-16T20:14:43+08:00 | 历史初始结构，保留并对照迁移 |
| `docs/contracts/verify.sql` | pg_temp | 数据库 / docs/contracts/verify.sql | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/evidence/contracts-20261116/documentation.log` | contracts-20261116 / documentation | 执行证据 / docs/evidence/contracts-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/evidence/contracts-20261116/golden_fixture.log` | contracts-20261116 / golden_fixture | 执行证据 / docs/evidence/contracts-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/evidence/contracts-20261116/pg16_identity.log` | contracts-20261116 / pg16_identity | 执行证据 / docs/evidence/contracts-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/evidence/contracts-20261116/pg16_schema_and_relations.log` | contracts-20261116 / pg16_schema_and_relations | 执行证据 / docs/evidence/contracts-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/evidence/contracts-20261116/schema_and_openapi.log` | contracts-20261116 / schema_and_openapi | 执行证据 / docs/evidence/contracts-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/evidence/contracts-20261116/validation.json` | contracts-20261116 / validation | 执行证据 / docs/evidence/contracts-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/evidence/i18n-20261116/validation.json` | i18n-20261116 / validation | 执行证据 / docs/evidence/i18n-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/evidence/payments-20261116/validation.json` | payments-20261116 / validation | 执行证据 / docs/evidence/payments-20261116 | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `docs/openapi.yaml` | 操作、请求/响应、错误与权限 | 接口契约 / docs | 1.16.0 | 2026-11-18T18:05:34+08:00 | 现行；运行差异见 07 |
| `docs/progress.md` | 进度入口 | 说明/规格 / docs | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/公开结果离线实施契约.md` | 匿名缓存与受控分享 | 说明/规格 / docs | 基线提交 | 2026-11-18T08:07:47+08:00 | 现行，保留 |
| `docs/决策登记.md` | 决策登记 · 继续执行的边界 · 决定记录 | 说明/规格 / docs | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `docs/功能与页面规格.md` | 功能与页面规格 · 1. 用户与权限 · 2. 功能到交付关系 | 说明/规格 / docs | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `docs/商业系统开发前缺口审查.md` | 商业系统开发前缺口审查 · 1. 本次发现及处理 · 2. 必须具备的商业能力与实际缺口 | 说明/规格 / docs | 基线提交 | 2026-11-16T20:14:43+08:00 | 历史评估，按日期引用并复核 |
| `docs/国际站点规划与品牌评估_20261116.md` | 国际站点规划与品牌评估 · 1. 当前缺口 · 2. 候选国家站点路线 | 说明/规格 / docs | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史评估，按日期引用并复核 |
| `docs/多语言与商业交付补充规格.md` | 多语言与商业交付补充规格 · 1. 语言、站点与金额分别处理 · 1.1 后续站点与当地语言共同发布 | 说明/规格 / docs | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/工程实施规格.md` | 工程实施规格 · 1. 架构与模块责任 · 2. 查询规范化与快照 | 说明/规格 / docs | 基线提交 | 2026-11-17T08:04:53+08:00 | 冲突/历史叠加，见 02 和 16 |
| `docs/开发就绪检查.md` | 开发就绪检查 · 1. 已补齐的开发输入 · 2. 开工范围 | 说明/规格 / docs | 基线提交 | 2026-11-16T20:14:43+08:00 | 历史评估，按日期引用并复核 |
| `docs/开发排期与任务台账.md` | 开发排期与任务台账 · 1. 当前开工边界 · 2. 估算口径 | 说明/规格 / docs | 基线提交 | 2026-11-18T19:08:03+08:00 | 现行，保留 |
| `docs/执行与交接模板.md` | 执行与交接模板 · 1. 开工记录 · 2. 完成/交接记录 | 说明/规格 / docs | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `docs/接口与数据契约.md` | 接口与数据契约 · 1. 共同规则 · 2. 接口目录 | 说明/规格 / docs | 基线提交 | 2026-11-18T08:26:31+08:00 | 冲突/历史叠加，见 02 和 16 |
| `docs/搜索页采集字段与统计契约.md` | 搜索页采集字段与统计契约 · 1. 核对结论 · 2. 截图元素逐项映射 | 说明/规格 / docs | 基线提交 | 2026-11-18T18:05:34+08:00 | 现行，保留 |
| `docs/收款渠道评估与接入路线_20261116.md` | 收款渠道评估与接入路线 · 1. 首次建议选择路径（已由用户决定覆盖） · 2. 官方资料与适用性 | 说明/规格 / docs | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史评估，按日期引用并复核 |
| `docs/文档交付核对.md` | 文档交付核对 · 1. 本轮交付 · 2. 实际检查 | 说明/规格 / docs | 基线提交 | 2026-11-16T20:14:43+08:00 | 历史评估，按日期引用并复核 |
| `docs/查询账本与交付实施契约.md` | 查询账本与交付实施契约 · 1. 身份与快照 · 2. 余额与流水 | 说明/规格 / docs | 基线提交 | 2026-11-18T08:36:46+08:00 | 现行，保留 |
| `docs/竞品核查与差异化建议_20261116.md` | SoldBench 竞品核查与差异化建议 · 1. 对目前定位的修正 · 2. 两篇文章应该怎样读 | 说明/规格 / docs | 基线提交 | 2026-11-16T20:14:43+08:00 | 历史评估，按日期引用并复核 |
| `docs/竞品能力实施规格与路线图.md` | 竞品能力实施规格与路线图 · 1. 发布范围与执行顺序 · 2. 全量差距与任务映射 | 说明/规格 / docs | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `docs/账户与访问实施契约.md` | 账户与访问实施契约 | 说明/规格 / docs | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `docs/账户删除与恢复保护实施契约.md` | 账户删除与恢复保护 · 把 DATABASE_URL 明确指向已恢复、未接入流量的专用测试库。 | 说明/规格 / docs | 基线提交 | 2026-11-18T08:16:17+08:00 | 现行，保留 |
| `docs/运营后端实施契约.md` | 支持与运营后端 | 说明/规格 / docs | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `docs/采集稳定性专项规格.md` | eBay 已售数据采集稳定性专项规格 · 1. 首要结论与来源调查 · 2. 字段可得性先于解析实现 | 说明/规格 / docs | 1.0 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `docs/采集管线实施契约.md` | 自研采集与证据管线实施契约 · 1. 本包交付及真实入口边界 · 2. 并发与预算规则 | 说明/规格 / docs | 基线提交 | 2026-11-18T19:05:08+08:00 | 现行，保留 |
| `docs/项目审查与优化建议.md` | SoldBench 项目审查与优化建议 · 1. 结论 · 2. 已发现的缺口 | 说明/规格 / docs | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史评估，按日期引用并复核 |
| `docs/验收矩阵.md` | 验收矩阵 · 1. 执行用例 · 2. 阶段出口 | 验收/质量 / docs | 基线提交 | 2026-11-18T19:05:08+08:00 | 现行，保留 |
| `infra/compose.yaml` | compose | 工程配置 / infra | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `package-lock.json` | 键 name, version, lockfileVersion, requires, packages | 配置/结构化记录 / 项目基线 | 0.1.0 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `package.json` | 键 name, version, private, type, workspaces, engines | 配置/结构化记录 / 项目基线 | 0.1.0 | 2026-11-18T08:36:46+08:00 | 现行，保留 |
| `packages/auth/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/auth | 0.1.0 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `packages/auth/src/crypto.ts` | AuthSecrets, newAuthSecrets, AuthCrypto, hashPassword, verifyPassword | 执行/业务源码 / packages/auth | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `packages/auth/src/index.ts` | index | 执行/业务源码 / packages/auth | 基线提交 | 2026-11-18T08:16:17+08:00 | 现行，保留 |
| `packages/auth/src/local.ts` | localAuthSecrets | 执行/业务源码 / packages/auth | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `packages/auth/src/privacy.ts` | AccountPrivacy | 执行/业务源码 / packages/auth | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `packages/auth/src/service.ts` | AUTH_VERSION, Identity, AuthContext, emailAddress, passwordValue | 执行/业务源码 / packages/auth | 基线提交 | 2026-11-18T08:16:17+08:00 | 现行，保留 |
| `packages/auth/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/auth | 基线提交 | 2026-11-17T07:28:48+08:00 | 现行，保留 |
| `packages/billing/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/billing | 0.1.0 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `packages/billing/src/index.ts` | BILLING_VERSION, freePeriod, Grant, BillingService | 执行/业务源码 / packages/billing | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `packages/billing/src/local-payment-keys.ts` | localPaymentKeys | 执行/业务源码 / packages/billing | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `packages/billing/src/payment-fixtures.ts` | providers, Provider, merchant, factSchema, PaymentFact | 执行/业务源码 / packages/billing | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `packages/billing/src/payment-lifecycle.ts` | offerVersion, PaymentLifecycle | 执行/业务源码 / packages/billing | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `packages/billing/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/billing | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `packages/collector/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/collector | 0.1.0 | 2026-11-17T00:02:45+08:00 | 现行，保留 |
| `packages/collector/src/access-guard.ts` | AccessMethod, AccessPurpose, ClearanceStatus, SourceClearance, CollectorSource | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/collector/src/artifact.ts` | FixtureArtifact, createFixtureArtifact, loadFixtureArtifact | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-17T00:02:45+08:00 | 现行，保留 |
| `packages/collector/src/config-snapshot.ts` | SourceSnapshot, ConfigSnapshot, collectorConfigHash | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-17T21:01:13+08:00 | 现行，保留 |
| `packages/collector/src/fixture.ts` | COLLECTOR_VERSION, PARSER_VERSION, FixtureListing, FixturePage, FixtureResponse | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T18:05:34+08:00 | 现行，保留 |
| `packages/collector/src/health.ts` | collectorHealth | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T19:05:08+08:00 | 现行，保留 |
| `packages/collector/src/html.ts` | HtmlProfile, validateHtmlProfile, hasHtmlAccessBlock, parseHtmlMoney, parseHtmlPage | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T18:05:34+08:00 | 现行，保留 |
| `packages/collector/src/http-transport.ts` | LoopbackRoute, LoopbackHttpTransport | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-17T21:08:38+08:00 | 现行，保留 |
| `packages/collector/src/index.ts` | index | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-17T21:08:38+08:00 | 现行，保留 |
| `packages/collector/src/integrity.ts` | quarantineReasons, QuarantineReason, CollectorIntegrityError | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-16T22:36:16+08:00 | 现行，保留 |
| `packages/collector/src/media-health.ts` | mediaHealth | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T19:05:08+08:00 | 现行，保留 |
| `packages/collector/src/provision-fixture.ts` | provisionFixtureSource | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T18:16:22+08:00 | 现行，保留 |
| `packages/collector/src/record-evidence.ts` | evidenceFields, RecordEvidence, recordEvidenceFromJson | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T17:47:05+08:00 | 现行，保留 |
| `packages/collector/src/refresh.ts` | CollectorRefresh | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-17T16:59:36+08:00 | 现行，保留 |
| `packages/collector/src/store.ts` | Job, CollectorEnqueueInput, collectorRequestHash, Lease, EvidenceItem | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `packages/collector/src/worker.ts` | OfflineCollectorWorker | 执行/业务源码 / packages/collector | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `packages/collector/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/collector | 基线提交 | 2026-11-16T22:01:46+08:00 | 现行，保留 |
| `packages/core/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/core | 0.1.0 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/core/src/availability.ts` | availability | 执行/业务源码 / packages/core | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/core/src/comparison-scope.ts` | comparisonScope, ComparisonScope | 执行/业务源码 / packages/core | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `packages/core/src/index.ts` | index | 执行/业务源码 / packages/core | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `packages/core/src/pricing.ts` | ENGINE_VERSION, Candidate, Query, canonicalJson, candidateFromJson | 执行/业务源码 / packages/core | 基线提交 | 2026-11-18T17:47:05+08:00 | 现行，保留 |
| `packages/core/src/query.ts` | SoldQuery, isStandardCondition, normalizeQuery, queryHash, matchStrongAttributes | 执行/业务源码 / packages/core | 基线提交 | 2026-11-18T17:47:05+08:00 | 现行，保留 |
| `packages/core/src/search-analysis.ts` | PricedCandidate, ObservationCoverage, PresentationSort, parsePresentationSort, sortComparables | 执行/业务源码 / packages/core | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/core/src/statistics.ts` | cents, distribution, outlierCandidates | 执行/业务源码 / packages/core | 基线提交 | 2026-11-17T21:45:52+08:00 | 现行，保留 |
| `packages/core/src/time.ts` | SaleTime, instant, localDay, inWindow | 执行/业务源码 / packages/core | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/core/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/core | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/db/migrations/0001_baseline.sql` | users、sessions、auth_tokens、api_keys | 数据库 / packages/db | 0001 | 2026-11-16T20:14:43+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0002_primary_images.sql` | listing_images、images_source_retention、images_listing | 数据库 / packages/db | 0002 | 2026-11-16T20:14:43+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0003_image_source_url_ciphertext.sql` | 0003_image_source_url_ciphertext | 数据库 / packages/db | 0003 | 2026-11-16T20:14:43+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0004_image_rights_hardening.sql` | 0004_image_rights_hardening | 数据库 / packages/db | 0004 | 2026-11-16T20:14:43+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0005_collector_pipeline.sql` | collector_run_key_unique、collector_active_dedupe、collector_jobs_ready、collector_rate_windows | 数据库 / packages/db | 0005 | 2026-11-16T22:01:46+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0006_collector_fixture_artifact.sql` | collector_fixture_response_sequence | 数据库 / packages/db | 0006 | 2026-11-16T22:22:53+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0007_collector_quarantine.sql` | collector_quarantines、collector_quarantine_event | 数据库 / packages/db | 0007 | 2026-11-16T22:36:16+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0008_collector_html_evidence.sql` | listing_record_evidence | 数据库 / packages/db | 0008 | 2026-11-17T00:02:45+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0009_auth_access.sql` | user_email_normalized、auth_rate_windows、auth_mail_outbox、user_mfa | 数据库 / packages/db | 0009 | 2026-11-17T07:28:48+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0010_query_billing.sql` | credit_grant_business_identity、credit_grant_payment_kind、query_snapshot_records | 数据库 / packages/db | 0010 | 2026-11-17T08:04:53+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0011_collector_image_retries.sql` | collector_image_jobs、collector_image_jobs_ready、collector_image_parent_lease | 数据库 / packages/db | 0011 | 2026-11-17T16:39:38+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0012_collector_shared_backoff.sql` | 0012_collector_shared_backoff | 数据库 / packages/db | 0012 | 2026-11-17T16:39:38+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0013_collector_refresh_plans.sql` | collector_refresh_plans、collector_refresh_one_active、collector_refresh_occurrences、collector_refresh_due | 数据库 / packages/db | 0013 | 2026-11-17T16:59:36+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0014_collector_refresh_retirement.sql` | protect_collector_refresh_retirement、protect_collector_refresh_retirement | 数据库 / packages/db | 0014 | 2026-11-17T16:59:36+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0015_collector_daily_budget_policy.sql` | collector_daily_budget_policies、protect_collector_daily_budget_policy、protect_collector_daily_budget_policy | 数据库 / packages/db | 0015 | 2026-11-17T21:01:13+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0016_collector_budget_binding.sql` | protect_source_daily_budget_binding、protect_source_daily_budget_binding | 数据库 / packages/db | 0016 | 2026-11-17T21:01:13+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0017_query_request_audit.sql` | query_request_audit、query_request_audit_owner_time、query_request_audit_expiry | 数据库 / packages/db | 0017 | 2026-11-17T21:45:52+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0018_offline_payment_lifecycle.sql` | payment_checkout_intents、payment_checkout_one_subscription_pending、payment_confirmed_subscription_cycle、payment_confirmed_purchased_intent | 数据库 / packages/db | 0018 | 2026-11-18T07:56:52+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0019_offline_public_results.sql` | share_owner_created、anonymous_cache_publications、anonymous_cache_deliveries、anonymous_rate_windows | 数据库 / packages/db | 0019 | 2026-11-18T08:07:47+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0020_account_deletion_processing.sql` | account_deletion_queue、account_deletion_requests_owner | 数据库 / packages/db | 0020 | 2026-11-18T08:16:17+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0021_offline_operations.sql` | ops_query_jobs_order、ops_charges_order、ops_audit_order、support_requests_retention | 数据库 / packages/db | 0021 | 2026-11-18T08:26:31+08:00 | 现行迁移，仅追加 |
| `packages/db/migrations/0022_media_store_ownership.sql` | collector_media_cleanup_pending_by_source、collector_media_dispatch_history、protect_source_media_store_identity、protect_source_media_store_identity | 数据库 / packages/db | 0022 | 2026-11-18T18:58:57+08:00 | 现行迁移，仅追加 |
| `packages/db/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/db | 0.1.0 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/db/src/index.ts` | Database, Transaction, database, transaction, migrate | 执行/业务源码 / packages/db | 基线提交 | 2026-11-16T22:01:46+08:00 | 现行，保留 |
| `packages/db/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/db | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/media/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/media | 0.1.0 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/media/src/index.ts` | MEDIA_VERSION, ImageRights, ImageResponse, ImageTransport, PrimaryImage | 执行/业务源码 / packages/media | 基线提交 | 2026-11-16T22:01:46+08:00 | 现行，保留 |
| `packages/media/src/primary.ts` | approvedImageUrl, ImageCandidate, selectPrimaryImage | 执行/业务源码 / packages/media | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/media/src/private-store.ts` | PrivateMediaStore | 执行/业务源码 / packages/media | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `packages/media/src/url-encryption.ts` | encryptImageSourceUrl, decryptImageSourceUrl | 执行/业务源码 / packages/media | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/media/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/media | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/query/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/query | 0.1.0 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `packages/query/src/index.ts` | QueryService, safeCsvCell | 执行/业务源码 / packages/query | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `packages/query/src/public-results.ts` | PublicResults | 执行/业务源码 / packages/query | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `packages/query/src/quality-report.ts` | SummaryParts, qualityReport, publicSummary | 执行/业务源码 / packages/query | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `packages/query/src/request-audit.ts` | requestOperations, RequestOperation, RequestAudit, RequestAuditService | 执行/业务源码 / packages/query | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `packages/query/src/research.ts` | researchFields, ResearchField, permissions, canPrice, allSourcesAllow | 执行/业务源码 / packages/query | 基线提交 | 2026-11-18T18:05:34+08:00 | 现行，保留 |
| `packages/query/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/query | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `packages/shared/package.json` | 键 name, version, private, type, exports, dependencies | 配置/结构化记录 / packages/shared | 0.1.0 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/shared/src/config.ts` | Config, loadConfig | 执行/业务源码 / packages/shared | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `packages/shared/src/errors.ts` | AppError, invariant | 执行/业务源码 / packages/shared | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/shared/src/i18n.ts` | locales, Locale, en, MessageKey, zhCN | 执行/业务源码 / packages/shared | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `packages/shared/src/index.ts` | BRAND, VERSIONS | 执行/业务源码 / packages/shared | 基线提交 | 2026-11-18T17:47:05+08:00 | 现行，保留 |
| `packages/shared/tsconfig.json` | 键 extends, compilerOptions, include, references | 配置/结构化记录 / packages/shared | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `scripts/build-developer-assets.py` | add, json_asset | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `scripts/check-developer-assets.py` | check-developer-assets | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T07:40:33+08:00 | 现行，保留 |
| `scripts/collector-demo.mjs` | collector-demo | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `scripts/collector-html-demo.mjs` | collector-html-demo | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `scripts/collector-launcher.mjs` | workerEnvironment, launchCollector | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `scripts/collector-maintenance.mjs` | collector-maintenance | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `scripts/collector-refresh.mjs` | collector-refresh | 执行/业务源码 / scripts | 基线提交 | 2026-11-17T16:59:36+08:00 | 现行，保留 |
| `scripts/collector-report.mjs` | collector-report | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T19:05:08+08:00 | 现行，保留 |
| `scripts/collector-worker.mjs` | collector-worker | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `scripts/dev.mjs` | dev | 执行/业务源码 / scripts | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `scripts/developer-demo.mjs` | developer-demo | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `scripts/encrypt-image-source-urls.mjs` | encrypt-image-source-urls | 执行/业务源码 / scripts | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `scripts/local-db.mjs` | pgBinaries, initializeCluster, startCluster, stopCluster, urlFor | 执行/业务源码 / scripts | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `scripts/migrate.mjs` | migrate | 执行/业务源码 / scripts | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `scripts/payment-fixture.mjs` | payment-fixture | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `scripts/privacy-recovery.mjs` | privacy-recovery | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T08:16:17+08:00 | 现行，保留 |
| `scripts/public-fixture.mjs` | public-fixture | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T08:07:47+08:00 | 现行，保留 |
| `scripts/query-worker.mjs` | query-worker | 执行/业务源码 / scripts | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `scripts/test-network.mjs` | test-network | 验证源码 / scripts | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `scripts/test.mjs` | test | 验证源码 / scripts | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `step0/README.md` | 第 0 步执行入口 · 允许现在推进 · 必须形成的证据包 | 说明/规格 / step0/README.md | 基线提交 | 2026-11-18T19:08:03+08:00 | 现行，保留 |
| `step0/access-rights.md` | 来源准入准备记录 · 主图单独授权 | 说明/规格 / step0/access-rights.md | 基线提交 | 2026-11-18T19:08:03+08:00 | 现行，保留；外部证据待补 |
| `step0/collector-poc/.gitignore` | .gitignore | 工程配置 / step0/collector-poc/.gitignore | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `step0/collector-poc/README.md` | SoldBench 离线 Collector PoC · 运行 · 实际覆盖 | 说明/规格 / step0/collector-poc/README.md | 基线提交 | 2026-11-16T15:02:27+08:00 | 现行，保留 |
| `step0/collector-poc/evidence/20261116/cli-replay-0.json` | 20261116 / cli-replay-0 | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/20261116/cli-replay-1.json` | 20261116 / cli-replay-1 | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/20261116/collector-tests.log` | 20261116 / collector-tests | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/20261116/contracts.log` | 20261116 / contracts | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/20261116/documentation.log` | 20261116 / documentation | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/20261116/golden.log` | 20261116 / golden | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/20261116/validation.json` | 20261116 / validation | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T11:11:49+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/offline-package-20261116/contracts.log` | offline-package-20261116 / contracts | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T13:45:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/offline-package-20261116/corpus.log` | offline-package-20261116 / corpus | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T13:45:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/offline-package-20261116/documentation.log` | offline-package-20261116 / documentation | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T13:45:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/offline-package-20261116/golden.log` | offline-package-20261116 / golden | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T13:45:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/offline-package-20261116/poc-tests.log` | offline-package-20261116 / poc-tests | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T13:45:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/offline-package-20261116/typecheck.log` | offline-package-20261116 / typecheck | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T13:45:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/evidence/offline-package-20261116/validation.json` | offline-package-20261116 / validation | 执行证据 / step0/collector-poc/evidence | 基线提交 | 2026-11-16T13:45:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/collector-poc/fixtures/demo.json` | 键 version, synthetic, asOf, plan, responses | 合成数据 / step0/collector-poc/fixtures | 1 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `step0/collector-poc/package-lock.json` | 键 name, lockfileVersion, requires, packages | 配置/结构化记录 / step0/collector-poc/package-lock.json | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/collector-poc/package.json` | 键 name, private, type, engines, scripts, devDependencies | 配置/结构化记录 / step0/collector-poc/package.json | 基线提交 | 2026-11-16T14:44:19+08:00 | 现行，保留 |
| `step0/collector-poc/src/availability.ts` | availability | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `step0/collector-poc/src/campaign.ts` | replayCampaign | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T14:54:31+08:00 | 现行，保留 |
| `step0/collector-poc/src/cli.ts` | cli | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `step0/collector-poc/src/collector.ts` | VERSION, PARSER_VERSION, sha, Stop, Response | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T15:02:27+08:00 | 现行，保留 |
| `step0/collector-poc/src/offline-network.ts` | offline-network | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/collector-poc/src/pricing.ts` | pricing | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `step0/collector-poc/src/snapshot.ts` | StudyQuery, StudySnapshot, studyQueryHash, buildStudySnapshot, readStudySnapshot | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T15:02:27+08:00 | 现行，保留 |
| `step0/collector-poc/src/study-fixture.ts` | syntheticStudy, goldenStudy | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T14:44:19+08:00 | 现行，保留 |
| `step0/collector-poc/src/study.ts` | study | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T14:44:19+08:00 | 现行，保留 |
| `step0/collector-poc/src/time.ts` | time | 执行/业务源码 / step0/collector-poc/src | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `step0/collector-poc/tests/availability.test.ts` | availability.test | 验证源码 / step0/collector-poc/tests | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/collector-poc/tests/campaign.test.ts` | campaign.test | 验证源码 / step0/collector-poc/tests | 基线提交 | 2026-11-16T14:54:31+08:00 | 现行，保留 |
| `step0/collector-poc/tests/collector.test.ts` | collector.test | 验证源码 / step0/collector-poc/tests | 基线提交 | 2026-11-16T14:05:36+08:00 | 现行，保留 |
| `step0/collector-poc/tests/outage.test.ts` | outage.test | 验证源码 / step0/collector-poc/tests | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/collector-poc/tests/pricing.test.ts` | pricing.test | 验证源码 / step0/collector-poc/tests | 基线提交 | 2026-11-16T15:02:27+08:00 | 现行，保留 |
| `step0/collector-poc/tests/snapshot.test.ts` | snapshot.test | 验证源码 / step0/collector-poc/tests | 基线提交 | 2026-11-16T15:02:27+08:00 | 现行，保留 |
| `step0/collector-poc/tsconfig.json` | 键 compilerOptions, include | 配置/结构化记录 / step0/collector-poc/tsconfig.json | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/corpus-manifest.json` | 键 schema, sha256, queries, status, founderSignedAt, volumeMeasured | 配置/结构化记录 / step0/corpus-manifest.json | soldbench.corpus.v1 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/corpus.csv` | 列：id, group, keyword, tier, expected_attrs, ground_truth_notes | 登记/语料 / step0/corpus.csv | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行草案，待人工签收 |
| `step0/evidence-template.md` | 第 0 步证据模板 · 来源准入卡 · 每日运行记录 | 说明/规格 / step0/evidence-template.md | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `step0/evidence/account-privacy-20261118/validation.json` | account-privacy-20261118 / validation | 执行证据 / step0/evidence/account-privacy-20261118 | 基线提交 | 2026-11-18T08:16:17+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/auth-access-20261117/contracts.log` | auth-access-20261117 / contracts | 执行证据 / step0/evidence/auth-access-20261117 | 基线提交 | 2026-11-17T07:28:48+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/auth-access-20261117/engineering-check.log` | auth-access-20261117 / engineering-check | 执行证据 / step0/evidence/auth-access-20261117 | 基线提交 | 2026-11-17T07:28:48+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/auth-access-20261117/npm-audit.json` | auth-access-20261117 / npm-audit | 执行证据 / step0/evidence/auth-access-20261117 | 基线提交 | 2026-11-17T07:28:48+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/auth-access-20261117/step0-check.log` | auth-access-20261117 / step0-check | 执行证据 / step0/evidence/auth-access-20261117 | 基线提交 | 2026-11-17T07:28:48+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/auth-access-20261117/validation.json` | auth-access-20261117 / validation | 执行证据 / step0/evidence/auth-access-20261117 | 基线提交 | 2026-11-17T07:28:48+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/campaign-validation.json` | campaign-20261116 / campaign-validation | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/cli-first.json` | campaign-20261116 / cli-first | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/cli-first.log` | campaign-20261116 / cli-first | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/cli-replay.json` | campaign-20261116 / cli-replay | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/cli-replay.log` | campaign-20261116 / cli-replay | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/cli-state.json` | campaign-20261116 / cli-state | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/contracts.log` | campaign-20261116 / contracts | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/corpus.log` | campaign-20261116 / corpus | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/dependency-inventory.log` | campaign-20261116 / dependency-inventory | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/documentation.log` | campaign-20261116 / documentation | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/economics-scenarios.log` | campaign-20261116 / economics-scenarios | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/economics-unmeasured.log` | campaign-20261116 / economics-unmeasured | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/fault-campaign.log` | campaign-20261116 / fault-campaign | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/golden.log` | campaign-20261116 / golden | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/integrated-study-summary.json` | campaign-20261116 / integrated-study-summary | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/integrated-study.log` | campaign-20261116 / integrated-study | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/poc-tests.log` | campaign-20261116 / poc-tests | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/preparation-tests.log` | campaign-20261116 / preparation-tests | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/quality-empty.log` | campaign-20261116 / quality-empty | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/source-preparation.log` | campaign-20261116 / source-preparation | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/stability-no-records.log` | campaign-20261116 / stability-no-records | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/typecheck.log` | campaign-20261116 / typecheck | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/campaign-20261116/validation.json` | campaign-20261116 / validation | 执行证据 / step0/evidence/campaign-20261116 | 基线提交 | 2026-11-16T14:54:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-daily-budget-20261117/engineering-check.log` | collector-daily-budget-20261117 / engineering-check | 执行证据 / step0/evidence/collector-daily-budget-20261117 | 基线提交 | 2026-11-17T21:01:13+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-daily-budget-20261117/step0-check.log` | collector-daily-budget-20261117 / step0-check | 执行证据 / step0/evidence/collector-daily-budget-20261117 | 基线提交 | 2026-11-17T21:01:13+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-daily-budget-20261117/targeted-check.log` | collector-daily-budget-20261117 / targeted-check | 执行证据 / step0/evidence/collector-daily-budget-20261117 | 基线提交 | 2026-11-17T21:01:13+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-daily-budget-20261117/validation.json` | collector-daily-budget-20261117 / validation | 执行证据 / step0/evidence/collector-daily-budget-20261117 | 基线提交 | 2026-11-17T21:01:13+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-html-20261117/engineering-check.log` | collector-html-20261117 / engineering-check | 执行证据 / step0/evidence/collector-html-20261117 | 基线提交 | 2026-11-17T00:02:45+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-html-20261117/step0-check.log` | collector-html-20261117 / step0-check | 执行证据 / step0/evidence/collector-html-20261117 | 基线提交 | 2026-11-17T00:02:45+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-html-20261117/validation.json` | collector-html-20261117 / validation | 执行证据 / step0/evidence/collector-html-20261117 | 基线提交 | 2026-11-17T00:02:45+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-http-20261117/engineering-check.log` | collector-http-20261117 / engineering-check | 执行证据 / step0/evidence/collector-http-20261117 | 基线提交 | 2026-11-17T21:08:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-http-20261117/step0-check.log` | collector-http-20261117 / step0-check | 执行证据 / step0/evidence/collector-http-20261117 | 基线提交 | 2026-11-17T21:08:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-http-20261117/targeted-check.log` | collector-http-20261117 / targeted-check | 执行证据 / step0/evidence/collector-http-20261117 | 基线提交 | 2026-11-17T21:08:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-http-20261117/validation.json` | collector-http-20261117 / validation | 执行证据 / step0/evidence/collector-http-20261117 | 基线提交 | 2026-11-17T21:08:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-isolation-20261117/engineering-check.log` | collector-isolation-20261117 / engineering-check | 执行证据 / step0/evidence/collector-isolation-20261117 | 基线提交 | 2026-11-17T00:09:24+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-isolation-20261117/step0-check.log` | collector-isolation-20261117 / step0-check | 执行证据 / step0/evidence/collector-isolation-20261117 | 基线提交 | 2026-11-17T00:09:24+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-isolation-20261117/validation.json` | collector-isolation-20261117 / validation | 执行证据 / step0/evidence/collector-isolation-20261117 | 基线提交 | 2026-11-17T00:09:24+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-pipeline-20261116/engineering-check.log` | collector-pipeline-20261116 / engineering-check | 执行证据 / step0/evidence/collector-pipeline-20261116 | 基线提交 | 2026-11-16T22:01:46+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-pipeline-20261116/step0-check.log` | collector-pipeline-20261116 / step0-check | 执行证据 / step0/evidence/collector-pipeline-20261116 | 基线提交 | 2026-11-16T22:01:46+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-pipeline-20261116/validation.json` | collector-pipeline-20261116 / validation | 执行证据 / step0/evidence/collector-pipeline-20261116 | 基线提交 | 2026-11-16T22:01:46+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-quarantine-20261116/engineering-check.log` | collector-quarantine-20261116 / engineering-check | 执行证据 / step0/evidence/collector-quarantine-20261116 | 基线提交 | 2026-11-16T22:36:16+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-quarantine-20261116/step0-check.log` | collector-quarantine-20261116 / step0-check | 执行证据 / step0/evidence/collector-quarantine-20261116 | 基线提交 | 2026-11-16T22:36:16+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-quarantine-20261116/validation.json` | collector-quarantine-20261116 / validation | 执行证据 / step0/evidence/collector-quarantine-20261116 | 基线提交 | 2026-11-16T22:36:16+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-refresh-20261117/engineering-check.log` | collector-refresh-20261117 / engineering-check | 执行证据 / step0/evidence/collector-refresh-20261117 | 基线提交 | 2026-11-17T16:59:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-refresh-20261117/step0-check.log` | collector-refresh-20261117 / step0-check | 执行证据 / step0/evidence/collector-refresh-20261117 | 基线提交 | 2026-11-17T16:59:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-refresh-20261117/targeted-check.log` | collector-refresh-20261117 / targeted-check | 执行证据 / step0/evidence/collector-refresh-20261117 | 基线提交 | 2026-11-17T16:59:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-refresh-20261117/validation.json` | collector-refresh-20261117 / validation | 执行证据 / step0/evidence/collector-refresh-20261117 | 基线提交 | 2026-11-17T16:59:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-reliability-20261117/engineering-check.log` | collector-reliability-20261117 / engineering-check | 执行证据 / step0/evidence/collector-reliability-20261117 | 基线提交 | 2026-11-17T16:39:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-reliability-20261117/npm-audit.json` | collector-reliability-20261117 / npm-audit | 执行证据 / step0/evidence/collector-reliability-20261117 | 基线提交 | 2026-11-17T16:39:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-reliability-20261117/step0-check.log` | collector-reliability-20261117 / step0-check | 执行证据 / step0/evidence/collector-reliability-20261117 | 基线提交 | 2026-11-17T16:39:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-reliability-20261117/validation.json` | collector-reliability-20261117 / validation | 执行证据 / step0/evidence/collector-reliability-20261117 | 基线提交 | 2026-11-17T16:39:38+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-runtime-20261116/engineering-check.log` | collector-runtime-20261116 / engineering-check | 执行证据 / step0/evidence/collector-runtime-20261116 | 基线提交 | 2026-11-16T22:22:53+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-runtime-20261116/step0-check.log` | collector-runtime-20261116 / step0-check | 执行证据 / step0/evidence/collector-runtime-20261116 | 基线提交 | 2026-11-16T22:22:53+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/collector-runtime-20261116/validation.json` | collector-runtime-20261116 / validation | 执行证据 / step0/evidence/collector-runtime-20261116 | 基线提交 | 2026-11-16T22:22:53+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/contracts.log` | commercial-prep-20261116 / contracts | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/corpus.log` | commercial-prep-20261116 / corpus | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/documentation.log` | commercial-prep-20261116 / documentation | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/economics-scenarios.log` | commercial-prep-20261116 / economics-scenarios | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/economics-unmeasured.log` | commercial-prep-20261116 / economics-unmeasured | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/golden.log` | commercial-prep-20261116 / golden | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/poc-tests.log` | commercial-prep-20261116 / poc-tests | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/preparation-tests.log` | commercial-prep-20261116 / preparation-tests | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/source-preparation.log` | commercial-prep-20261116 / source-preparation | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/stability-no-records.log` | commercial-prep-20261116 / stability-no-records | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/typecheck.log` | commercial-prep-20261116 / typecheck | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/commercial-prep-20261116/validation.json` | commercial-prep-20261116 / validation | 执行证据 / step0/evidence/commercial-prep-20261116 | 基线提交 | 2026-11-16T13:54:58+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/developer-delivery-20261118/validation.json` | developer-delivery-20261118 / validation | 执行证据 / step0/evidence/developer-delivery-20261118 | 基线提交 | 2026-11-18T07:40:33+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/media-ownership-20261118/validation.json` | media-ownership-20261118 / validation | 执行证据 / step0/evidence/media-ownership-20261118 | 基线提交 | 2026-11-18T18:58:57+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/media-probe-20261118/validation.json` | media-probe-20261118 / validation | 执行证据 / step0/evidence/media-probe-20261118 | 基线提交 | 2026-11-18T19:05:08+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/model-scope-20261118/validation.json` | model-scope-20261118 / validation | 执行证据 / step0/evidence/model-scope-20261118 | 基线提交 | 2026-11-18T17:56:06+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/operations-20261118/validation.json` | operations-20261118 / validation | 执行证据 / step0/evidence/operations-20261118 | 基线提交 | 2026-11-18T08:26:31+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/outage-readiness-20261118/validation.json` | outage-readiness-20261118 / validation | 执行证据 / step0/evidence/outage-readiness-20261118 | 基线提交 | 2026-11-18T08:36:46+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/payment-lifecycle-20261118/validation.json` | payment-lifecycle-20261118 / validation | 执行证据 / step0/evidence/payment-lifecycle-20261118 | 基线提交 | 2026-11-18T07:56:52+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/cli-first.json` | pipeline-20261116 / cli-first | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/cli-first.log` | pipeline-20261116 / cli-first | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/cli-replay.json` | pipeline-20261116 / cli-replay | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/cli-replay.log` | pipeline-20261116 / cli-replay | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/cli-state.json` | pipeline-20261116 / cli-state | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/contracts.log` | pipeline-20261116 / contracts | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/corpus.log` | pipeline-20261116 / corpus | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/dependency-inventory.log` | pipeline-20261116 / dependency-inventory | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/documentation.log` | pipeline-20261116 / documentation | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/economics-scenarios.log` | pipeline-20261116 / economics-scenarios | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/economics-unmeasured.log` | pipeline-20261116 / economics-unmeasured | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/golden.log` | pipeline-20261116 / golden | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/integrated-study-summary.json` | pipeline-20261116 / integrated-study-summary | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/integrated-study.log` | pipeline-20261116 / integrated-study | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/poc-tests.log` | pipeline-20261116 / poc-tests | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/preparation-tests.log` | pipeline-20261116 / preparation-tests | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/quality-empty.log` | pipeline-20261116 / quality-empty | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/source-preparation.log` | pipeline-20261116 / source-preparation | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/stability-no-records.log` | pipeline-20261116 / stability-no-records | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/typecheck.log` | pipeline-20261116 / typecheck | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/pipeline-20261116/validation.json` | pipeline-20261116 / validation | 执行证据 / step0/evidence/pipeline-20261116 | 基线提交 | 2026-11-16T14:44:19+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/primary-image-clearance-20261118/validation.json` | primary-image-clearance-20261118 / validation | 执行证据 / step0/evidence/primary-image-clearance-20261118 | 基线提交 | 2026-11-18T19:08:03+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/product-core-20261116/validation.json` | product-core-20261116 / validation | 执行证据 / step0/evidence/product-core-20261116 | 基线提交 | 2026-11-16T20:14:43+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/public-results-20261118/validation.json` | public-results-20261118 / validation | 执行证据 / step0/evidence/public-results-20261118 | 基线提交 | 2026-11-18T08:07:47+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/cli-first.json` | quality-review-20261116 / cli-first | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/cli-first.log` | quality-review-20261116 / cli-first | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/cli-replay.json` | quality-review-20261116 / cli-replay | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/cli-replay.log` | quality-review-20261116 / cli-replay | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/cli-state.json` | quality-review-20261116 / cli-state | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/contracts.log` | quality-review-20261116 / contracts | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/corpus.log` | quality-review-20261116 / corpus | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/dependency-inventory.log` | quality-review-20261116 / dependency-inventory | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/documentation.log` | quality-review-20261116 / documentation | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/economics-scenarios.log` | quality-review-20261116 / economics-scenarios | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/economics-unmeasured.log` | quality-review-20261116 / economics-unmeasured | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/golden.log` | quality-review-20261116 / golden | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/poc-tests.log` | quality-review-20261116 / poc-tests | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/preparation-tests.log` | quality-review-20261116 / preparation-tests | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/quality-empty.log` | quality-review-20261116 / quality-empty | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/source-preparation.log` | quality-review-20261116 / source-preparation | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/stability-no-records.log` | quality-review-20261116 / stability-no-records | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/typecheck.log` | quality-review-20261116 / typecheck | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/quality-review-20261116/validation.json` | quality-review-20261116 / validation | 执行证据 / step0/evidence/quality-review-20261116 | 基线提交 | 2026-11-16T14:05:36+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/query-billing-20261117/engineering-check.log` | query-billing-20261117 / engineering-check | 执行证据 / step0/evidence/query-billing-20261117 | 基线提交 | 2026-11-17T08:04:53+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/query-billing-20261117/npm-audit.json` | query-billing-20261117 / npm-audit | 执行证据 / step0/evidence/query-billing-20261117 | 基线提交 | 2026-11-17T08:04:53+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/query-billing-20261117/step0-check.log` | query-billing-20261117 / step0-check | 执行证据 / step0/evidence/query-billing-20261117 | 基线提交 | 2026-11-17T08:04:53+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/query-billing-20261117/validation.json` | query-billing-20261117 / validation | 执行证据 / step0/evidence/query-billing-20261117 | 基线提交 | 2026-11-17T08:04:53+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/cli-first.json` | reconciliation-20261116 / cli-first | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/cli-first.log` | reconciliation-20261116 / cli-first | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/cli-replay.json` | reconciliation-20261116 / cli-replay | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/cli-replay.log` | reconciliation-20261116 / cli-replay | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/cli-state.json` | reconciliation-20261116 / cli-state | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/contracts.log` | reconciliation-20261116 / contracts | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/corpus.log` | reconciliation-20261116 / corpus | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/dependency-inventory.log` | reconciliation-20261116 / dependency-inventory | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/documentation.log` | reconciliation-20261116 / documentation | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/economics-scenarios.log` | reconciliation-20261116 / economics-scenarios | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/economics-unmeasured.log` | reconciliation-20261116 / economics-unmeasured | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/fault-campaign.log` | reconciliation-20261116 / fault-campaign | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/golden.log` | reconciliation-20261116 / golden | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/integrated-study-summary.json` | reconciliation-20261116 / integrated-study-summary | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/integrated-study.log` | reconciliation-20261116 / integrated-study | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/poc-tests.log` | reconciliation-20261116 / poc-tests | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/preparation-tests.log` | reconciliation-20261116 / preparation-tests | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/quality-empty.log` | reconciliation-20261116 / quality-empty | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/source-preparation.log` | reconciliation-20261116 / source-preparation | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/stability-no-records.log` | reconciliation-20261116 / stability-no-records | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/typecheck.log` | reconciliation-20261116 / typecheck | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/reconciliation-20261116/validation.json` | reconciliation-20261116 / validation | 执行证据 / step0/evidence/reconciliation-20261116 | 基线提交 | 2026-11-16T15:02:27+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/research-delivery-20261117/engineering-check.log` | research-delivery-20261117 / engineering-check | 执行证据 / step0/evidence/research-delivery-20261117 | 基线提交 | 2026-11-17T21:45:52+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/research-delivery-20261117/step0-check.log` | research-delivery-20261117 / step0-check | 执行证据 / step0/evidence/research-delivery-20261117 | 基线提交 | 2026-11-17T21:45:52+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/research-delivery-20261117/targeted-check.log` | research-delivery-20261117 / targeted-check | 执行证据 / step0/evidence/research-delivery-20261117 | 基线提交 | 2026-11-17T21:45:52+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/research-delivery-20261117/validation.json` | research-delivery-20261117 / validation | 执行证据 / step0/evidence/research-delivery-20261117 | 基线提交 | 2026-11-17T21:45:52+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/research-demo-20261118/validation.json` | research-demo-20261118 / validation | 执行证据 / step0/evidence/research-demo-20261118 | 基线提交 | 2026-11-18T18:16:22+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/search-context-20261118/validation.json` | search-context-20261118 / validation | 执行证据 / step0/evidence/search-context-20261118 | 基线提交 | 2026-11-18T18:05:34+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/evidence/strong-filter-evidence-20261118/validation.json` | strong-filter-evidence-20261118 / validation | 执行证据 / step0/evidence/strong-filter-evidence-20261118 | 基线提交 | 2026-11-18T17:47:05+08:00 | 历史运行，保留原件；不认证当前版本 |
| `step0/independence-audit.md` | 自研独立性复核资料 · 资料与复现 · 非实现者检查步骤 | 说明/规格 / step0/independence-audit.md | 基线提交 | 2026-11-16T14:05:36+08:00 | 现行，保留 |
| `step0/interviews.md` | 客户访谈执行准备 · 同一份核心问题 · 各类客户追问 | 说明/规格 / step0/interviews.md | 基线提交 | 2026-11-16T13:54:58+08:00 | 现行，保留；外部证据待补 |
| `step0/labels/quality-input-empty.json` | 键 schema, evidence_kind, snapshots, rows | 配置/结构化记录 / step0/labels | soldbench.quality-input.v1 | 2026-11-16T14:05:36+08:00 | 现行，保留 |
| `step0/labels/template.csv` | 列：query_id, candidate_hash, source_id, evidence_ref, annotator_id, comparable | 登记/语料 / step0/labels | 基线提交 | 2026-11-16T13:45:57+08:00 | 待确认外部输入 |
| `step0/online-validation-plan.md` | 连续14天验证的离线准备 · 批量故障回放 | 说明/规格 / step0/online-validation-plan.md | 基线提交 | 2026-11-18T19:08:03+08:00 | 现行，保留 |
| `step0/outage-drill.md` | 第 0 步断源模拟 | 说明/规格 / step0/outage-drill.md | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/payment-review.md` | 收款前置准备 · 最新决定与核验状态 | 说明/规格 / step0/payment-review.md | 基线提交 | 2026-11-16T11:11:49+08:00 | 冲突/历史叠加，见 02 和 16；外部证据待补 |
| `step0/quality-plan.md` | 查询语料与独立标注规程 · 冻结与抽样 · 标注与仲裁 | 验收/质量 / step0/quality-plan.md | 基线提交 | 2026-11-16T14:05:36+08:00 | 现行，保留 |
| `step0/source-capabilities.csv` | 列：source_candidate, field, availability, evidence_ref, parser_version, missing_semantics | 登记/语料 / step0/source-capabilities.csv | 基线提交 | 2026-11-16T20:14:43+08:00 | 待确认外部输入 |
| `step0/source-clearance.csv` | 列：candidate_id, marketplace, status, approved_entrypoint, allowed_access_method, automatic_access | 登记/语料 / step0/source-clearance.csv | 基线提交 | 2026-11-18T19:08:03+08:00 | 待确认外部输入 |
| `step0/tests/test_preparation.py` | test_preparation | 验证源码 / step0/tests | 基线提交 | 2026-11-18T19:08:03+08:00 | 现行，保留 |
| `step0/tests/test_quality.py` | test_quality | 验证源码 / step0/tests | 基线提交 | 2026-11-16T14:05:36+08:00 | 现行，保留 |
| `step0/tests/test_stability.py` | test_stability | 验证源码 / step0/tests | 基线提交 | 2026-11-16T14:54:31+08:00 | 现行，保留 |
| `step0/tools/check_corpus.py` | check | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T13:45:57+08:00 | 现行，保留 |
| `step0/tools/dependency_inventory.py` | inventory | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T14:05:36+08:00 | 现行，保留 |
| `step0/tools/quality_report.py` | wilson, report, aggregate, stratify | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T14:05:36+08:00 | 现行，保留 |
| `step0/tools/readiness.py` | has_text, field_verified, prepare_report | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-18T19:08:03+08:00 | 现行，保留 |
| `step0/tools/replay_campaign.py` | run | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T14:54:31+08:00 | 现行，保留 |
| `step0/tools/stability_report.py` | percentile, plan, utc, summarize, aggregate | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T14:54:31+08:00 | 现行，保留 |
| `step0/tools/unit_economics.py` | decimal, count, rounded, exact, calculate | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T13:54:58+08:00 | 现行，保留 |
| `step0/tools/validate_offline.py` | main | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T14:54:31+08:00 | 现行，保留 |
| `step0/tools/verify_fixture.py` | require, instant, half_up, quantile, summary | 执行/业务源码 / step0/tools | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |
| `step0/unit-economics/README.md` | 完整成本与候选定价测算 · 输入口径 · 输出口径 | 说明/规格 / step0/unit-economics | 基线提交 | 2026-11-16T13:54:58+08:00 | 现行，保留 |
| `step0/unit-economics/scenarios.json` | 3 条数组记录 | 配置/结构化记录 / step0/unit-economics | 基线提交 | 2026-11-16T13:54:58+08:00 | 现行，保留 |
| `step0/unit-economics/unmeasured.json` | 键 schema, scenario, evidence_kind, evidence_ref, customers, billable_queries | 配置/结构化记录 / step0/unit-economics | soldbench.unit-economics.v1 | 2026-11-16T13:54:58+08:00 | 现行，保留 |
| `step0/verdict.md` | 第 0 步判定记录 · 最终签署时填写 | 说明/规格 / step0/verdict.md | 基线提交 | 2026-11-18T18:16:22+08:00 | 现行，保留；外部证据待补 |
| `tests/api.test.mjs` | health and readiness disclose fixture mode without claiming collector availability | 验证源码 / tests | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `tests/auth-access.test.mjs` | registration and verification persist encrypted localized mail and single-use hash-only tokens | 验证源码 / tests | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `tests/collector-budget.test.mjs` | 100 concurrent UTC rollover enqueues initialize one day under fixed caps and never reset yesterday | 验证源码 / tests | 基线提交 | 2026-11-17T21:01:13+08:00 | 现行，保留 |
| `tests/collector-html.test.mjs` | HTML text parser preserves sold evidence, actual price, withheld seller and correctly bound lazy primary image | 验证源码 / tests | 基线提交 | 2026-11-18T18:05:34+08:00 | 现行，保留 |
| `tests/collector-http.test.mjs` | HTTP origin and fixed routes cannot select external hosts, credentials, redirects or arbitrary keys | 验证源码 / tests | 基线提交 | 2026-11-17T21:08:38+08:00 | 现行，保留 |
| `tests/collector-isolation.test.mjs` | collector child environment excludes application credentials and Node preloads | 验证源码 / tests | 基线提交 | 2026-11-17T00:09:24+08:00 | 现行，保留 |
| `tests/collector-pipeline.test.mjs` | PG collector replays golden pages, persists provenance, de-duplicates and stores/reads real image bytes | 验证源码 / tests | 基线提交 | 2026-11-18T19:05:08+08:00 | 现行，保留 |
| `tests/collector-refresh.test.mjs` | concurrent identical plans and occurrence dispatch create one frozen plan/job and consume job budget once | 验证源码 / tests | 基线提交 | 2026-11-17T16:59:36+08:00 | 现行，保留 |
| `tests/collector-runtime.test.mjs` | two independent worker processes continue one bound artifact and status inspection does not refresh success time | 验证源码 / tests | 基线提交 | 2026-11-16T22:22:53+08:00 | 现行，保留 |
| `tests/collector.test.mjs` | clearance preflight emits a versioned snapshot but never releases network access | 验证源码 / tests | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `tests/core.test.mjs` | model scope reconciles unknown inputs, normalizes NFC, and bounds options without claiming SKU equivalence | 验证源码 / tests | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `tests/database.test.mjs` | PG16 empty migration, old-version upgrade, restart idempotency and original relational constraints | 验证源码 / tests | 基线提交 | 2026-11-18T18:58:57+08:00 | 现行，保留 |
| `tests/developer.test.mjs` | documented research demo drives actual HTTP, owner claims and main-image evidence from a fresh private environment | 验证源码 / tests | 基线提交 | 2026-11-18T18:16:22+08:00 | 现行，保留 |
| `tests/fixtures/html/README.md` | SoldBench synthetic HTML corpus | 说明/规格 / tests | 基线提交 | 2026-11-17T00:02:45+08:00 | 现行，保留 |
| `tests/fixtures/html/profile.json` | 键 schema, synthetic, id, revision, root, records | 合成数据 / tests | soldbench.synthetic-html-profile.v1 | 2026-11-17T00:02:45+08:00 | 现行，保留 |
| `tests/fixtures/html/search.html` | 合成 HTML 来源样本 | 采集测试输入 / tests | 基线提交 | 2026-11-17T00:02:45+08:00 | 现行，保留 |
| `tests/fixtures/process/api-server.mjs` | api-server | 验证源码 / tests | 基线提交 | 2026-11-17T00:09:24+08:00 | 现行，保留 |
| `tests/helpers/product.mjs` | product | 验证源码 / tests | 基线提交 | 2026-11-18T17:47:05+08:00 | 现行，保留 |
| `tests/local-database.test.mjs` | offline tools validate the PG-effective target, not the URL display host | 验证源码 / tests | 基线提交 | 2026-11-16T22:01:46+08:00 | 现行，保留 |
| `tests/mcp.test.mjs` | official SDK legacy client runs queued search/status/explicit claim and free stats with REST reuse and20-row presentation | 验证源码 / tests | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `tests/media.test.mjs` | primary image belongs to the target listing and excludes gallery/ad/other listing images | 验证源码 / tests | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `tests/network.test.mjs` | test process denies external HTTP, raw sockets and DNS with positive controls | 验证源码 / tests | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `tests/operations.test.mjs` | support intake is private, idempotent, rate limited and prunes expired original messages | 验证源码 / tests | 基线提交 | 2026-11-18T08:26:31+08:00 | 现行，保留 |
| `tests/payments.test.mjs` | 100 cross-channel subscription requests create one pending intent, with exact replay and independent credit packs | 验证源码 / tests | 基线提交 | 2026-11-18T07:56:52+08:00 | 现行，保留 |
| `tests/privacy.test.mjs` | deletion immediately removes access and anonymous publication before its worker runs, with isolated receipt and retained ledger | 验证源码 / tests | 基线提交 | 2026-11-18T08:16:17+08:00 | 现行，保留 |
| `tests/public-results.test.mjs` | a share stores only a token hash, replays without a token, and hides owner and per-listing data | 验证源码 / tests | 基线提交 | 2026-11-18T17:56:06+08:00 | 现行，保留 |
| `tests/query-billing.test.mjs` | UTC monthly anniversaries preserve Jan 31 after February and do not drift | 验证源码 / tests | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `tests/readiness.test.mjs` | loopback product HTTP serves retained history and account functions during outage, with exact freshness limits and recovery | 验证源码 / tests | 基线提交 | 2026-11-18T08:36:46+08:00 | 现行，保留 |
| `tests/research.test.mjs` | legacy filter results cannot claim or bypass reuse while valid unfiltered history remains readable | 验证源码 / tests | 基线提交 | 2026-11-18T17:47:05+08:00 | 现行，保留 |
| `tests/search-analysis.test.mjs` | price ranges validate exactly, participate in semantic identity, and include both endpoints | 验证源码 / tests | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `tests/validate-response.py` | validate-response | 验证源码 / tests | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `tsconfig.base.json` | 键 compilerOptions | 配置/结构化记录 / 项目基线 | 基线提交 | 2026-11-16T20:14:43+08:00 | 现行，保留 |
| `tsconfig.json` | 键 files, references | 配置/结构化记录 / 项目基线 | 基线提交 | 2026-11-17T08:04:53+08:00 | 现行，保留 |
| `v14_gameboy_58_verified.json` | 键 fixture_version, synthetic_test_data, description, as_of, query, expected_stats | 合成数据 / 项目基线 | 基线提交 | 2026-11-16T11:11:49+08:00 | 现行，保留 |

## 工作树外可追溯的已否决草稿

`13c4d32` 的第一父提交为 `978032f`，Git 作者时间 2026-11-17T16:08:50+08:00。只读核对该记录的路径与台账 §43。草稿没有进入当前 476 个文件的评审基线。

| 内容 | 路径 | 状态 |
|---|---|---|
| 活动路径的旧草稿差异 | apps/api/src/index.ts、apps/web/src/index.tsx、apps/web/package.json、apps/web/tsconfig.json、根锁包和入口、core/query/shared 的包或入口 | 历史，保留 stash |
| 草稿新增文件 | apps/web/src/assets.ts、client.ts、copy.ts、pages.tsx、styles.css、types.d.ts，packages/shared/src/csv.ts，scripts/build-web.mjs | 历史，保留 stash，用户已否决该视觉方向 |
