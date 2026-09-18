# CLI 硬化基线记录（2026-09-15）

本文是「先完善 CLI」改造的起点快照。它只记录**改造开始前**的真实状态，不宣称任何
历史报告的通过结论对当前版本仍然成立。

## 1. 起点

| 项 | 值 |
|---|---|
| HEAD | `23c1dec3df3cb6a9399c3802996709f9540fb4ca` |
| HEAD 标题 | `fix: preserve malformed text tool-call bodies and salvage allowlisted bare JSON calls` |
| 版本 | `0.11.56`（`package.json`） |
| 分支 | 工作树直接位于该提交之上，未新建分支 |

## 2. 改造开始时的未提交改动（全部保留）

```
 M docs/REFERENCE_GAP_ANALYSIS_2026-09-13.md
 M server/services/loop/incompleteTerminalPresentation.js
 M server/services/loop/runtime-executeToolCalls.js
 M server/services/loop/runtime.js
 M src/i18n/domains/chatMessages.js
 M src/index.css
 M src/pages/ChatSplit/chatMessages/messageRow/ExecutionTimeline.jsx
 M tests/uiVisual.test.js
 M tests/unit/MessageRowActivity.execution.test.jsx
 D used-symbols.txt
?? docs/REFERENCE_GAP_INCREMENTAL_2026-09-14.md
?? src/lib/executionResultSummary.js
?? tests/executionResultSummary.test.js
?? tests/loopDependencyBag.test.js
```

这些属于**其他 agent 的在途工作**，本阶段不重置、不覆盖、不顺手整理：

- **依赖袋修复**：`server/services/loop/runtime.js` 的 `runtimeDependencies` 恢复到
  241 个符号；新增 `tests/loopDependencyBag.test.js` 审计。
- **完成态修复**：`runtime-executeToolCalls.js` 抽出 `localizeForState`；
  `incompleteTerminalPresentation.js` 导出它，避免语言硬编码。
- **执行摘要**：新增 `src/lib/executionResultSummary.js`、`tests/executionResultSummary.test.js`，
  并接入 `ExecutionTimeline.jsx`、`chatMessages.js` 的 zh/en 文案。
- **UI 改动（V1–V3）**：`src/index.css` 收紧步骤间距/去卡片阴影、恢复 16px 序号，
  `tests/uiVisual.test.js`、`tests/unit/MessageRowActivity.execution.test.jsx` 同步断言。

**外观相关修改本阶段不继续扩展。**

## 3. 每个待办问题对应的现状证据

| 问题 | 现有实现 | 现有测试 | 缺失测试 | 历史记录 |
|---|---|---|---|---|
| 原生 Provider 中途 system 时序 | `server/adapters/nativeModelProviderRequests.js:87`（Anthropic）、`:181`（Gemini）把**所有** system 上提到顶层；`server/adapters/modelRequestBuilder.js:20-34` 的 OpenAI 路径显式保留中途 system | `tests/modelProxy.test.js:1747`、`tests/modelProxyTimeout.test.js:341`（仅 OpenAI 路径）；`tests/nativeModelProviders.test.js:209,286`（仅开头 system） | 中途 system 定位、工具结果后控制消息、多轮控制消息、多工具成组结果、typed-content system、checkpoint 恢复重建、正文含 marker 不获得控制权 | `docs/REFERENCE_GAP_INCREMENTAL_2026-09-14.md` 只记了 UI/类型/诊断，未覆盖本项 |
| 依赖袋契约 | `server/services/loop/runtimeContract.js:3-12` 只校验 9 个键；`runtime.js:161` 实际 241 个 | `tests/loopDependencyBag.test.js`（工作树新增）、`tests/turnEngine.test.js`、`tests/subagentRuntime.test.js` | 启动/阶段入口 fail-fast、错误含缺失字段与阶段、失败前无副作用 | `docs/REFERENCE_GAP_ANALYSIS_2026-09-13.md` §三「更正（2026-09-14）」 |
| 文本工具流式过滤器 | `server/utils/textToolCalls.js:103-131`，`finish()` 丢弃 `</tool_call>` 之后的正文；使用者 `server/adapters/modelInvocationRuntime.js:416` | `tests/textToolCalls.test.js`（17 项，含 GAP-1/GAP-2） | 闭合标记跨 chunk、同 chunk 多块、闭合后正文透传、未闭合/畸形/近似标签、缓冲上限、重复 finish | `docs/REFERENCE_GAP_ANALYSIS_2026-09-13.md` GAP-1/GAP-2 |
| typed-content marker 检测 | `server/services/loop/runtime-initializeConversation.js:97` 用 `String(message.content)` | 无 | 数组 content 的文本提取与来源边界 | 未登记 |
| `JOB_MAX_ITERS` 语义 | `server/services/loop/heuristics/constants.js:5-9`，同时管交互与 Job | `tests/` 中无直接断言 | 明确作用范围与兼容别名 | 未登记 |
| CLI 无网页预检 | `bin/yma-cli.js` 只有 HTTP `doctor`；`bin/cli/serverCommands.js:cmdDoctor` 依赖已运行服务 | `tests/cli/`、`tests/cliRunOutput.test.js` | `doctor --headless` 本地预检 | `docs/CLI.md` 未提供；计划新增能力 |

## 4. 隔离演示环境（0.2）

本阶段新增：

- `scripts/cli-demo/prepare-isolated-workspace.mjs`：创建可丢弃的任务工作区与
  独立运行时目录（配置/数据库/产物/日志），并把运行时目录与 `--cwd` 分离。
- `scripts/cli-demo/verify-isolation.mjs`：验收脚本（放在模型可修改工作区之外），
  证明继承的 `APP_DB_PATH`、产物路径、配置路径不会被工作区接管。
