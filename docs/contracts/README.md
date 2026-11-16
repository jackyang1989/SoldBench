# 契约验证入口

版本1.3，2026-11-16。这里是开发前的设计契约；正式产品迁移仍在G0后由TASK-012建立。原始SQL、OpenAPI、示例、文档必须同步变更。

- [OpenAPI 3.1](../openapi.yaml)：完整成功/错误DTO、49操作、认证/CSRF/幂等/收费/角色扩展；供应商webhook原文按各自协议验证，不伪造自家格式代替。
- [SQL基线](schema.sql)：PG16空库结构，含身份/来源/观测/事件/查询/作业/钱包/支付/删除/审计。
- [关系用例](verify.sql)：只在空的专用数据库或schema运行；全部合成数据，最终ROLLBACK。
- [完整fixture清单](fixtures/manifest.json)：10份合成响应，包含50条展示、58条完整重算输入、低样本/空结果/stale/202/未领取/过期/禁止。
- [静态检查](check_contracts.py)：JSON Schema2020-12、内部引用、操作映射、权限定义、完整fixture与错误输入拒绝；不执行HTTP。

## Python环境

建议独立虚拟环境，固定依赖见 [requirements.txt](requirements.txt)。夹具与文档校验仍只用标准库。

```sh
python3 -m venv /tmp/soldbench-contract-check
/tmp/soldbench-contract-check/bin/python -m pip install -r docs/contracts/requirements.txt
/tmp/soldbench-contract-check/bin/python docs/contracts/check_contracts.py
/tmp/soldbench-contract-check/bin/python docs/contracts/check_contracts.py --formal
```

如当前Python已具有兼容版本，可直接 `python3 docs/contracts/check_contracts.py`。工具无外网访问行为；安装依赖与运行验证是两个独立动作。

## PostgreSQL16验证

**不要对已有客户/业务数据库执行schema.sql。** 由执行者创建全新本机临时PG16实例，禁TCP只监听私有临时Unix socket，或新建明确标识的隔离数据库；记录实际路径/端口/版本。初始化和启动受宿主权限限制时按环境审批处理，不通过其他工具绕过。

示例路径/端口为占位，需替换为已创建的隔离实例：

```sh
psql -h /tmp/<isolated-socket> -p <test-port> -d <empty-test-db> -v ON_ERROR_STOP=1 -f docs/contracts/schema.sql -f docs/contracts/verify.sql
```

schema创建成功后verify用例全部回滚，不清空任何既有对象。再次验证schema时使用新的空schema/数据库，不对原库DROP后重跑。记录命令、退出码、表数/负例及版本，并停止自己启动的临时实例。产品迁移还需升级/历史数据和并发服务测试，本文件不声称这些已通过。

## 设计语义

API响应示例data_mode=synthetic_fixture；原始文件缺少生产字段，不能导入生产。示例candidate_set_hash仅用于该合成输入集合，不当真实来源核验。公式 oracle见step0/tools/verify_fixture.py。

async领取顺序见ADR-12：202→GET jobs completed/ready→POST claim→结果/charge同事务→GET免费复取；未领取GET返回409。key创建幂等重放不重复展示明文；分享创建重放不回token，丢失原响应时撤销后新建。删除回执token由客户端在提交前CSPRNG生成，服务器仅存hash；30天capability只能读本申请状态，不能恢复用户权限。

## 外部协议核对

2026-11-16核对 [Paddle签名](https://developer.paddle.com/webhooks/about/signature-verification/)、[Dodo Webhooks](https://docs.dodopayments.com/developer-resources/webhooks)。分别使用Paddle-Signature与Standard Webhooks头，原始body验签；真实SDK/API版本在接入任务锁定。来源/支付账户无批准时只用本地模拟，不发起真实接口请求。

## 双语展示契约

OpenAPI设计版本1.2.0新增非webhook接口的可选Accept-Language，并说明稳定英文JSON与Web翻译映射、邮件入队语言快照。详情见 [多语言专项](../多语言与商业交付补充规格.md)。78个DTO及47操作不变；SQL无变更，原英文fixture仍用于验证业务数据。双语实际呈现和通知验收另属AT-055，静态契约检查不能证明其通过。

## Stripe与PayPal设计更新

当前OpenAPI1.3.0含Stripe主支付、PayPal补充、Checkout可选provider与两个独立签名端点，原备用端点默认禁用；49操作、78schema。执行见 [支付规格](../Stripe与PayPal接入规格.md)。当前仅设计与静态校验，没有运行渠道API、实际验签或真实交易。SQL provider文本列未变，AT-037/038/040及账户批准仍未完成。
