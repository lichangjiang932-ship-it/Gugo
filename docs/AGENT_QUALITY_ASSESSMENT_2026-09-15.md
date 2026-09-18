# Agent 工程质量评估（2026-09-15）

对照「一个好的 Agent」六个维度，逐项核实 Gugo 当前实现。所有结论都给出代码位置或
可执行测试；不把历史报告当作当前版本的通过证明。本文件区分**已核实强项**、
**已确认不足**和**本会话已修**。

评估基线：HEAD `23c1dec` + 本会话工作树（未提交）。

---

## 1. Agentic Loop（循环与终止）

### 现状（强）
- 阶段化循环：`server/services/loop/runtime.js` 的 `prepareIteration → runModelRequest →
  processModelResult → executeToolCalls → createOutcomeRecorder → completeToolBatch →
  completeIteration`，外层 `finalizeRuntime` 收尾。
- 终止条件分层：`MAX_ITERS`（默认 2000，`GUGO_MAX_ITERS` > `JOB_MAX_ITERS`）、
  `createToolLoopGuard`（重复调用 3、窗口重复 6、连续错误 6、同工具失败 20、创作类错误 20）、
  `createRepeatCallGuard`、无进展收敛（`runtime-completeIteration.js` 的 `tool_no_progress`）。
- 会话级单飞：`SESSION_TURN_ALREADY_RUNNING`；执行租约 + fencing（`turnExecutionLeases`）。
- 状态流转由持久检查点承载，可在任意边界恢复。

### 已确认不足
1. **循环状态是 241 项共享依赖袋**（`runtime.js:161`），契约校验已补全（见本会话 1.2），
   但阶段之间仍是隐式耦合，不是 Pi 那种显式 per-phase 依赖。
2. **`MAX_ITERS` 默认 2000 对交互回合偏大**：真正收敛靠 no-progress guard，轮数上限只是兜底。
   这本身合理，但没有任何"按剩余上下文/token 预算动态收紧轮数"的机制。
3. **无显式状态机图**：阶段顺序写在 `runPreparedToolsLoopWindow`，没有可校验的转移表。

---

## 2. 性能与 KV 缓存

### 现状（强）
- 前缀缓存：`prompt_cache_key` 仅对官方 OpenAI 或显式声明的端点发送，作用域含 owner/provider/model
  （`modelRequestCache.js`）；工具定义经 `canonicalizeModelTools` 稳定排序；开头连续 system
  块（safety/identity/skills）保持稳定；易变内容放尾部或在原位置替换
  （`modelRequestBuilder.js` 的 `mergeLeadingSystemMessages`、`runtimeCapabilities.js:119`）。
- 上下文预算：发送前 `estimateContextTokens` + 阈值触发 + 硬预检
  （`assertPreparedDynamicContextFits`）；语义摘要 + 机械截断双轨。
- 工具结果按剩余窗口与并发数动态限长（`toolCallResults.js:26`）。
- 流式：首个有效输出 + idle 双轨超时；文本工具调用增量状态机（本会话修正）。

### 已确认不足
1. **`ephemeralContext` 已做出决策（本会话）**：循环当前没有任何“每轮易变的头部内容”，
   因此不必向提示注入额外噪声。保留这条已测试的尾部追加 seam，并在代码里明确记录：
   未来的时钟/剩余预算提示必须走它，不得改写前缀；当前守卫继续用原位 system 消息
   （它们需要持久化供 `hasRuntimeMarker` 去重，且本就在尾部附近）。
2. **稳定/动态工具前缀分离已实现**（本会话）：`canonicalizeModelTools` 现在把中途激活的工具
   （技能/MCP/search_tools）排在基础工具之后，而不是合并后重新全排序；基础工具的名字序保持稳定，
   因此一次追加不会重排已缓存的工具块前缀。循环用内部标记 `__gugoDynamicTool` 标注动态工具，
   该标记在唯一的规范化点被剔除，OpenAI 与原生请求体都不会序列化它。
3. **缓存命中观测已部分补上**（本会话 CLI `--progress` 输出 measured cached）；尚无跨轮聚合指标。

---

## 3. 记忆系统

### 现状（中上）
- 短期：当前轮上下文 + 有界历史窗口（80 条）+ 压缩归档。
- 长期：SQLite `memories` + `memory_links` + 知识图谱（`entities/relations/observations`）。
- 检索：CJK 二元组 + 词项提取 + 打分排序（`scoreMemoryRelevance`）+ SQL 预筛 + 图谱一跳扩展 +
  新鲜度分级 + 矛盾抑制 + token 上限适配（`memoryContextService.js`）。
- 注入失败降级为空上下文，不阻断模型调用。