- `scripts/cli-demo/acceptance/`：对应 `evals/starter-suite.json` 的外部验收脚本副本入口。

运行时目录与任务工作区必须分离：`--cwd` 只选择任务工作区，不能让待检查项目里的
`.env`/配置文件接管可信运行时。

## 5. 本阶段验证纪律

- 先补复现测试，再改实现，再跑定向回归。
- 不因测试通过自动 commit / push / 发布。
- 不用「历史报告通过」代替当前版本的实测。
- 每批完成后记录实际命令与结果；未运行的项目明确标注。

## 6. 本阶段已实施（CLI 优先）

### 1.1 原生 Provider 消息时序

- `server/adapters/nativeModelProviderRequests.js`：只有**开头连续**的 system 消息进入原生顶层
  `system` / `systemInstruction`；对话中途的运行时控制消息保留相对工具结果的位置。
  - Anthropic：无中途 system 槽位且要求严格 user/assistant 交替，因此把控制文本并入当前 user 回合
    （紧跟 tool_result 之后）；若当前不是 user 回合则新建 user 回合。
  - Gemini：控制消息作为**独立** user content（`controlBoundary`），不并入 functionResponse 的
    parts，也不参与相邻合并。
- 新增 `messageText` 统一提取 typed-content 文本；`mergeAdjacent` 尊重 `controlBoundary`。
- 回归（`tests/nativeModelProviders.test.js`，25/25）：多条前置 system、工具结果后控制消息、
  多轮控制消息、多工具成组结果、typed-content system、恢复后重建一致、用户正文含 marker 不获得控制权。

### 1.3 文本工具协议流式过滤器

- `server/utils/textToolCalls.js`：改为可恢复的增量状态机。完整闭合后恢复普通文本；
  畸形 body 与完整解析器保持一致（可见）；处理跨 chunk 开闭标签、同 chunk 多块、近似标签、
  未闭合、重复 `finish()`；增加 512 KiB fail-open 缓冲上限。
- 回归（`tests/textToolCalls.test.js`，16/16）。

### 1.4 两个小型脆弱点

- marker 检测改用 `messageTextContent`，正确读取 typed-content 文本且拒绝文件/图片元数据伪装；
  覆盖 `runtime-initializeConversation.js`、`runtime-initializeArtifactSteering.js`、`runtimeState.js`。
- 迭代上限：新增 `GUGO_MAX_ITERS`（优先级高于历史 `JOB_MAX_ITERS`），默认仍为 2000，
  不会因非法值悄悄改变有效轮数；`evolutionConfigPolicy` 与 `.env.example` 同步。
- 回归（`tests/loopIterationBudget.test.js`，5/5）。

### 2.1 CLI 无网页预检

- 新增 `doctor --headless`（`bin/cli/headlessDoctor.js`、`server/services/headlessDoctorService.js`）：
  复用运行时配置解析、`bootstrapAuth`、`resolveAgentModelRuntimeBinding` 与 Provider 探针，
  不另建模型选择逻辑。默认不发模型请求；`--probe` 显式刷新并写入 readiness。
- 保留无参数 `doctor` 的 HTTP 行为；headless 专属选项在缺少 `--headless` 时以退出码 2 拒绝。
- `runtime.cwd` 始终是启动目录，`--cwd` 只选任务工作区；`runtime` 报告数据/数据库/产物/配置路径
  与本次显式覆盖的存储键。
- 探针逻辑抽取为 `server/services/modelProviderDiagnosticService.js`，HTTP 路由改为复用并保持
  兼容 re-export；`tests/modelProviderRoutes.test.js` 20/20。
- 回归（`tests/cli/headlessDoctor.test.js`，6/6）。

### 0.2 隔离演示环境

- `scripts/cli-demo/prepare-isolated-workspace.mjs`：复制 starter 夹具到可丢弃工作区，
  生成独立 runtime/{data,artifacts,logs} 与 `manifest.json`；验收脚本指向 `evals/verifiers/`（工作区外）。
- `scripts/cli-demo/verify-isolation.mjs`：证明 `APP_DATA_DIR`/`APP_DB_PATH`/`ARTIFACT_DIR` 均在隔离根内、
  不指向 `server-data`，且工作区 `.env` 在 runtime cwd 为仓库根时无法接管。
- `npm run cli:demo:prepare` / `npm run cli:demo:verify`；回归 `tests/cliIsolationScripts.test.js`（1/1）。

### 1.2 依赖袋契约

- 新增生成器 `scripts/generate-loop-dependency-manifest.mjs`（基于 acorn）：用语法分析提取
  `s.d.X`、`s.d['X']`、`const {X} = s.d`（含别名/默认值/嵌套模式）；rest 元素和无法静态解析的
  计算访问会被报为 unresolved 并 fail-closed，不再静默漏掉。
- 生成 `server/services/loop/dependencyBagManifest.js`：`required`（真实消费的 240 个符号）、
  `declared`（bag 实际键）、`retained`（应为空）。`VERIFIED_DIRECTORY_RESOLUTION` 是唯一未被消费的
  死条目，已从 bag 与 import 中移除。
- 新增 `server/services/loop/dependencyBagContract.js`：240 项 `RUNTIME_DEPENDENCY_KINDS`（区分
  function/string/number/set/regexp/array/object/symbol），`inspectRuntimeDependencies` 返回
  missing/invalid/unexpected。
- `runtimeContract.js` 的 `assertRuntimeDependencies` 升级为完整校验（不再只查 9 个键），
  保持 `LOOP_RUNTIME_CONTRACT_VIOLATION` / `LoopRuntimeContractError` / `stage` / `missingFields`
  兼容，并新增 `invalidFields` / `unexpectedFields` / `expectedKinds`。
