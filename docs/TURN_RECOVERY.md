# Turn 恢复与工具幂等边界

聊天、后台任务和子代理统一使用服务端 `runToolsLoop`。模型响应和工具调用状态会在执行前写入 checkpoint，客户端通过持久化事件重放和 SSE 续传恢复界面。

## 恢复规则

| checkpoint 状态 | 恢复行为 |
|---|---|
| 模型响应已保存、工具尚未开始 | 不再调用模型，继续执行已保存的工具调用 |
| 工具已完成 | 复用 checkpoint 中的结果，不重复执行 |
| 工具正在执行，且为并发安全的只读工具 | 允许重新执行并重新读取权威状态 |
| 工具正在执行，执行器声明 `supportsIdempotentResume` | 使用同一个 `idempotencyKey` 恢复执行 |
| 工具正在执行，且可能产生副作用 | 不自动重放，向模型返回 `tool_execution_outcome_unknown`，要求核实实际状态或询问用户 |
| 审批正在等待 | 恢复同一条持久化审批，不重复创建审批记录 |

## 当前支持清单

- 所有 metadata 明确标记 `isConcurrencySafe: true` 的只读工具可以安全重读；
- 测试或扩展执行器可以通过布尔值或函数形式声明 `supportsIdempotentResume`；
- 当前内置的写文件、Shell、Git mutation、外部发送和发布工具均未声明幂等恢复，因此执行中重启会进入 `tool_execution_outcome_unknown`；
- artifact 创建工具完成后会复用 checkpoint 结果；如果在完成结果落 checkpoint 前重启，同样按非幂等副作用处理。

新增可幂等恢复的执行器时，必须同时满足：

1. 对同一个 `idempotencyKey` 重试不会产生第二份副作用；
2. 能返回第一次执行的权威结果；
3. 有覆盖“执行完成但进程在保存 checkpoint 前退出”的测试；
4. 在本文档的当前支持清单中登记。

## Shell standing rule

`bash_exec` 永远不能创建或命中 standing rule。每次有副作用的 Shell 执行都需要单次批准；只读命令仍可由统一工具 metadata 判定为无需审批。其他工具的 standing rule 继续按目标作用域或参数指纹绑定，并把命中的规则写入 `approvalAuthorization` 供工具卡审计。