### 已确认不足
1. **向量/语义召回已实现但默认关闭**（本会话）：新增可选 BYOK embedding 层（`memory_embeddings` 表、
   向量存量与就地余弦排序、背景索引器、fingerprint 失效重建），开启后与词法分数相加混合。
   未开启时行为与之前完全一致（无网络调用）。剩余：候选集上限是最近/pinned 的 240 条。
2. **打分长度归一已补**（本会话）：长文档不再因“恰好包含词项”而压过短焦点记忆。
3. **记忆写入的冲突/去重策略仍分散**（auto memory 与显式 remember 各自处理）。

---

## 4. 规划与推理

### 现状（强）
- `/goals`：先生成可编辑计划并**等待显式批准**，再执行/验证/记录检查点；
  即使全局审批放行也不跳过首次计划批准。
- plan 模式：只暴露本地只读工具，并在运行时拒绝伪造的受限调用。
- 子代理：`explore`/`plan`/`general` 独立上下文与工具循环。
- 动态重规划：失败恢复（`installToolFailureRecovery`）、`shouldReflectOnFailure`、
  `reflect`/`manage_todos`/`request_clarification` 工具。
- 自纠：执行证据闸、产物校验、任务验证修复（task verification repair）都是**宿主强制**的证据闭环，
  不依赖模型自述完成。

### 已确认不足
1. **计划与执行是两段式，不是可重入的 plan-DAG**：没有把计划步骤与工具调用/证据一一绑定，
   动态改计划的证据较弱。
2. **无 Reflexion 式的显式"失败反思写回"**：反思是提示与守卫驱动，没有结构化的反思记忆回灌。

---

## 5. 工具使用与生态

### 现状（强）
- 原生 function calling + 文本协议抢救（`extractTextToolCalls` + `salvageBareJsonToolCall`）。
- 结果处理：结构化截断、二进制走受管通道不经过 5 MB 文本通道、媒体/PDF/归档工具。
- 错误隔离：`executeToolWithRetry`、工具失败恢复提示、`sideEffectLedger`（未知结果不重放）、
  审批门控（按参数判风险，DB 为决策权威）。
- MCP：stdio + Streamable HTTP + Legacy SSE，白名单 + 审计。

### 已确认不足
1. **文本协议路径与原生路径能力不对等**：裸 JSON 抢救只在共享 loop 主路径生效；
   `modelInvocationRuntime.js` 的非循环兼容路径保持旧行为（已在文档登记）。
2. **工具结果截断是"尾部保留"还是"头部保留"取决于工具**，没有统一的"关键字段抽取"策略，
   大 JSON 全量塞入仍可能挤占窗口。

---

## 6. 可靠性与工程化

### 现状（强，且是本项目最突出的一面）
- 依赖袋契约 240 项全量校验 + 类型（本会话 1.2）；完成策略定义与 checkpoint 版本（本会话 3.1–3.3）。
- 事件协议：`shared/turnEvents.js` 单一 Zod 词表，strict + 反向 fixture；SSE/WS/audit/插件共用。
- 审批：`pending_approvals` + `tool_audit` 全闭环，崩溃后仍可决策。
- 可观测：Turn 事件、`tool_audit`、usage（含缓存命中）、phase heartbeat。
- 门禁：900+ 测试文件、lint、typecheck（反向 fixture）、debt、函数复杂度、依赖清单。

### 已确认不足
1. **只读 trace 命令已补（本会话）**：`gugo trace <turnId> [--session-id] [--json]` 从本地持久事件
   重建一条时间线并汇总模型/工具/审批/检查点/token。仍无 OpenTelemetry 式的 span/父子关系与跨进程导出。
2. **完成策略诊断此前只在内部**（本会话已通过 Turn 事件 + CLI 输出补上）。
3. **CLI 与网页的完成规则本应同源**：目前共用 `shared/turnEventProjection` 与 loop，
   但网页侧尚未按本会话的 CLI 契约回归（本阶段不动网页）。

---

## 本会话已修（相对上面的不足）