- `prepareToolsLoopRuntime(context, dependencies = runtimeDependencies)` 在校验后才构建状态，
  依赖缺失或类型不符在任何 phase、模型调用、工具执行前 fail-fast。
- 回归（`tests/loopDependencyBag.test.js`，9/9）：manifest 与源码一致、消费⊆声明、无死条目/重复、
  kind 完整且无 stale、缺键在触碰 context 前拒绝、类型不符拒绝、未知键拒绝、完整 bag 通过、
  空 bag 仍 fail-closed。`tests/loopRuntimeContract.test.js` 15/15。

### 2.2 模型与工作区选择核验

- 新增端到端回归 `tests/cli/modelSelection.e2e.test.js`（每个用例都跑真实 CLI + 隔离 APP_DATA_DIR + 本地假模型服务）：
  同名模型多 Provider 时不传 `--provider` 必须 `MODEL_PROVIDER_AMBIGUOUS` 且两个 Provider 都收到请求；
  `--provider` 能正确消歧且只有被选中的 Provider 收到请求；`--cwd` 决定工具工作区与项目指令；
  本地 Provider 失败时不会向未授权的云端 Provider 发出 failover 请求。
- 修复发现的真实缺口：当用户配置了默认输出目录或测试隔离目录时，`--cwd` 会被 `configuredOutputDirectory`/
  `isolatedTestOutputDirectory` 顶掉，导致项目指令不来自 `--cwd`。现在显式 `--cwd` 会同时决定 turn 的
  `projectDirectory`，而默认输出目录仍控制新文件写入位置：
  - `bin/yma-cli.js`：`parseRunArgs` 新增 `cwdExplicit`；`cmdRun` 向下传递 `workspaceExplicit`。
  - `server/services/headlessTurnRuntime.js`：显式 `--cwd` 时设置 `GUGO_CLI_WORKSPACE_ROOT`。
  - `server/services/localFileAccessService.js`：`resolveTurnProjectDirectory` 在无显式 `workspacePath` 时
    优先使用 `GUGO_CLI_WORKSPACE_ROOT` 作为 `projectDirectory`，`defaultOutputDirectory` 保持原配置。
- 恢复语义沿用现有实现（`turnResumeRuntime` 的 `requirePersistedBinding: true`），不重写。

### 2.3 输出契约与可选进度

- 复核并保持现有契约：JSONL stdout 只有可解析事件；文本模式 stdout 仅在真实成功时输出 `payload.text`；
  审批/诊断/错误走 stderr；不把部分结果伪装为完整交付。
- 新增 `--progress`（`bin/cli/runOutput.js` 的 `formatProgressEvent`）：把事实性进度写入 stderr
  （`turn started`、`model <phase>`、`tool <name> started/finished/failed`、`progress n/m`、
  `approval required/approved/denied`），不输出私有推理、不预告未提交的完成，且不向 stdout 写任何内容。
- 回归：`tests/cliRunOutput.test.js` 15/15（新增 2 项）、`tests/cli/yma-cli.test.js` 解析新增 `--progress`
  与 `cwdExplicit` 断言。

### 2.4 取消不重入模型（补充不变量）

- 复核：非交互审批保守拒绝（`headlessTurnRuntime.resolveApproval` 在 `interactive !== true` 时直接 `deny`，
  不读输入、不挂起）已被 `tests/cli/yma-cli.test.js` 覆盖；`acceptEdits` 只自动放行 `EDIT_TOOLS`
  （文件/本地转换），shell、下载、破坏性 PDF 仍逐次确认，已被 `tests/approvalPolicy.test.js` 覆盖；
  信号/超时退出码 130/143/124 已有覆盖。
- 新增不变量：`server/services/loop/runtime-initializeSteering.js` 的 `callTrackedModel` 在
  `requestSignal.aborted` 时于 heartbeat/预算/消息准备之前抛出取消原因。之前也依靠
  `assertContextRecoveryActive` 阻止真实 HTTP，但现在所有"补最终回答"的 wrap-up 路径
  （finalizeRuntime、completeIteration × 2、budget/reasoning）都不会再进入模型传输。
- 回归：`tests/cliSignalCancellation.test.js`、`tests/turnCancellationRuntime.test.js`、
  `tests/modelExternalAbortRecovery.test.js`、`tests/modelRequestCancellationTerminal.test.js` 全绿。

### 3.1 完成策略：先固定现有行为

- 新增 `server/services/loop/completionPolicy.js`：把 8 个活动策略 + 1 个兼容字段定义为单一只读来源，
  每个策略记录 `id`、`stateKey`、`limit`、`active`、`monotonic`、`scope`、`resetOn`、`onExhausted`。
- 把原先只存在 `runtime.js` 的三个阈值（`MAX_DELIVERABLE_SELECTION_RETRIES`、
  `MAX_SOURCE_HANDOFF_RETRIES`、`MAX_LOCAL_HTML_DELIVERY_RETRIES`）上提到 `heuristics/constants.js`，
  使八个阈值同源；`runtime.js` 改为导入（依赖袋名称不变，`deps:check` 仍绿）。
- 纯函数 `describeCompletionPolicies` / `exhaustedCompletionPolicies` 提供只读结构化投影（不改变任何运行时行为）。
- 复核发现并固定：三个计数器是**单调**的（`executionEvidenceRetries`、`directoryResumeRetries`、
  `sourceHandoffRetries` 在回合内不重置），与其余五个有重置点的策略不同；这一点已写入定义并由测试锁定。
- 回归 `tests/completionPolicy.test.js` 6/6：定义唯一/版本化、阈值与运行时一致、状态键均被 checkpoint 序列化、
  每个活动策略有增量点且非单调策略有重置点、单调集合被显式固定、投影边界（limit-1/limit/超限）与空输入、
  非活动兼容字段永不报耗尽。

### 3.2 完成策略的结构化诊断

