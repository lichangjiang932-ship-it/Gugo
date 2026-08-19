# Self-evolution Safety Pipeline

Gugo 的“自我进化”不是让当前模型直接修改生产 prompt、plugin、策略或用户文件。演进链路必须逐层建立可审计证据，并在隔离评测和人工批准之前保持只读。

## Phase 1: evidence corpus（当前已实现）

### 显式反馈

`POST /api/evolution/feedback` 将 `/feedback` 写入 user-scoped、append-only 的 `evolution_feedback` 表。正文限制为 1–4000 字符；聊天 session 仅在确属当前用户且不是认证 token 时关联。未同步草稿或其他用户 session 会降级为 `null`，反馈本身仍可靠保存。

### 结构化 Reviewer 证据

`GET /api/evolution/evidence?limit=1..200` 合并：

- 当前用户的显式反馈；
- 当前用户 Job 的 `task_reviewed` 事件。

响应使用 `schemaVersion: 1` 和 `Cache-Control: no-store`。Reviewer 事件只投影 verdict、summary、issues、evidence、repairAttempts 及隔离模型元数据；不会返回完整 job prompt、event message、原始 payload、模型 transcript、tool trace 或可执行代码。API 始终按认证用户隔离。

当前 evidence corpus **没有** mutation、候选生成、自动安装或自动应用端点。

## Required next gates

后续能力必须按以下顺序增加，不能跳级：

1. **Dataset curation**：脱敏、去重、失败聚类、来源/版本指纹和人工排除；原始证据保持不可变。
2. **Candidate generation**：候选 prompt/plugin/config 作为独立对象保存；不得覆盖 active 版本。
3. **Isolated replay**：固定数据集、固定模型/参数、网络与文件能力隔离，记录基线和候选的同场结果。
4. **Evaluation**：结构化 rubric、独立 Reviewer、回归/安全/成本/延迟指标；缺证据不得 pass。
5. **Human approval**：显示 diff、来源、评测结果、权限变化和明确回滚目标；仅本地 owner 可批准。
6. **Canary rollout**：小比例、限定作用域、不可变版本标识和完整观测。
7. **Automatic rollback**：预先声明阈值；质量、安全或可靠性退化时恢复上一不可变版本。

任何候选都不能扩大 manifest `contributes`、工具风险信任或 renderer 执行权限而不经过独立权限审批。磁盘 transformer 仍只能在 worker sandbox 中运行，不能注入 React/renderer JavaScript。
