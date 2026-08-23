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

已接入统一 Turn/Job 工具循环调用边界的模型请求，会在出站前保存稳定的 `modelRequestId`。OpenAI-compatible、Anthropic、Gemini 以及原生 Provider 请求统一携带同值的 `X-Client-Request-Id` 和 `Idempotency-Key`；同一逻辑调用内的网络重试和 Provider failover 不会换 ID。支持幂等键或请求查询的 Provider 可以据此去重/查单；不能证明上游结果时，恢复仍以 `MODEL_REQUEST_OUTCOME_UNKNOWN` 停止自动重放。Header 本身不代表 Provider 提供 exactly-once。Gugo 不向用户收费；这个边界只是防止重复调用用户自配的上游 Provider。尚未接入该边界的辅助模型调用不在这项保证内，必须逐条迁移或显式标记为不可恢复。

### 逻辑请求与物理 Provider 尝试链

`modelInvocation` v3 先持久化逻辑请求身份，再允许第一次真实出站。其中 `requestFingerprint` 是请求投影的 SHA-256，`modelRequestId` 和 `idempotencyKey` 绑定同一逻辑调用。每次真实网络重试或 failover 出站之前，再按严格递增顺序追加一条 `providerAttempts` 物理尝试，保存：

- 全局物理序号、该 Provider 的重试序号和 failover 位置；
- 实际 Provider ID、模型名和 Provider kind；
- 端点指纹与 Provider 配置指纹；
- 当次生效的 Provider capability/release provenance。

端点与配置指纹仅是 SHA-256 等值校验信号。物理尝试不持久化原始 URL、API Key 或 Headers，人工恢复 API 也不返回这两个指纹、凭据或 capability 内部信息。设置页只显示逻辑绑定，以及最后一条物理尝试的非敏感 Provider ID/模型/kind/序号；人工查单必须以“最后实际 Provider”为准，不能只看最初的逻辑绑定。

### Provider capability 与不可变 Release

每条物理尝试可绑定 `id` / `owner` / `version` / `revision` / `releaseDigest` 组成的 capability provenance。恢复查单必须使用与原尝试完全一致的 Provider kind、配置指纹和 capability 身份；任一项漂移都以 `MODEL_REQUEST_CONTEXT_DRIFT` fail-closed。非内置 Provider 的当前插件 Release 没有可验证 `releaseDigest` 时，其 reconciler 只能返回 `unsupported`，不能作出解除阻塞的裁决。

### 模型请求裁决协议

模型 checkpoint 冻结 Provider 绑定、模型名、配置 revision、请求指纹、稳定请求 ID、幂等键和物理尝试链。进程在响应 checkpoint 之前退出时，恢复顺序固定为：

1. 先读取绑定 owner/session/turn/checkpoint sequence 与完整请求身份的人工裁决；
2. 没有人工裁决时，仅调用 Provider 显式注册且声明 `contractVersion: 1` 与 `authority: 'provider_request_status'` 的 reconciler；
3. Provider 裁决的 `completed` / `not_sent` 必须同时有 `authoritative: true` 和非空、有界的 plain-object `receipt`；`completed` 还必须有通过严格模型响应校验的 `response`；
4. Runtime 会附加并再校验 `verification`，其必须逐字段绑定 request ID、idempotency key、request fingerprint、最后实际 Provider/模型、config fingerprint、物理尝试序号和 capability provenance；
5. `completed` 先写 checkpoint 再回放；`not_sent` 先写 checkpoint，再创建下一个逻辑 attempt；
6. `unknown`、`unsupported`、空回执、无权威证据、查单异常以及上下文/Release 漂移都保持阻塞，绝不自动重复请求。

设置页只允许当前 owner 在 Turn/Job 执行租约已结束后，对当前 checkpoint sequence/revision 做一次性 CAS 裁决。所有裁决都必须勾选已在最后实际 Provider 核验，并逐字确认模型请求 ID；选择 `completed` 还必须提交响应快照与查询回执，选择 `unknown` 不会解除阻塞。该协议是保守的 at-most-once 恢复边界，不宣称 exactly-once。