- `completionPolicy.js` 新增 `completionPolicyDiagnostics(state)`：只报告 `attempts > 0` 的策略，输出
  线上的形状 `{ id, attempts, limit, exhausted }`（最多 16 条，不泄露 stateKey/active/remaining）。
- `shared/turnFailureSchemas.js` 新增 `completionPoliciesSchema`（bounded、严格）；
  `shared/turnEvents.js` 把它加到 `turn.interrupted`/`turn.blocked`/`turn.paused`/`turn.completed`/
  `turn.cancelled`/`turn.failed`（均为 additive 可选字段，`.strict()` 下必须显式声明）。
- `runtime-initializeTerminalCompletion.js` 在 `finishIncomplete` 与 `finishTerminalResult` 的 incomplete 元数据里注入诊断。
- `shared/turnEventProjection.js` 的 `projectInvalidCompletedEvent` 三个分支都保留该字段（之前会丢）。
- CLI：`bin/cli/runOutput.js` 的 `terminalDiagnostic` 与 `formatRunError` 渲染
  `Completion policies: <id> <attempts>/<limit> (exhausted)`，JSONL 的 `cli.error` 也带上原始条目。
- 回归：`tests/completionPolicy.test.js` 10/10、`tests/turnEvents.test.js` 22/22（新增 schema 接受/拒绝与投影保留）、
  `tests/cliRunOutput.test.js` 16/16。

### 3.3 Checkpoint 内部版本与转换

- `completionPolicy.js` 新增 `COMPLETION_POLICY_VERSION = 1`、`restoreCompletionPolicyState(guards)`、
  `completionPolicyAttempts(guards, key)`：
  - 缺失/空版本 → 视为 legacy v0，用显式 0 默认位升到 v1；
  - 非整数/负数或版本 > 1 → 抛 `COMPLETION_POLICY_VERSION_UNSUPPORTED`（fail-closed，不静默重置计数）；
  - 持久化值高于上限时不被 clamp，恢复后仍是 exhausted。
- `runtime-initializeArtifacts.js` 在 `s.restoredState` 就绪后一次性计算 `s.completionPolicyState`；
  `runtime-initializeCompletion.js`、`runtime-initializeConversation.js` 的 8 个计数器恢复改为读同一来源，
  删除重复的 `Math.max(0, Number(...))` 逻辑。
- `runtime-initializeExecution.js` 的 `completionGuards` 写入 `completionPolicyVersion`。
- 回归：legacy 升级不重置、v1 往返、未知/畸形版本 fail-closed、连续与恢复状态一致。

### 可观测性（CLI）

- `--progress` 的 `model.phase completed` 现在输出事实性 token 使用：
  `model completed (prompt 1200, cached 900, completion 40)`；cached 来自真实测量，未知不报 0。
- 新增只读 `gugo trace <turnId> [--session-id <id>] [--limit <n>] [--json]`：
  从本地持久事件重建单个 Turn 的时间线，并汇总模型阶段/工具调用与失败/审批/检查点/prompt・completion・cached。
  不启动 HTTP、不调用模型。`server/services/localTurnTraceService.js` + `bin/cli/traceCommand.js`；
  回归 `tests/cli/localTurnTrace.test.js` 3/3。

### 语义记忆召回（可选 BYOK，默认关闭）

- 新增 `server/services/memoryEmbeddingService.js`：显式开关 `MEMORY_EMBEDDINGS_ENABLED=1` +
  `MEMORY_EMBEDDING_MODEL` + base URL（可回退 `MODEL_*`）；纯函数余弦相似度、语义分混合、
  Float32 序列化、内容 fingerprint；`embedMemoryTexts` 校验 provider 响应形状（重复 index、维度不一、NaN 均拒）。
- 新增迁移 `v117MemoryEmbeddings.js` + `server/dbSchemaContract.js` 的
  `memory_embeddings: ['memory_id']`（引入版本 117）；`memoryStore.js` 超 600 行后拆分：
  `memoryEmbeddingStore.js`（向量存取/索引候选/相似度）与 `memoryRowMapper.js`。
- 新增 `memoryEmbeddingIndexer.js`：有界背景索引（每轮最多 8 条，fingerprint 失效重建）。
- 接入点：`turnEngineHost` 提供 `prepareMemoryQueryVector` / `indexMemoryEmbeddings`；
  `turnExecutionRuntime` 在同步的 prompt 准备前异步、best-effort 计算查询向量；
  `turnPromptContext` → `memoryContextService` → `selectActiveMemoriesForInjection({ queryVector })`。
  启用语义时不再用词法谓词预过滤（否则概念相关但无字面重合的记忆永远进不了排序），
  候选集仍限最近/pinned 240 条。
- 默认行为完全不变：未开启时无网络调用、无额外候选、排序与之前逐位一致。
- 回归：`tests/memoryEmbeddings.test.js` 9/9、`tests/memoryEmbeddingStore.test.js` 3/3、
  `tests/dbMigrationRegistry.test.js` 新增 v117 表/约束/级联。

### `ephemeralContext` 决策

- 结论：**保留已测试的尾部追加 seam，但不接入任何易变提示**。循环当前没有“每轮易变的头部内容”，
  注入只会增加噪声；未来的时钟/剩余预算提示必须走它，不能改写前缀。原位 system 守卫继续保持不变
  （它们需要持久化供 `hasRuntimeMarker` 去重）。已在 `outboundMessagePipeline.js` 就地记录决策。

### 全量回归

- `npm test`：**920 个测试文件全部 PASS**（TAP `ok` 7927 条，`not ok` 0）。日志：`output/full-test-2026-09-15t.log`。
- 首轮全量的唯一失败是新增 `ON CONFLICT(memory_id)` 未登记：已补 `dbSchemaContract` 的
  primary key 与引入版本，并同步 `tests/dbConflictKeyContract.test.js` 的期望计数（62→63 / 53→54）。
