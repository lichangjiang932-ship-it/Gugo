# 参考架构差距分析与修改计划（2026-09-13）

对比基线：当前分支 `feat/ui-prompt-experience-20260906`，回档快照提交 `a16a2aa`。
参考源码：`D:\pi`、`D:\codex`（codex-rs）、`D:\deepseek-harness`、`D:\openworker`。
方法：先读参考项目关键实现，再沿 Gugo 真实调用链逐项核实。凡被现有实现反证的候选差距一律不做"修复"；本文只记录经代码核实的结论。

## 一、五维对照结论

### 1. 极简内核（Pi 骨架）

| 参考机制 | Gugo 现状（核实位置） | 结论 |
|---|---|---|
| 796 行单文件循环 + 钩子组合（`agentLoop`/`agentLoopContinue`/steering/follow-up） | `server/services/loop/runtime.js` 阶段化循环 + `toolLoopAdapter.js` 版本化 lease；`prepareIteration→runModelRequest→processModelResult→executeToolCalls→…` | 已实现（形态不同：Gugo 以阶段函数 + 版本化契约替代单文件，符合 KERNEL_BOUNDARY.md） |
| `stopReason=length` 时拒绝执行截断参数的工具调用（`failToolCallsFromTruncatedMessage`） | `normalizeCompatibleFinishReason` 归一 `length`；`runtime-processModelResult.js` 检查 `closed_truncated_json` 并标记 `modelOutputTruncated` | 已实现 |
| 纯函数 compaction（session reload 语义） | `contextCompactionRuntime.js`：采样前估算（`estimateContextTokens`）+ 阈值触发（`getAutoCompactionThreshold` = min(80% 窗口, activeLimit)）+ 发送前硬预检（`assertPreparedDynamicContextFits`） | 已实现（pre-sampling 语义与 Codex `run_pre_sampling_compact` 等价） |
| AgentMessage 统一消息类型，LLM 边界转换 | canonical history + `providerReplay`（Gemini 签名绑定 provider/model/endpoint） | 已实现且更严格（签名绑定是有意设计，见 GENERAL_AGENT_AUDIT_2026-09-07） |

### 2. 循环引擎（Codex）

| 参考机制 | Gugo 现状 | 结论 |
|---|---|---|
| `run_turn` 内循环 + pending input 排干 | steering controller + checkpoint calls 窗口 | 已实现 |
| turn-scoped client session 复用/预热 | 每轮 HTTP 请求独立；本地短连接场景收益有限 | 有意不采纳（收益主要在云端长连接与 sticky routing，不属于当前目标场景） |
| 恢复/连续执行、审批、context 管理 | lease/fencing、`modelRequestRecovery`、pending approvals 持久化 | 已实现 |

### 3. 控制系统（WorkBuddy 参考 / DSH 审批门）

| 参考机制 | Gugo 现状 | 结论 |
|---|---|---|
| 审批 ask/decide 持久审计对 | `pending_approvals` + `tool_audit` 全闭环，DB 决策权威 | 已实现 |
| remembered grants（"始终允许"） | `approvalDecisionService.js` `rememberTool`/`rememberedGrants` 同事务提交 | 已实现 |
| fail-closed 审批缺省（不可答 ⇒ 拒绝） | `APPROVAL_MODE=off` 保守拒绝；仅显式 `bypass` 全放行 | 已实现 |
| pre/execute around/post 事件化管线（waterfall 中间件链） | `runPreTool`/`runPostTool` 固定调用点 + hooks | 有意不采纳（架构级重构，固定点已覆盖现有 hook 语义；改造收益不抵风险） |

### 4. 本地优先（OpenWorker 底座）

| 参考机制 | Gugo 现状 | 结论 |
|---|---|---|
| Ollama 一等 provider（无 key、`/api/tags` 模型列表、专门诊断文案） | `ollamaNative.js` `listOllamaModels` + 端点 profile | 已实现 |
| 本地模型文本工具调用抢救（`_maybe_salvage_tool_calls`：`<tool_call>` JSON、Qwen/Hermes XML、裸 JSON 白名单） | `server/utils/textToolCalls.js` 仅支持前两种标记格式；**裸 JSON 无标记抢救缺失**；**标记内解析失败时调用体被静默丢弃** | **差距，本轮修复（GAP-1/GAP-2）** |
| durable resume：pending tool call 落盘 → 重放未答调用 | 检查点 + 副作用 ledger + `modelRequestRecovery` 槽位 | 已实现 |
| roots 共享引用、token 级 shell allowlist、Inbox 统一交互 | 目录授权 + 审批收件箱 | 已实现（形态不同） |
| 静态能力矩阵（保守默认） | `endpointProfile.js` 解析 + 探测输入 | 已实现 |

### 5. 插件化（DeepSeek Harness）

