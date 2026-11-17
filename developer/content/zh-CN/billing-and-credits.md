# 额度与支付边界

标准有效查询最多扣 1 credit，不按行数收费。同 owner 同规范参数复用 10 分钟。排队、失败、低样本、stale、计算轮询及重复领取免费。promo/subscription 按最早到期消耗，同到期 subscription 优先，purchased 最后；流水不可改写。候选套餐尚非获批商用价目。

Stripe 主支付、PayPal 补充，Creem/Dodo 仅核验备用资格，不能自动切换扣款。本工程仅离线支付模拟，无真实扣款/提现/产品审批或支付激活。语言切换不能改变额度、国家、币种或查询身份。

相关：[快速开始](/docs/zh-CN/quickstart)、[OpenAPI](/openapi.json)、[Skill](/.well-known/skills/soldbench/SKILL.md)。
