# 执行过程视觉对齐与五维差距增量核实（2026-09-14）

## 范围与证据等级

本报告增补 `REFERENCE_GAP_ANALYSIS_2026-09-13.md`，不改写历史结论及其修复记录。
Gugo HEAD 为 `23c1dec`；开始时已有内核、旧报告和依赖袋测试的未提交改动，均保留。
参考源码 HEAD：Pi `cd6852a12`、Codex `d446960657`、DeepSeek Harness `c291e7961a`。
参考目录仅只读查看；未启动参考产品、未连接真实模型、未修改模型配置或 retry/checkpoint 内核。

证据分为：源码调用链、纯函数复现、Gugo 隔离浏览器组件实测、离线回归。
不据此宣称真实模型成功率或参考产品整体视觉优劣。

## 一、本轮视觉实现

- V1：基础步骤去卡片阴影/圆角，纵向 padding 改为 0.22rem、列宽 1.15rem、间距 0.4rem；基础序号为 1rem 无描边，保留三类终态配色；收紧列表填充并同步竖线与窄屏偏移。
- 真实聊天使用更高优先级的 `.chat-run-timeline` 规则：原本已去阴影、隐藏视觉序号、改用状态图标与组左短线。本轮恢复 grid 及 16px 可见序号（保留无障碍名称），保留状态图标与组左短线；实际生效的 header 最小高度从 1.6rem 降为 1.25rem，缩小间距。不是仅修改被覆盖的基础 CSS。
- V2：标签常规字重，摘要继续弱化并保留技术路径等宽字体，移除摘要前的 `·`；修正窄屏遗留的摘要左缩进。未修改 `ToolCallCard.jsx` DOM、`toolCallPresentation.js` 文案生成或状态机。
- 减动效：补齐运行图标与详情按钮/箭头的减动效处理，仍显示静态状态。
- V3：折叠且非运行时追加 `execution-result-summary` 兄弟 span，不更改 `task-duration-header` 内容。显示成功写入/修改的去重文件数，并可同时显示失败工具数；纯阅读不显示空摘要。
- 摘要支持 `write_file`、`edit_file`、`multi_edit`、`apply_patch`、`patch_file` 的明确目标。优先采用结果中的 `path/files/changes`，兼容 JSON 和 `content` 包装；历史单文件成功调用可回退参数目标。排除运行、取消、失败、dry-run，不从 Shell 文本或拟议 patch 推测修改。Windows 绝对路径复用既有大小写/分隔符归一化，POSIX 保留大小写。
- “已改文件”表示成功工具报告的修改目标，不是“验证通过/最终交付”承诺；不创建下载链接、不改变产物验证边界。相对路径缺少工作目录时无法与绝对路径合并，同名不同目录也不擅自合并。
- 新增 zh/en 对称翻译及正常、错误、重复、旧快照、dry-run、折叠生命周期回归测试。

### 浏览器视觉检查

使用真实 React 组件及项目 CSS 的隔离 Vite 页面，无后端 bootstrap、无用户数据库或模型请求。
Playwright 检查 1280×800、375×812，以及 `prefers-reduced-motion: reduce`。
375px 下 `documentElement.scrollWidth === 375`，工具 header 实测约 23.8px；长路径省略、运行/失败状态仍可见。
最终覆写复查确认真实时间轴序号为 16×16px；另测 320px 下无横向溢出。最终 CSS 后五个 UI 文件及 lint/build 再次通过。
减动效模式下运行状态图标计算样式 `animation-name: none`。
截图和隔离夹具在被忽略的 `output/playwright/`：`execution-desktop.png`、`execution-mobile.png`、`execution-mobile-reduced.png`。
页面仅有独立夹具未提供 favicon 的 404，无组件运行异常。

## 二、UI 增量差距

