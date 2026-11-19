# 契约验证入口

维护说明更新于 2026-11-19。这里保留初始 SQL 设计基线与关系测试。当前离线迁移以 `packages/db/migrations/0001_*` 至 `0023_*` 顺序应用为准，ADR-13 规定离线实施授权及实际 G0 约束。新变更须同步适用契约、示例和文档。历史版本更新段落按当时版本阅读。

- [OpenAPI 3.1](../openapi.yaml)：当前离线契约 1.18.0。主图读取检查 owner 与当前权利。支付 webhook 的签名和原文处理遵循各自通道设计，真实联调另行验收。
- [SQL基线](schema.sql)：PG16空库结构，含身份/来源/观测/事件/查询/作业/钱包/支付/删除/审计。
- [关系用例](verify.sql)：只在空的专用数据库或schema运行；全部合成数据，最终ROLLBACK。
- [完整fixture清单](fixtures/manifest.json)：15 份合成响应，包含50条展示、58条完整重算输入、低样本/空结果/stale/202/未领取/过期/禁止。
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

当前OpenAPI1.4.0含支付目标契约与两个主用签名端点，并追加`Comp.primary_image`及私有媒体读取。SQL基线从0001开始，0002建立主图和成交事件的组合关联；0003只扩展密文URL列，已有数据需运行加密回填工具，0004确认无明文后收紧状态并删除明文列。已应用迁移不可回改。当前仅设计/离线实现，没有真实来源图像抓取、渠道API、实际验签或真实交易。AT-037/038/040/056及source/payment准入仍未完成。

搜索页专项增量见[字段与统计契约](../搜索页采集字段与统计契约.md)：当前冻结OpenAPI还未加入价格范围/format参数与supplemental_stats等，TASK-028必须扩展schema/fixtures和相关DTO/调用实现后才能验收AT-074/075；现有契约检查通过不代表新增字段已支持。

2026-11-16搜索核心实施：OpenAPI1.5.0扩至84 schema/50operation，新增SearchSupplementalStats、价格范围/format和已交付结果排序；11个完整合成fixtures/15个负例。新增search-supplemental.json由实际core对16条合成记录生成。旧样例仍保留原黄金字段和原版本，不把新版schema可选字段变成旧结果虚构值；HTTP/来源持久化未交付。

采集整包追加0005：复用原collector_jobs/circuits，新增5个持久化表，54表空库/旧版升级测试；sale_event_evidence回填后图片组合外键改引用多观察证据，图片唯一键含event。共享SQL基线不是最新全部DDL，运行库完整结构以顺序应用的0001–0005迁移为准；旧版SQL不回改。

新增0010与查询账本实现见[实施契约](../查询账本与交付实施契约.md)。tests/database.test.mjs验证0009→0010及空库，tests/validate-response.py验证实际HTTP响应；原SQL文件仍是初始设计基线，不是已部署数据库。

采集运行进一步追加0011与0012，见[管线契约§12](../采集管线实施契约.md)。空库及0010→0011→0012在独立PG16验证，新增collector_image_jobs，运行表总数61；冻结SQL设计基线不被当作已部署迁移。
