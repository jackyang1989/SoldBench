# ADR-14 · 身份凭据与安全命令的重试语义

2026-11-17，离线工程开发基线；属于TASK-023/024技术契约澄清，不改变查询/支付/额度计量或外部发布门。

初始OpenAPI复用了收费命令的Idempotency-Key header到所有auth POST，但session仅存hash、登录需要向浏览器设置一次随机cookie，与“缓存成功正文重放”没有一致的可执行实现。为避免可恢复明文session缓存及错误宣称幂等，认证命令采用以下明确规则：

- 注册/找回请求/验证重发自然去重与冷却，返回accepted；重复邮箱不泄露账户内容。
- 邮箱验证/重置确认是单次token命令，原子成功一次，重复或过期410；不重新执行成功操作。
- 登录是显式创建新会话，重试可能产生另一会话；绝对TTL及有效会话上限有界，不缓存明文cookie。重新认证/MFA成功旋转session token与CSRF，不延长绝对TTL。
- 退出已失效会话只清理浏览器cookie；有效会话退出检查Origin/CSRF。安全写入按当前会话、近期认证、MFA及CAS/行锁判断，不能通过重放旧成功正文绕过当前状态。
- key创建/旋转仍强制Idempotency-Key，成功重放只返回key_info，绝不再次展示secret；无资金动作。

认证/账户安全命令不要求Idempotency-Key；OpenAPI1.6同步移除原误复用header。查询claim、支付/退款等原ADR-12幂等规则保持。账户请求体校验、失败免产生权益、owner与CSRF/MFA、单次token及恢复码的并发测试为完成条件。后续Agent应按本ADR及账户契约开发，不自行把cookie/token明文放进通用幂等缓存。