### 外部取消的发送边界

- 在进入物理 `fetch` 之前已经观测到外部 abort：保留原 `AbortError`，标记 `modelRequestOutcome: 'not_sent'`，Loop 保存 `model-request-not-sent`，不会把这次取消记成上游失败；
- `fetch` 已经开始后才观测到外部 abort（包括正在读响应 body/流）：上游可能已接受请求，必须转换为 `MODEL_REQUEST_OUTCOME_UNKNOWN`，设置 `unsafeToReplay: true` 和 `requiresUserVerification: true`；Loop 保留 `in_flight` checkpoint，不写 `failed` / `not_sent`，也不继续 retry/failover；
- DNS/连接拒绝等能权威证明 HTTP 请求未到达 Provider 的连接错误仍可归类为 `not_sent`；已收到的明确非重试 4xx 拒绝是终态错误，不伪装成结果未知。

## 当前支持清单

- 所有 metadata 明确标记 `isConcurrencySafe: true` 的只读工具可以安全重读；
- 测试或扩展执行器可以通过布尔值或函数形式声明 `supportsIdempotentResume`；
- 内置 `write_file` 支持执行器级状态证明恢复：首次跨过副作用边界后、真正写入前，side-effect ledger 会持久化不可变的 local-file-v1 计划，包含权威目标、写前摘要、写后大小与 SHA-256，以及预构造的原始 outcome。重启后只读取当前目标并核验计划；路径、类型、大小与 SHA-256 全部匹配才复用原始 `changed/changes` 并提交账本，恢复调用不会再次写文件、不会消耗写入限额，也不会补写 before-image；
- legacy `executing` 记录没有恢复计划时，即使当前内容碰巧相同也不能自动接管；目标缺失、被用户后续修改、路径漂移、计划损坏或摘要不匹配都会进入 `tool_execution_outcome_unknown`，且绝不覆盖当前文件；
- `edit_file`、`apply_patch`/`patch_file`、Shell、Git mutation、批量移动/重命名和外部发送仍未声明执行器级幂等恢复；执行期间重启且无法从 side-effect ledger 证明结果时，需要人工核实，不能自动重放；
- 已提交工具结果中的已验证本地文件，在发布到 artifact store 后、checkpoint 落盘前崩溃时可以幂等恢复。稳定发布身份绑定用户、Turn/Job、Step、Tool Call 和候选序号；发布前持久化 ownership marker、大小和内容 SHA-256。恢复只会复用 marker 与目标文件摘要同时匹配的产物，临时源文件已经清理也不影响恢复；身份复用但内容变化、目标被篡改或无 marker 的同名目标都会拒绝认领；
- 这项保证只覆盖已提交副作用结果之后的本地产物发布层，不会把产生该文件的 Shell、Git 或其他外部副作用重新执行；
- artifact 创建工具完成且 checkpoint 已保存时会直接复用 checkpoint 结果；不属于上述稳定本地发布协议的其他发布行为仍按非幂等副作用处理；
- 模型 checkpoint 同时冻结逻辑请求指纹、绑定的模型/Provider/config revision、附件 ID 集合和稳定请求身份；响应落盘前崩溃时只允许 Provider 查单/幂等恢复或人工确认，不会生成新的自动请求。

新增可幂等恢复的执行器时，必须同时满足：

1. 对同一个 `idempotencyKey` 重试不会产生第二份副作用；
2. 能返回第一次执行的权威结果；
3. 有覆盖“执行完成但进程在保存 checkpoint 前退出”的测试；
4. 在本文档的当前支持清单中登记。

## Shell standing rule

`bash_exec` 永远不能创建或命中 standing rule。每次有副作用的 Shell 执行都需要单次批准；只读命令仍可由统一工具 metadata 判定为无需审批。其他工具的 standing rule 继续按目标作用域或参数指纹绑定，并把命中的规则写入 `approvalAuthorization` 供工具卡审计。