- 第二轮全量暴露出一个**与本次改动无关的 flaky 测试**：`shellSessionWindowsSecurity.test.js` 的
  “set /p EOF”用例把会话冷启动时间算进了 `set /p` 的 5s 预算，在 100 文件并行下偶发失败。
  已修为先热身一次再计时；真正的不阻塞信号（`timedOut === false`、下一命令可用）未减弱。

### 稳定/动态工具前缀分离

- `server/adapters/modelRequestCache.js` 的 `canonicalizeModelTools` 改为两层稳定排序：
  基础工具按名字排序，中途激活的工具（技能/MCP/search_tools）排在其后，而不是合并后重新全排序。
  这样一次追加只影响工具块尾部，不会重排已缓存的工具块前缀。
- `server/services/loop/runtime-runModelRequest.js` 在回合内首次解析工具集后捕获 `baseToolNames`，
  在请求前只对“非基础”工具加内部标记 `__gugoDynamicTool`（不改动 `s.activeToolSpecs`）。
- 标记在唯一的规范化点被剔除；OpenAI 与 Anthropic/Gemini 请求体都不含该字段。
- 回归 `tests/modelToolOrdering.test.js` 3/3（基础前缀稳定、追加不重排、重复/未命名不破坏确定性、两种请求体无标记泄漏）。

### 计划-证据绑定（核实与结论）

- **Job 路径已存在**：`job_steps` 携带 `acceptance`，`jobAcceptanceRuntime` 逐步评估 evidence 与宿主
  `taskVerification`，产出 `pass/fixable/blocked/needs_user`，`jobTaskAcceptance` 解析结构化结论。
- **聊天 `/goals` 仍只在客户端存 TODO**（`src/lib/slashGoals.js` → `SET_TODOS`），无服务端计划持久化与
  证据绑定。这属于新的服务端 + UI 能力，本轮不静默改造，已登记待立项。

### 统一 trace 的 span 层级导出

- 新增 `server/services/turnTraceSpans.js`：从持久事件的相关 id（`turnId`/`iteration`/`toolCallId`/`approvalId`）
  确定性地派生 OTel 形状的父子 span（16 字节 traceId、8 字节 spanId），不修改持久协议。
- `localTurnTraceService` 返回 `traceId` 与 `spans`；`gugo trace` 新增 `--export text|json|otel`（`--json` 等价 `json`）。
  `otel` 输出 `resourceSpans[].scopeSpans[].spans[]`（kind、纳秒时间戳、attributes、status）。
- 回归 `tests/turnTraceSpans.test.js` 4/4、`tests/cli/localTurnTrace.test.js` 3/3。

### 真实模型演示（Xiaomi MiMo，隔离环境）

- 端点 `https://api.xiaomimimo.com/v1`，模型 `mimo-v2.5-pro`。凭据只进入隔离 DB（加密）与临时 env 文件，
  已从磁盘删除；未进入命令参数、stdout、日志或提交。
- 隔离：`scripts/cli-demo/prepare-isolated-workspace.mjs` 生成独立 runtime（data/artifacts）与可丢弃工作区，
  验收脚本 `evals/verifiers/counter-repair.mjs` 在工作区之外。
- 预检：`doctor --headless` → 未验证即阻断；`--probe` 后 `probe.status=passed`、`mode=agent`、`ok=true`
  （reachable 162ms、completion 2.7s、tools 2.1s）。
- 任务：`gugo run ... --cwd <隔离工作区> --mode bypass --output jsonl --progress`。
  结果：退出码 0，`turn.completed`，195 个事件（27 个 model.phase、7 个工具调用、1 个 edit_file、
  1 个 run_project_check），stderr 进度显示 `1 files changed`。
- 独立验收：`evals/verifiers/counter-repair.mjs` PASS，夹具自带的 `node test.mjs` PASS，
  `src/counter.js` 确实被改为 `done === true`。
- `gugo trace <turnId>` 重建出 13 个 span（5 个模型迭代 + 7 个工具 + 根），全部 OK。
- **发现（已修）**：首次 `--probe` 在联网环境下报 `PROVIDER_TOOL_CALL_MISSING`，但同一端点直接调用
  `tools` + 强制 `tool_choice` 完全正常；重试后通过。说明单次工具探针会把“模型偶尔回文本”误判为
  chat_only。已为工具探针加**一次有界重试**（仅 `PROVIDER_TOOL_CALL_MISSING` 重试；参数/名字错误不重试），
  回归 `tests/modelProviderProbeRetry.test.js` 4/4。
- **发现（未改）**：该端点未在流式响应里返回 usage，且 `supportsStreamUsage` 只对已知家族开启，
  因此 trace 中 token 计数为 0；这是保守默认的代价，不是计算错误。

### 计划-证据绑定（服务端已实现，网页未接线）

- **Job 路径已有**：`job_steps` 携带 `acceptance`，`jobAcceptanceRuntime` 逐步评估 evidence 与宿主
  `taskVerification`，产出 `pass/fixable/blocked/needs_user`。
