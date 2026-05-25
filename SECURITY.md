# Security Policy

## 支持版本

仅 main 分支接受安全修复。

## 已实现的安全控制

本项目已经实现多层防护（持续更新中）：

- **传输层**：CSP / CORS / 安全 Headers（middleware.js）
- **认证**：邮箱验证码 + 邮箱密码双通道；会话 token 短期化
- **隔离**：所有用户数据按 `user_id` 列隔离（v2/v3 migration 已落实）
- **SSRF 防护**：工具代理域名白名单 + 私有 IP 段拦截
- **Shell 安全**：bash 危险命令拦截（rm -rf / / chmod 777 等）
- **敏感信息屏蔽**：env / secret 在日志/响应中统一脱敏
- **工具审计**：所有 MCP / 子代理 / Hooks 调用进 `tool_audit` 表
- **速率限制**：内置 rate limiter（rateLimiterBudget.test.js）
- **客户端 XSS**：DOMPurify 清理用户/AI 输出

## 报告漏洞

请勿在公开 Issue / Discussions 中描述漏洞细节。

请通过以下方式私下报告：

1. **优先方式**：GitHub Security Advisory — [Report a vulnerability](https://github.com/lichangjiang932-ship-it/your-model-atelier/security/advisories/new)
2. 邮件：（待补充 maintainer 邮箱）

提交时请包含：

- 漏洞类型 + 影响范围（数据泄露 / RCE / XSS / SSRF / 权限越界 / 其它）
- 复现步骤 + PoC（最小化即可）
- 你认为的修复建议（可选）
- 你的联系方式（用于致谢）

## 响应时间承诺

| 严重程度 | 首次响应 | 修复时间 |
|---|---|---|
| Critical（RCE / 任意用户数据泄露） | 24 小时内 | 7 天内 |
| High（权限越界 / 认证绕过） | 72 小时内 | 14 天内 |
| Medium（信息泄露 / DoS） | 7 天内 | 30 天内 |
| Low（最佳实践 / 加固建议） | 14 天内 | 下一个版本 |

## 致谢

修复后会在 release notes 致谢报告者（除非你要求匿名）。
