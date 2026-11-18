# 快速开始

这是本机离线工程，未启用真实来源和收款。在仓库运行 `npm run db:start`、`npm run developer:demo`。导入 `.local/developer-demo.env` 后启动 `npm run dev`。另开私有终端导入同一文件，运行 `node developer/examples/sold.ts --claim`，也可用 Python/curl 版本。合成账号不能作为真实客户登录。

示例提交查询、轮询作业、明确允许后领取，输出整数分中位数和已核验样本量。不加 --claim 会保留未领取状态。本机 API 为 http://127.0.0.1:3000/v1；soldbench.com 和 api.soldbench.com 仅为未来部署目标。202 表示排队，不能当已收费查价成功。集成前阅读鉴权、异步作业和价格证据。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。

运行 `npm run developer:demo -- --research` 可复跑更完整的 Nintendo Switch 研究样本，含18条归档记录、18张主图和16条已核验合成价格。示例客户端从私有环境文件读取关键词。领取后读取结果、型号覆盖、授权搜索摘要，再访问本人可比详情与相对主图URL。