- **新增服务端目标计划**（迁移 v118）：
  - 表：`goal_plans` / `goal_plan_steps` / `goal_plan_events`（均带 user_id 归属与级联删除；
    `(plan_id, ordinal)` 唯一；`evidence_verified` 只能是 0/1）。
  - `goalPlanEvidence.js`（纯函数）：证据必须引用持久 Turn；带 `toolCallId` 时必须存在成功
    `tool.completed`；不带时必须成功 `turn.completed` **且**有成功工具调用或宿主验证通过；
    模型自述不是证据。
  - `goalPlanService.js`：计划状态机 `draft→awaiting_approval→approved→completed`
    （+`blocked`/`cancelled`/`superseded`）；步骤 `pending→in_progress→done|blocked|skipped`；
    `done` 必须通过证据校验，否则状态不变且返回 `GOAL_STEP_EVIDENCE_REQUIRED`；
    未批准不能改步骤；全部 `done` 自动 `completed`；每次状态变化写入 `goal_plan_events`。
  - **版本化重规划**：`rewriteGoalPlan` 创建 `revision+1`（`supersedes_plan_id` 指向旧计划）并把旧计划置为
    `superseded`，不改写旧步骤；两边都有 `plan.created`/`plan.superseded` 事件。
- CLI：`gugo goal create|list|show|approve|step|rewrite`（本地 DB，不启动 HTTP）。
- 回归：`tests/goalPlan.test.js` 3/3、`tests/cli/goalCommand.test.js` 2/2、
  `dbMigrationRegistry` 新增 v118 表/约束/级联断言。
- **网页已接线**（见下节）。

### agent 接入 + 鲁棒性（本轮新增）

- **loop 已接入**：会话存在未终结计划时，本轮额外挂载 `goal_plan_status` / `goal_step_update` /
  `goal_plan_rewrite` 三个工具（无计划的会话工具集不变），并把当前计划作为 system 块注入 prompt
  （在 memory 之后、plugin 之前，易变尾部，不动稳定前缀）。证据核验仍在宿主：工具带
  `turn_id`/`tool_call_id`，宿主回读持久 Turn 事件，对不上则调用失败且步骤不变。
  agent 不能自建计划（需人 `gugo goal create` + `approve`）；未批准时 prompt 明说不要开工。
- **乐观并发**：新增 `version` 列，每次写入自增；`approve`/`step`/`rewrite` 接受 `expectedVersion`，
  冲突返回 `GOAL_PLAN_VERSION_CONFLICT` 而非覆盖。`revision`（重规划代数）与 `version`（写入版本）分离。
- **证据不可重用**：迁移新增 `evidence_turn_id`/`evidence_tool_call_id` 列与部分唯一索引
  `(user_id, evidence_turn_id, evidence_tool_call_id) WHERE evidence_tool_call_id IS NOT NULL`，
  同一工具调用不能证明两个步骤（`GOAL_EVIDENCE_ALREADY_USED`）。
- **重规划信号**：步骤进入 `blocked` 写入 `plan.replan_required` 事件（带 stepId），不自动改写计划。
- **事件保留**：`gugo goal prune [--keep n]`，默认保留每计划最新 500 条；事件只增不删时必须显式裁剪。
- **批准归属**：新增 `approved_by`，只允许计划所有者批准；删掉不可达的 `draft` 状态。
- **真实模型回归基线**：`scripts/run-live-agent-evals.mjs` 新增数据集指纹（任务 + 验证器内容 +
  fixture 内容）、`--baseline` 漂移判定（regressions / fixes / metricDeltas，指纹不符则 `not_comparable`）、
  `--repeat 1-5`（每次均通过才算 pass，报告 passRate）。CI 不跑（无网络），作为手动回归门。
- **记忆索引回填**：`gugo memory reindex [--limit] [--batch]`；顺带修掉
  `listMemoriesNeedingEmbedding` 的 SQL `LIMIT` 先于 JS 陈旧度过滤的饥饿 bug（积压 > 一批时卡死）。
- 回归：`tests/goalPlan.test.js` 7/7、`tests/goalLoopIntegration.test.js` 5/5、`tests/cli/goalCommand.test.js` 2/2、
  `tests/memoryEmbeddingReindex.test.js` 4/4、`tests/memoryEmbeddingStore.test.js` 5/5、
  `tests/liveAgentEvalHarness.test.js` 9/9、`tests/promptPrefixFingerprint.test.js` 4/4、
  `tests/turnTraceSpans.test.js` 6/6，`loopDependencyBag` / `dbMigrationRegistry` / `dbConflictKeyContract` 全绿。

### 复审发现并修掉的 bug（本轮）

| bug | 影响 | 处理 |
|---|---|---|
| 日志 traceId 用随机 `newTraceId()`，span 导出用 `sha256(turnId)` | 同一 turn 两个 id，日志与 span 无法对齐，跨进程排查断掉 | `TurnEngine` 改用 `traceIdForTurn(turnId)`（可注入），并加源码级回归断言 |
| `pruneGoalPlanEvents` 无 `planId` 时是“整个用户保留 N 条” | 与文档“每计划 N 条”相反：一个活跃计划会把其他计划的历史全删掉 | 改为 `ROW_NUMBER() OVER (PARTITION BY plan_id)`，始终按计划裁剪 |
| `buildGoalPlanPromptBlock` 静默丢弃 `>32` 步，且把 `skipped` 计入未完成 | 模型看不到的步骤无法被标记完成；进度数字错误 | 写明截断条数；分辨 done/skipped；追加“下一步可执行步骤” |
| `listMemoriesNeedingEmbedding` 仍会在 `>maxScan` 条记忆时饥饿 | 与上轮修的是同一类问题，只是把阈值从 `limit` 提到了 4000，仍非零 | 改为 keyset 游标（`scanMemoriesNeedingEmbedding`），跨调用必进；reindex 循环透传游标 |
| `s.goalToolContext` 只写不读 | 死状态，注释却声称它保证工具与上下文一致 | 删除；改为在 `prepareTurnPromptContext` 输出可比较的前缀指纹作为真正的护栏 |
| 缺少稳定的本地缓存护栏 | 无法发现“某次改动把前缀缓存打碎” | 新增 `promptPrefixFingerprint`：稳定前缀指纹 + `comparePromptPrefixes`，并有测试钉住“注入计划不改动稳定前缀” |
| 截断事件日志的续跑无不变量 | 半截日志可能看起来像完成 | 新增边界扫描测试：每个事件前缀都不得被判为 `OK` |