| 参考机制 | Gugo 现状 | 结论 |
|---|---|---|
| apply+inject+disposer、注册即 effect | `runtimePlugin*` 生命周期 controller、可回滚贡献激活/撤销 | 已实现 |
| 签名/不可变 Release、兼容契约 | Ed25519 publisher、Plugin Compatibility v1 | 已实现 |
| durable Agent Event 消费（v2 至少一次） | outbox + fenced lease + retry/DLQ | 已实现 |
| bundle/profile/patch 行清单组合配置 | 设置开关 + manifest | 有意不采纳（产品级组合表达力扩展，超出本轮；现有 manifest 已含兼容/权限边界） |

### 6. UI 外观（zcode / codex / deepseek-harness）

UI 差距需要真实运行对比与产品决策（布局密度、流式渲染节奏、工具卡片样式等），不属于可静态核实的契约差距，本轮不动；后续应基于隔离浏览器实测出具体清单再立项。

## 二、本轮坐实的不足与行动

### GAP-1（缺陷）：标记内解析失败的工具调用被静默丢弃

- 位置：`server/utils/textToolCalls.js` `extractTextToolCalls`。
- 现状：`<tool_call>…</tool_call>` 内的 body 若 JSON/XML 均解析失败，`parseCallBody` 返回 null，该调用既不进入 `toolCalls`，body 也不保留在可见 `content` 中——模型以为已发出调用，宿主却整体吞掉，下一轮模型看不到自己的坏格式输出，无法自纠，可能原地等待或假完成。
- 修复：解析失败时把原始 body 保留进 `content`（保持原文顺序），让模型在下一轮看到自己的输出并重新发出正确调用。不生成合成错误工具结果（协议需要合法工具名，坏 body 常连名字都无法信任）。

### GAP-2（差距）：本地模型裸 JSON 工具调用无抢救

- 参考：OpenWorker `openai_provider.py` `_maybe_salvage_tool_calls`——Ollama 上多个本地模型把工具调用写成无标记 JSON，OpenWorker 以"本轮请求过的工具 schema"为白名单抢救。
- 现状：Gugo 只识别 `<tool_call>` 标记格式；模型直接输出 `{"name":"read_file","arguments":{…}}`（或包在 ```json 围栏里）时不产生工具调用。
- 修复：新增 `salvageBareJsonToolCall(value, { allowedToolNames })`，仅在以下全部条件成立时接受，控制误报：
  1. 文本不含任何 `<tool_call` 标记（标记路径仍由 `extractTextToolCalls` 独占）；
  2. 剥离单个 JSON 围栏与首尾空白后，整段文本是一个 JSON 对象（正文与 JSON 混排不抢救）；
  3. 顶层 `name`/`function.name` 精确命中本轮实际下发的工具名白名单（大小写敏感，不做模糊匹配）;
  4. `arguments`/`parameters` 可解析为参数载荷。
  抢救结果与 `<tool_call>` 路径同形状；执行仍走既有 schema 校验、审批与信任门，不新增任何授权路径。
- 集成点：`server/services/loop/runtime-runModelRequest.js` `normalizeCompatibilityToolCalls`，白名单来自 `s.activeToolSpecs`（经 `toolNameFromSpec`）。仅接入共享 loop 主路径；`modelInvocationRuntime.js` 的非循环兼容路径保持现状。

## 三、验证方式与结果（2026-09-13）

- `tests/textToolCalls.test.js`：17/17 通过（新增 GAP-1 坏 body 保留、GAP-2 白名单接受/拒绝全场景）。
- `tests/englishTerminalSanitization.test.js`、`tests/loopRuntimeContract.test.js`、`tests/loopMarkers.test.js`、`tests/modelInvocationRuntimeBoundary.test.js`（合计 9 项）与 `tests/serverTurnFlow.test.js`（14 项）全部通过。
- 改动文件 `npx eslint` 零新增问题。
- 既有无关失败（在快照 `a16a2aa` 上以 stash 方式复核，与本轮改动无关，单独记录）：
  - `tests/turnEngine.test.js` 3 项（如 `TurnEngine owns a text turn…` 期望 `completed` 实得 `failed`）；
  - `tests/subagentRuntime.test.js` 3 项（`Loop runtime contract violation`：子代理测试 mock 依赖袋缺 `createCheckpointBarrier`、`createJobBudget` 等 7 个核心键，生产依赖袋曾缺 `extractTextToolCalls` 的同类漂移问题已由本轮一并修复）。
  - 全仓 `npm run lint` 当前处于非零状态（大量与本轮无关的 no-unused-vars），全量门禁恢复不在本轮范围。
- 不在无真实模型环境的情况下宣称任务成功率变化；GAP-2 对本地模型完成率的实际收益须走 `docs/LIVE_AGENT_EVALS.md` 的显式入口实测。

## 四、遗留（记录，不在本轮）

- DEBT-TYPE-001 / DEBT-RELEASE-001 / DEBT-RELEASE-002 / DEBT-NET-002：维持既有登记，本轮不重复开单。
- 工具管线 waterfall 化、插件 patch 组合、UI 对齐：见上文"有意不采纳"，需要单独立项与取舍评审。
- WorkBuddy：`D:\workbuddy` 仅为插件配置痕迹，无可借鉴源码；维持"仅参考技能使用方式"的既有边界。