| 待核实项 | 参考证据 | Gugo 证据与结论 |
|---|---|---|
| 每步耗时 | Codex `tui/src/exec_cell/model.rs:157` 保存命令 duration，`render.rs:225` 在 transcript 输出退出状态与耗时。DSH 通用 `ToolRow.tsx` 无 duration 属性，不能宣称它所有工具都显示耗时 | `ToolCallCard.jsx:128` 仅运行时挂载 LiveElapsed；`turnEventDispatch.js:277` 保存 startedAt，但 completed 分支未统一保存结束时间/耗时。**运行中已有，完成后的通用步骤耗时是实际展示/投影差距**，不应新建整套计时链路 |
| 分组折叠 | Codex `exec_cell/model.rs:108` 按探索/命令状态合组；DSH `ToolCallTree.tsx:31` 递归子调用，`ToolRow.tsx:159` 控制单步 disclosure | `ExecutionTimeline.jsx` 全过程折叠；`ActivityTraces.jsx:38` 组内最近四项+所有活动项，支持展开历史；每步参数/结果可展开。**不是缺少折叠机制**。语义探索组、子调用树属于额外组织方式，不能直接判 bug |
| reasoning / 最终答案层级 | Codex `history_cell/messages.rs:297` 有独立 ReasoningSummaryCell 和 transcript-only 模式；DSH `ui-chat/.../ReasoningRow.tsx:33` 独立 Think disclosure | `ActivityTraces.jsx:11` ReasoningTrace 仅呈现思考状态及安全活动详情；ExecutionDisclosure 与 `.chat-assistant-answer` 分离，已有隐藏私有推理测试。**视觉分层已实现**；不展开私有推理是有意行为，不列为缺陷 |

后续低风险候选：在用户展开过程时显示已完成步骤的确定耗时；先定义事件时间与执行耗时口径、旧快照缺值处理，再补投影/恢复/窄屏测试。它不属于本次 V1–V3。

## 三、Pi 极简内核：有契约，缺的是内部覆盖

Pi `packages/agent/src/agent-loop.ts:27` 定义 `AgentEventSink`，`agentLoop` 返回 `EventStream<AgentEvent, AgentMessage[]>`；`packages/ai/src/utils/event-stream.ts` 提供 AsyncIterable、终止及 result promise。它是注入 streamFn、工具执行和事件 sink 的循环，并非没有 I/O 的数学纯函数。

Gugo **不是没有统一事件类型**：

- `shared/turnEvents.js:25` 的事件名清单、`:140` 起的逐事件 payload schema、`:541` 的 createTurnEvent 是运行时单一来源。
- `types/turn-protocol.ts:17` 从 Zod 推导类型，CreateTurnEventInput 保持 type/payload 对应；`tsconfig.protocol-pilot.json` 对协议核心启用 checkJs/strict。
- `turnLoopExecutionRuntime.js:160` 将循环回调映射到统一 Turn 事件；`turnEventEmitter.js:341` 在写入前创建/校验事件，带 scope、sequence、createdAt 和持久化边界。

真实增量债务：循环阶段函数、`createTurnLoopEventCallbacks` 和 emitter 调用点没有纳入该 strict JS pilot，内核回调接口不具备 Pi 那样端到端的静态联合类型约束。`model.phase.phase` 仍为字符串，retry 决策也未提供统一的 policy id/limit/attempt 事件事实。编译期覆盖和诊断一致性不足，不等于事件丢失或无运行时校验。

建议复用既有 schema 派生 callback/sink 类型，逐步扩展检查范围；不另建一套并行 EventStream 总线，也不以文件行数作为重写阶段机的理由。归入既有类型治理方向，不重复开旧文已登记的类型债务。

## 四、本地端点能力与诊断

### 已有能力矩阵（服务端无显式覆盖时）

| 端点 | 默认端口/识别 | 工具 | 流式 | 视觉/PDF/并行工具 | 本地默认故障转移 |
|---|---|---|---|---|---|
| Ollama | 11434/主机或 API 路径 | 开 | 开 | 关/关/关 | 关 |
| LM Studio | 1234/主机名 | 开 | 开 | 关/关/关 | 关 |
| llama.cpp | 8080/主机名 | 关 | 开 | 关/关/关 | 关 |