### 本阶段实际执行的命令

| 命令 | 结果 |
|---|---|
| `npx eslint . --max-warnings 0` | 通过 |
| `npm run typecheck` | 通过，14 个反向 fixture 全拒 |
| `npm run debt:check` | 13/13 |
| `npm run audit:functions -- --check` | 0 复杂违规、0 解析错误 |
| `node scripts/run-tests.js`（本阶段相关 20 个文件） | 全部通过 |

未执行：真实模型演示、`npm run eval:live`、全量 `npm test`、打包与发布。
这些必须在显式授权与隔离环境就绪后单独进行；本阶段结果不构成真实任务成功率或发布通过的证明。

## 7. 下一步（未开始）

- 1.2 依赖袋契约：把正则扫描升级为语法分析，覆盖解构别名/默认值/字符串索引，未覆盖时 fail-fast。
- 2.2–2.5：模型/工作区选择核验、输出契约、审批与取消、恢复。
- 阶段 3：完成策略统一与 checkpoint 兼容。

### 网页端接线（本轮）

- **服务端**：`server/routes/goalRoutes.js`（`/api/goals/list|show|create|approve|step|rewrite|prune`），
  注册为 builtin capability `builtin.goals`。规则全部复用 `goalPlanService`，路由只做 HTTP；
  错误码 → HTTP 状态的映射集中在一处。
- **客户端**：`src/lib/goalPlanClient.js`；`SlashInlinePanelHost` 的 goals 面板改为读写服务端计划：
  展示状态/`revision`/每步状态与宿主核验标记，`awaiting_approval` 时提供“批准计划”
  （带 `expectedVersion`，冲突失败而不是覆盖），可创建目标、置 `in_progress`/`blocked`/`skipped`、重开已完成步骤。
- **面板故意不能把步骤置为 `done`**：完成必须由 agent 引用一次宿主可核验的工具调用。面板只说明这一点，
  并有测试断言 UI 发出的任何 `/api/goals/step` 请求都不得带 `status: 'done'`。
- 旧的客户端聊天 TODO 保留在面板底部（“更早的聊天目标”），不丢数据；`/goals <目标>` 仍走 Job 路径。
- 路由 bug（测试发现）：`boundedLimit(null, 200)` 因 `Number(null) === 0` 而把默认值变成 **1**，
  导致 `show` 只返回 1 条事件。已修并把默认值/显式值分开处理。
- 回归：`tests/goalRoutes.test.js` 5/5（鉴权、跨用户隔离、状态机/证据/版本冲突经 HTTP、
  rewrite、坏输入）；`tests/unit/SlashInlinePanelHost.test.jsx` 6/6（新增 4 个面板用例，删掉描述旧客户端勾选行为的 skip 用例）。

### 交互式会话（补齐 CLI 的形态缺口）

审计对照（pi-mono）：内核已追平（pi `packages/agent` 77 文件 / 21,160 行 vs Gugo `services/loop`
80 文件 / 18,654 行；测试密度 Gugo 更高 1.27 vs 0.84），差距集中在交互层。pi 有 4 种运行模式
（interactive / rpc / json-event / print），Gugo 此前只有后两种。

**已补 interactive**：`gugo chat`（别名 `gugo i`）
- 一个终端里多轮，同一个 `sessionId`，不必记 `--resume`；`/model` `/mode` `/cwd` 对后续轮生效。
- 实时工具进度走 stderr，最终回答走 stdout（可重定向）。
- Ctrl-C 取消当前轮而非退出会话；连按两次离开。
- 同一时刻只开一个 readline：运行期间关闭会话 readline，让审批/恢复提示独占 stdin。
- 非 TTY 拒绝启动（`CLI_INTERACTIVE_REQUIRES_TTY`）；带位置 prompt 或 `--resume` 明确报错。
- `/plan` `/approve` 复用服务端计划（同一份 `goalPlanService` 真相）。
- 回归：`tests/cli/interactiveSession.test.js` 10/10。写测试时抓到两个真 bug 并修掉：
  ① 每次提问新建 readline → **第二次提问永不返回**（第一个 interface 关闭后，新的收不到缓冲输入）；
  ② readline 会**丢掉**"没有待处理提问时到达的行"（快速粘贴/脚本预置行）。
  现改为常驻 interface + 行队列，`suspend()` 用 generation 守卫，避免关闭旧 interface 时清掉新 instance 的状态。

**仍未做（有意）**：JSON-RPC 传输层。库模式其实已有（`runHeadlessTurn` / `cmdRun` / `cmdChat`
都是可导入函数，不需要 HTTP），缺的只是 rpc 传输协议——按“先跑通 CLI”的路线排在最后。

顺带修掉审计提到的预算联动：`MAX_ITERS` 与 `maxModelCalls` 未经调优时都是 2000，
把 `GUGO_MAX_ITERS` 调大会让预算**静默变成真正的上限**（`execution_budget_exhausted`）。
现在 `resolveJobBudgetDefaults` 的 `maxModelCalls` 默认取 `max(2000, resolveMaxIters(env))`，
显式 `JOB_MAX_MODEL_CALLS` 仍然优先；已加测试。另外核实：预算耗尽本来就有稳定终止码与
可读终止态，不是缺陷；token 维度默认不设上限是早先有记录的决策，未改动。


### 第三轮：审计缺陷修复（第 1、2 批）

审计（外部复评）列出的缺陷按“CLI 基础可靠性 → 完成与控制正确性”顺序处理。

**第 1 批 · CLI 交互完整性**

