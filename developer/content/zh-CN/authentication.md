# 鉴权与密钥

服务端从 SOLDBENCH_API_KEY 读取密钥，通过 Authorization: Bearer 发送。不得放在浏览器代码、URL、截图或日志。sold:read 用于查询/结果/研究，jobs:read 用于轮询，usage:read 用于用量及请求日志。查询和作业逐次校验 owner。泄露后立即撤销；新建/轮换只展示一次明文，重放轮换仅返回元数据。不能同时使用 Cookie 和 Bearer。网页写操作要求同源 CSRF；MCP 不接收 Cookie。具体端点、近期认证和 TOTP 要求见 OpenAPI。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。