依据 `server/utils/endpointProfile.js:24,159,187`。显式 kind/能力、模型级画像与白名单可覆盖；自定义端口需明确 kind，地址本地性与 kind 是独立判定。私网/本机不自动切云端；显式网络部署也不因此获得匿名工具权限。

非 Ollama 端点不是“未支持”：共享兼容请求、无密钥配置、`/v1` 补全、system 合并及非标准流帧均已有测试（`endpointProfile.test.js`、`modelProxy.test.js`、`modelProxyTimeout.test.js`、`modelResponseStreamCompat.test.js`）。

### 增量发现 A：llama.cpp 预设覆盖保守默认（实现不一致）

可复现调用链：

1. `src/components/modelProviders/providerConfig.js:7,13` 的 llama.cpp 预设复用 `CAPS.local.supportsTools='1'`。
2. `ProviderEditor.jsx:75,103` 写入编辑状态；`ModelProvidersPanel.jsx:90` 将其转换为 true 并保存。
3. `resolveEndpointProfile` 的 explicit override 优先于 kind 默认，最终 supportsTools=true。

离线纯函数复现结果：`{ bare: false, fromPreset: true }`。触发条件是用户选择并保存此预设且未手动调整，不是所有 llama.cpp 连接都受影响。
之后真实工具探针仍可识别不支持工具、登记 chat_only（`modelProviderRoutes.js:320–399`）；因此不能宣称绕过所有 readiness 检查。问题是预设默认与服务端策略漂移，可能向未配置 chat template 的服务发送不支持的探针或请求。
建议独立小修：预设能力使用 auto/服务端默认，不将预设选择等同于用户明确启用工具；补“选择预设→保存→profile→探针”行为测试。本轮不修。

### 增量发现 B：有效上下文发现与能力探测仍不完整

- `modelProviderRoutes.js:272` 对 Ollama 使用专用发现，其余使用 `/models` + 普通补全 + function-call 探针。
- `modelEndpoint.js:98` 和 `modelCatalog.js:9` 已解析通用模型画像并供发现接口返回，所以“除 Ollama 外无上下文画像”不成立。
- 未找到 llama.cpp `/props`/`n_ctx` 有效运行窗口、LM Studio 专用 loaded-instance context API 的专用适配；通用目录里的 `max_context_length` 等上限未区分训练/服务实际窗口。若目录上限高于运行配置，可能高估有效上下文；需按端点版本 fixture 或真实显式测试验证，不能当作已发生的溢出事故。
- generic diagnostics 的工具探针不验证流式、视觉、PDF 或并行工具；这些仍是 profile 声明，不能把 `agentReady` 宣称为完整能力矩阵实测。

建议按服务端实际窗口来源建模、保留保守 fallback，并区分“声明/估算/探测通过”；不在本轮引入新网络探测或改预算。

### 增量发现 C：诊断可操作性与语言覆盖不足

共享错误已有拒连、认证、404、超时、上下文超限分类（`modelProxyErrors.js`）。但本地工具失败主要提示“更换支持 function calling 的模型”，没有按 llama.cpp chat template/工具配置、LM Studio 模型加载和有效窗口给出针对性排查。
`modelProviderRoutes.js:276–356` 的步骤 label/hint 是中文，`ModelProvidersPanel.jsx:176` 原样存入 diagnostics，`ProviderDiagnostics.jsx:15–16` 直接渲染；en 页面也会出现这些中文步骤。顶层错误有翻译不代表逐步诊断已完整本地化。
建议后续使用诊断代码+zh/en 展示映射，并将配置声明与实测结果明确区分。本轮只记录。

## 五、Harness：九个持久化字段，八个仍有控制逻辑

`runtime-initializeExecution.js:295–343` 将下表写入 completionGuards；恢复散落在 initializeCompletion/initializeConversation；阈值分别位于 `heuristics/constants.js` 和 `runtime.js:106–110`。

