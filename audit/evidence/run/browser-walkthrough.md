# 独立浏览器走查记录

2026-11-18，基线 808b987。ChatGPT 内置浏览器新打开的离线页面，以本次 UX 审阅的回环服务 127.0.0.1:30781 为目标。回环服务使用活动路由和合成模式，未配置数据库、身份与查询服务。上述 404 由未注册页面路由导致，与数据服务无关。产品后端另有独立 PG16 证据。浏览器实际可见操作使用不含个人信息的商品名。

| 操作 | 可见结果 |
|---|---|
| 打开英文首页 | SoldBench — Research。Research、Account、简体中文三个导航，商品名输入、提交按钮、合成数据标注与客服链接。 |
| 单击文本输入并输入 Nintendo Switch OLED，单击 Research sold prices | 进入 /research?q=Nintendo+Switch+OLED，正文显示 JSON `error.code=not_found`，无结果或恢复操作。 |
| 返回首页，单击简体中文 | 页面展示“成交研究”“账户”“English”、对应中文表单与合成数据提示。 |
| 再输入同一名称，单击“研究成交价格” | 进入 /zh-CN/research?q=Nintendo+Switch+OLED，显示相同 `not_found`。 |
| 返回中文首页，单击“账户” | 进入 /zh-CN/account，显示 `not_found`，未进入可见注册流程。 |

首次任务在上述入口终止。没有履行注册、账户验证、读取真实研究结果或领取。独立的 Hono 路由验证见 [44 个页面路径](local-page-routes.json)。

## 响应式检查

在浏览器中设置 320、390、768、1440 CSS px，逐项读 `documentElement.clientWidth` 与 `scrollWidth`。两语言的首页两值均等，未观察到页面横向溢出。中文表单容器宽依次为 304、374、752、1424px，英文 320/768/1440 档一致。390px 英文截图中可见标签与输入贴合、输入占位被截短、提交折行，浏览器默认文字链接和控件占主要版式。与手机表格、Dashboard、错误恢复有关的验证因路由缺失无法执行。测试后已重置浏览器 viewport。