| 缺陷 | 根因 | 修复 |
|---|---|---|
| `gugo chat` 没接审批/目录/副作用恢复回调，一旦需要审批就被运行时 fail-closed 默认拒绝 | `run` 与 `chat` 各维护一套不完整的执行包装；`createApprovalPrompt` 是 `yma-cli.js` 私有函数 | 新增 `bin/cli/runInteractionPorts.js` 统一工厂（`onApproval` + `onDirectoryRequest` + `onSideEffectRecovery`），`run` 与 `chat` 共用 |
| `/new` 在生产入口报 `unavailable` | `startInteractiveSession` 要求的 `newSessionId` 注入在生产没有提供 | 默认 `crypto.randomUUID`，一处解析 |
| `/exit` 后 readline 仍在读 stdin，进程要等 stdin 关闭才退出 | 退出路径没有释放 reader | `reader.close()` 放进 `finally`；并修正 `newSessionId` 传参（此前把参数 `null` 传了下去） |

回归：`tests/cli/runInteractionPorts.test.js` 4/4（审批 y/是/否/空/其它、abort 不提示、
恢复提示与审批共用同一终端）；`tests/cli/interactiveSession.test.js` 13/13（新增：chat 三个回调都必须在位、
`/new` 无需注入即可用、`/exit` 释放 stdin）。

**第 2 批 · 完成与控制正确性**

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 目标步骤可被无关工具记录（甚至**另一个会话**）标为完成 | 只校验“某工具成功过”，不校验是否满足该步骤的验收 | 引入**同会话绑定** + 类型化验收条件（`tool`/`command`/`file`/`artifact`/`verification`/`manual`）；引用 `--tool-call` 必须命中至少一条验收；`manual` 只能由人工确认满足 |
| 全部 `skipped` 时计划仍 `approved`，提示却说“没有剩余工作” | 完成判定只接受全部 `done` | 无 `pending`/`in_progress`/`blocked` 即完成，`skippedSteps` 记入 `plan.completed`；同时**带对象验收的必需步骤不允许 skip** |

写测试时抓到自己两个真 bug：
1. `normalizeSteps` 把对象型 acceptance **字符串化成 `[object Object]`**，类型化验收根本存不进库；
2. `normalizeStepAcceptance` 被调用两次（服务已归一化后 verifier 又归一化），第二次看到非数组就
   静默退回默认 `{kind:'tool'}` —— 即“看起来加了验收，实际没生效”。已改为幂等。

回归：`tests/goalPlan.test.js` 13/13（其中 6 个直接复现审计给出的场景：跨会话证据、
同会话错工具、错 cwd、命令失败、文件摘要不符、manual 不能被工具成功替代）。

**仍未做（第 3、4 批）**：向量记忆的三处正确性（双路召回、embedding 空间隔离、重建范围）、
不可恢复超窗的重复请求、缓存观测闭环、长任务压缩恢复与故障注入。

### 第四轮：第 3 批（记忆与上下文正确性）

审计的三处记忆缺陷 + 一处上下文缺陷，全部复现并修复。

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 开启向量检索会**丢掉本来能精确召回的旧记忆** | 有查询向量时不再使用词法条件，只取"最近/置顶 240 条"再在其中混合排序——是"最近 240 条内的混合排序"，不是双路召回 | 改为**两条独立召回路径再合并**：①词法路径由 DB 判定（`LEXICAL_CANDIDATE_LIMIT=240`，精确命中不再受新旧影响）②语义路径是有界近期池（`SEMANTIC_CANDIDATE_LIMIT=400`，因为向量是 BLOB、余弦在 JS 算）。合并去重后再排序 |
| 换同维度 embedding 模型后仍用旧向量 | 只校验内容指纹与维度，不校验向量空间 | 迁移 **v119** 新增 `embedding_space`；空间身份 = 端点(host+port+path) + 模型 + 定义版本；只比较**同一空间**的向量，空间未知/不匹配一律忽略并保留词法回退；不匹配的向量进入重建队列 |
| `memory reindex` 漏掉 agent 专属记忆却报完成 | CLI 只传 userId，索引查询在无 agentId 时只选 `agent_id IS NULL` | 作用域改为显式：`--agent <id>` / `--all-agents`（互斥），默认仍是全局；报告带 `scope`、`space`、`remaining`（有界探测） |
| 不可压缩超窗会**重复发送相同失败请求** | 3 次尝试在压缩无进展时发送相同请求 | 相同请求（messages+tools 指纹一致）**跳过而不重发**，但仍允许后续更激进的压缩尝试；最终错误带 `noProgress` 与跳过次数，并说明"固定指令+工具定义约 N token 已超窗"这一通常的真实原因 |

写测试/跑冒烟时又抓到**我自己**两个错：
1. `agentId: agentId || ALL_AGENTS` 让**默认作用域变成全 agent**，而报告仍写 `scope.kind:'global'` —— 正是审计抱怨的谎报；已区分"未指定"与"全部"。
2. 我一度把"固定内容超窗"做成**提前硬失败**，结果打挂了 21 个 PPT/产物 e2e（它们的 8192 是本地保守猜测，不是 provider 真实上限，代码注释本就明确禁止据此拒绝请求）。改为符合既有策略：不提前拒绝，靠 no-progress 抑制重复 + 把固定部分写进诊断。

回归：`tests/memoryEmbeddingStore.test.js` 10/10、`tests/memoryEmbeddingReindex.test.js` 5/5、
`tests/smallContextWindow.test.js` 10/10、`tests/contextCompactionRuntime.test.js` 15/15、
`tests/toolLoopExecutionRegression.test.js` 100/100。

**仍未做（第 4 批）**：缓存观测闭环（前缀指纹接运行时 + 原生 Anthropic `cache_control`）、
长任务/小窗口/压缩恢复的 CLI 专项测试、计划审批与工具审批的控制链对齐、故障注入。