| 维度 | 改动 | 证据 |
|---|---|---|
| Loop 终止/一致性 | `callTrackedModel` 在已取消时于 heartbeat/预算前抛出，wrap-up 不再进入模型传输 | `tests/cliSignalCancellation.test.js` 等 |
| 依赖袋 | 240 项全量契约 + kind + 未知键 fail-closed | `tests/loopDependencyBag.test.js` |
| 完成策略 | 8 策略单一定义 + checkpoint 版本/转换 + 结构化诊断 | `tests/completionPolicy.test.js`、`tests/turnEvents.test.js` |
| KV/上下文 | 文本工具协议流式过滤器恢复可续；`ephemeralContext` 决策已记录；稳定/动态工具前缀分离 | `tests/textToolCalls.test.js`、`tests/modelToolOrdering.test.js` |
| 记忆 | 新增可选 BYOK 向量/语义召回（默认关闭、无网络）+ 长度归一；修了一个可返回负分的边界 | `tests/memoryEmbeddings.test.js`、`tests/memoryEmbeddingStore.test.js`、`tests/memoryRelevanceScoring.test.js` |
| 规划 | （未改，见下） | — |
| 工具 | （未改，见下） | — |
| 可观测 | CLI `--progress` 输出 token/cached 使用；终态输出 completion policy；新增只读 `gugo trace <turnId>` 时间线 | `tests/cliRunOutput.test.js`、`tests/cli/localTurnTrace.test.js` |
| CLI 选择 | `--cwd` 真正决定工作区与项目指令；同名模型消歧；本地不静默上云 | `tests/cli/modelSelection.e2e.test.js` |

---

## 优先修复建议（按性价比）

1. **启用或删除 `ephemeralContext`**（已决策，见第 2 节）。
2. **稳定工具集与动态工具分离**（已完成，见第 2 节）。
3. **统一 trace**（部分已做）：已提供只读 `gugo trace` 与 span 层级导出（`--export otel`）。
   把稳定 `traceId`/`spanId` **持久化**进现有 Turn 事件尚未做：Turn 级 trace id 与
   `turn_id` 冗余，真正有价值的是表达“根 trace ↔ 子 turn（子 agent/任务步骤）”的父子关系，
   那需要一个 trace 根/子 span 的设计，不能用派生 id 硬塞。
4. **计划-证据绑定**（服务端 + loop 已实现，网页未接线）：见下。

本会话新增（服务端）：
- 目标计划版本化 + 步骤证据绑定 + 状态机 + 事件 + 乐观并发 + 证据不可重用 + 事件裁剪（`gugo goal`）；
- **loop 已接入**：有计划时挂载 `goal_plan_status`/`goal_step_update`/`goal_plan_rewrite` 并把计划注入 prompt；
  agent 不能自建计划，未批准不去开工；`done` 由宿主回读持久 Turn 事件核验。
- 真实模型回归基线（`eval:live` 的数据集指纹 + `--baseline` 漂移 + `--repeat` 严格重复）；
- 记忆向量索引回填 CLI，并修掉 `listMemoriesNeedingEmbedding` 的积压饥饿 bug。

网页 `/goals` **已接线**：`/api/goals/*` 路由 + 面板读写同一份持久计划（面板故意不能把步骤置 `done`，
完成必须由 agent 引用宿主可核验的工具调用）。仍开放：trace 根/子 span 设计。

---

## 结论

在"不只是一个聊天壳"这件事上，Gugo 已经越过大多数个人 Agent 项目：它有真实工具循环、
宿主强制的完成证据、崩溃可恢复、审批与副作用账本、以及罕见的工程门禁密度。
本会话已把长期记忆从“纯词法”补到“可选语义召回 + 长度归一（默认关闭、无回归风险）”，
并完成了稳定/动态工具前缀分离。仍开放的是：

1. **统一 trace 的根/子 span 设计**：`gugo trace` 与 span 导出已提供；把 `traceId`/`spanId` 写进
   Turn 事件需要先定义“根 trace ↔ 子 turn”的语义，否则只是把 `turn_id` 派生一遍。
2. **聊天 `/goals` 的接线**：服务端目标计划与 loop 工具已就绪（`goal_plans` + 证据绑定 + 版本化重规划
   + `gugo goal` + `goal_*` 工具）；网页仍用客户端 TODO，需要路由与计划面板接入。
3. **prompt 前缀稳定性**：稳定/动态工具分离 + 新增本地
   `promptPrefixFingerprint` 护栏（稳定前缀指纹 + `comparePromptPrefixes`，并有测试钉住“注入计划/记忆不改动稳定前缀”）。
   与 provider 上报的 `cacheHitRatePercent` 互补：后者说命中多少，前者说前缀有没有被打碎。
4. **取消/恢复**：已有 15 个取消/恢复测试文件；本轮补上了截断事件日志的边界扫描不变量
   （任何事件前缀都不得被投影为 `OK`）。仍缺完整取消栅栏的逐边界压力扫描。
5. **已修掉的复审 bug**（详见 `CLI_HARDENING_BASELINE.md`）：日志/span trace id 精神分裂、
   `goal prune` 逐用户 vs 逐计划语义相反、prompt 块静默截断与进度计数、记忆索引 keyset 饥饿、
   死状态 `s.goalToolContext`。

它们不是"推倒重写"级别的问题，而是可按上面优先级逐项收敛的工程改进。