| 字段 | 当前阈值 | 主要消费/重置位置 |
|---|---:|---|
| artifactDeliveryRetries | 4 | processModelResult、completeIteration、prepareIteration；成果写入/steering 后重置 |
| executionEvidenceRetries | 1 | processModelResult 执行证据补救 |
| directoryResumeRetries | 2 | processModelResult 目录授权恢复 |
| mutationVerificationRetries | 2 | processModelResult 校验补救；outcome recorder 验证成功后重置 |
| pdfLayoutVerificationRetries | 2 | processModelResult PDF 布局补救；outcome recorder 重置 |
| deliverableSelectionRetries | 2 | processModelResult / executeToolCalls / completeIteration，canonical broker 同步 |
| sourceHandoffRetries | 1 | processModelResult 源文件交付补救 |
| localHtmlDeliveryRetries | 4 | initializeTerminalCompletion handler、完成/失败路径重置，canonical broker 保存/恢复 |
| executionReasoningRetries | 无活动阈值 | 仅发现 initializeCompletion 恢复及 initializeExecution 序列化；当前树无递增或阈值消费 |

因此不能描述为“九个计数器都各自判阈值”。实际为八个活动策略+一个兼容持久化字段，统一策略对象仍缺失。
差异不仅是数值：有先加再比较、有先比较再加、不同成功重置条件，以及 broker 保存/恢复口径。直接统一自增时机会改变允许尝试次数。

独立立项建议：

1. 先给八个活动策略补边界快照测试：阈值前/等于阈值/恢复后/已确认副作用/取消或拒绝。
2. 设计稳定 policy id、limit、attempt、reset condition 与结构化诊断，不改授权和未知结果处理。
3. 制定 completionGuards 旧字段读写兼容；`turnCheckpointStore.js:4,65` 外层 checkpointVersion 目前为 1，不能只换内存字段不管已持久化数据。
4. canonical harness broker 与共享循环均验证后再切换；旧兼容字段的退出需单独决定。

审批闭环、依赖袋形态、harness 双路径本轮均不重审/不改动。插件化维度沿用旧结论，按要求不重复。

## 六、验证记录

- V1/V2：四个 MessageRowActivity 文件及 artifactReferenceLinks 共五个 UI 文件通过；全仓 lint 通过。
- V3：上述 UI 回归、`executionResultSummary.test.js`、`codeDebt.test.js` 共七文件通过；新增六项行为/纯函数测试。
- `npm run i18n:check`：23 项通过；全仓 lint 再次通过。
- 隔离浏览器：桌面/窄屏/减动效通过，结果见第一节。
- `npm run build`：通过。
- `npm run typecheck`：通过，14 个无效协议调用 fixture 均按预期被拒绝。
- `npm run audit:functions -- --check`：通过，复杂度违规和解析错误均为 0。
- 首轮全量发现 `uiVisual.test.js` 的旧样式契约要求步骤具备卡片圆角及阴影，与 V1 明确冲突。保留测试并改为断言无圆角/阴影、紧凑间距、16px 序号及实际 grid；该文件定向复测 15/15 通过，不恢复旧卡片设计来迁就断言。
- 全量 `npm test`：完整执行 900 个文件（801 个普通测试文件 + 99 个隔离 JSX/UI 文件）。TAP 日志汇总 7,913 项：7,902 通过、10 跳过、1 失败；唯一失败就是上条旧视觉契约。其余批次及全部隔离 UI 文件通过。
- 更新旧视觉断言后，`uiVisual.test.js` 单文件完整复测 15/15 通过，修改后的测试文件 ESLint 通过。没有再次从头运行第二轮全量；因此保留首次全量 FAIL 的真实记录，不将其改写为一次性全绿。日志：`output/playwright/full-test.log`、`visual-contract-test.log`、`final-ui-test.log`。
- 未执行真实模型 benchmark、参考产品运行对比、提交/推送/发布。
