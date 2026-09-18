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
- ~~既有无关失败~~ **更正（2026-09-14）**：本节此前记录的失败被误判为「与本轮改动无关」，实际根因是快照 `a16a2aa` 固化了一次错误的 `runtimeDependencies` 精简——依赖袋从 231 个符号被删到 53 个，而扫描漏掉了各 phase 文件的 `const { X } = s.d` 解构消费（`server/services/loop/` 下 19 个文件、61 处），导致 185 个在用符号缺失。已按 `ad6119b` 的健康依赖袋恢复并叠加后续新增符号（现 241 个，缺失审计 0）。原记录的三类现象随之全部消失：
  - `tests/turnEngine.test.js`、`tests/subagentRuntime.test.js` 合计 121 项全部通过（`Loop runtime contract violation` 不是测试 mock 漂移，是生产依赖袋真实缺键）；
  - 全仓 `npm run lint` 恢复零问题（此前的大量 no-unused-vars 正是符号已 import 但未进依赖袋的连带结果）；
  - 全量 `npm test` 通过，`npm run debt:check`、`npm run audit:functions -- --check` 均绿。
  教训：依赖袋的使用面必须同时统计属性访问与解构两种形态，任何「未使用符号」结论在删除前需以缺失审计脚本反向验证。
- 不在无真实模型环境的情况下宣称任务成功率变化；GAP-2 对本地模型完成率的实际收益须走 `docs/LIVE_AGENT_EVALS.md` 的显式入口实测。

## 四、遗留（记录，不在本轮）

- DEBT-TYPE-001 / DEBT-RELEASE-001 / DEBT-RELEASE-002 / DEBT-NET-002：维持既有登记，本轮不重复开单。
- 工具管线 waterfall 化、插件 patch 组合、UI 对齐：见上文"有意不采纳"，需要单独立项与取舍评审。
- WorkBuddy：`D:\workbuddy` 仅为插件配置痕迹，无可借鉴源码；维持"仅参考技能使用方式"的既有边界。

## 五、2026-09-18 外部审查复核与修复

> 历史记录更正（同日后续复核）：下述 R1 将旧 beta 要求误当成当前协议，**“缺 beta 头必被拒绝”不成立**。Anthropic 在 2025-08-13 已宣布 1h TTL 无需 beta 头；现行行为与来源见第六节。R2 的成功保留方向继续沿用，后续补齐矛盾/缺失终态及异常路径。本节保留当时判断与测试记录，不代表当前验收结论。

对另一位审查者提出的三项不足逐项沿真实调用链独立复核，三项代码事实全部属实；其中一项的行为定性需要更正后才能修。

### R1（属实，已修）：`MODEL_PROMPT_CACHE_RETENTION=long` 缺少上游必需的 beta 头

- 复核：全仓无 `anthropic-beta` 头；`modelRequestCache.js` 的 long 档发送 `cache_control:{type:'ephemeral',ttl:'1h'}`；`nativeModelProviderRequests.js` 的 `buildAnthropicRequest` 只发 `anthropic-version`。Anthropic 官方文档明确 1h 缓存条目必需 `anthropic-beta: extended-cache-ttl-2025-04-11`，缺头时请求会被上游拒绝——本地序列化测试发现不了。
- 修复：`modelRequestCache.js` 新增 `ANTHROPIC_CACHE_TTL_BETA_HEADERS`（按 ttl 查表，与 retention 档位解耦）；`buildAnthropicRequest` 在 ttl 需要时注入 beta 头，并与调用方自定义 `anthropic-beta` 值合并去重（Anthropic 接受逗号列表），不覆盖用户配置。默认/short 档行为零变化。
- 测试升级：原 4 处 `ttl:'1h'` 形状断言保留（形状本身没错），新增协议断言——long 必须带 beta 头、short/默认必须不带、与自定义头合并且去重。这回应了"测试冻结错误 wire 形状"的批评：现在形状与上游协议绑定断言。

### R2（属实，行为定性更正后已修）：deadline 替换成功终态

- 复核更正：审查者称该决策表"无人守"——`timeoutReplacesResult` 函数名确实零测试引用，但**行为有测试守护**：`tests/cli/interactiveTurnTimeout.test.js` 原用例 `a success returned after the chat deadline cannot publish completed text` 明确断言 deadline 后的成功文本不得发布。即"成功被替换"是写进测试的刻意防御（不信任 deadline 后返回的 completed），不是无意缺陷。修复因此属于终态语义变更，不是纯 bug fix。
- 决策：采纳"成功优先"。理由：runtime 状态机已发出 `turn.completed` 且被 CLI `onEvent` 观察到，双重一致的终态证据比本地墙钟更具体；旧行为造成跨层矛盾（CLI 报超时 exit 124、text 模式丢失已完成文本，DB 已持久化 completed），违背"终态可解释、保留已确认进展"。deadline 只解释"无其他终态证据的协作取消"。
- 修复：`runDeadline.js` 成功分支返回 false（含完整决策表注释）；`yma-cli.js` 提示文案改为 `preserving the runtime outcome`；`interactiveTurn.js` 在 deadline 触发但结果保留时向 stderr 提示 `deadline elapsed; preserving the turn outcome`。
- 测试：新增 `tests/cli/runDeadlineDecisionTable.test.js` 直接守护五类决策（成功保留、显式不完整保留、纯取消替换、取消但有 completed 终态保留、failed/blocked/interrupted/unknown 保留）；原 `cannot publish completed text` 用例改写为 `is preserved and announced`。headless `runTimeoutBoundary.test.js` 的 5 个既有用例逐个核对新语义全部兼容（矛盾状态场景的 exit 1 来自 `resolveExitCode` 对矛盾成功的拒绝，与替换逻辑无关），未修改即通过。

### R3（属实，已修）：`runtime.js` 文件尾空行

- `git diff --check` 报 `new blank line at EOF`，文件确以空行结尾。已清除。

### 本轮验证

- `tests/cli/runDeadlineDecisionTable.test.js`（新）、`tests/cli/interactiveTurnTimeout.test.js`、`tests/cli/runTimeoutBoundary.test.js`、`tests/cli/cliContracts.test.js`、`tests/nativePromptCachePolicy.test.js`、`tests/promptCacheStability.test.js` 合计 55 项全部通过。
- 改动文件 `npx eslint` 零问题。
- 边界说明：R1 的 beta 头修复只保证请求形状符合 Anthropic 官方文档；真实 Anthropic 端到端缓存命中仍需显式 live eval 验证，本地 LM Studio（OpenAI 兼容）路径不受此头影响。

## 六、2026-09-18 后续复核：现行协议更正与终态证据闭环

本节在 `849b801` 及当时所有既有未提交修改之上增量修复，不撤销其他人的提交，不把此前验证记录改写成新结果。

### R1 更正：1h TTL 已正式可用，旧 beta 仅作为显式兼容选项

直接读取官方发布记录：[2025-08-13 API release notes](https://platform.claude.com/docs/en/release-notes/api#august-13-2025) 原文为 “The 1-hour cache duration for prompt caching no longer requires a beta header.” 当前 [1-hour cache duration](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration) 说明使用 `cache_control: {type: 'ephemeral', ttl: '1h'}`。因此第五节“当前缺头一定拒绝”的归因与“long 必须 beta”的测试预期过期；这不是收费模型请求验证所得的结论。

现行实现：

- `MODEL_PROMPT_CACHE_RETENTION` 仍是显式选择：默认/none 不添加断点，short 为默认 ephemeral TTL，long 为 1h。没有擅自开启、降级或替换模型端点。
- 正式 API 默认不自动加旧 beta；调用方显式配置的 beta 仍保留。确需旧行为的网关可在命名 `MODEL_PROVIDER_<KEY>_PROFILE` 配置 `{"kind":"anthropic","requiresPromptCacheTtlBeta":true}`，并与已有 profile 字段合并。
- 新能力经实际 `resolveModelConfigForModel → profileForConfig → resolveEndpointProfile` 链路生效；DB `modelProfiles` JSON 的白名单和往返保存保留 true/false，不需要 schema 迁移。精确模型的配置优先于 Provider 配置，默认 false，字符串/数字不隐式启用；非 Anthropic 协议不启用此能力。
- 仅实际请求已有 1h 缓存断点时注入 legacy beta；不同大小写的 `anthropic-beta` 字段合并，逗号值去重，保留调用方其他字段，不修改源配置。
- 不只检查 builder 字面对象：`nativePromptCacheTransport.test.js` 用注入式 fetch 覆盖配置到出站流式/非流式请求、调用者头合并、per-model false、无缓存块以及其他协议的反例。固定响应仅验证协议适配，不模拟并宣称真实 KV 命中。

### R2 补齐：成功优先必须以一致的最终证据为前提

继续保留 `849b801` 对“一致的完成事件 + 成功返回值”的修复。后续真实 CLI 入口探针另外复现：到期后的裸 success 无终态却退出 0、观察到 failed 却被返回的 completed 覆盖、completed 后返回 cancelled、具体失败后抛出本地 deadline 被 124 覆盖。仅更改 `timeoutReplacesResult` 的 true/false 无法闭合这些跨层情况。

- `run` 与 `chat` 共用 deadline 结果归并，具体规则见 [CLI：deadline 与结果证据](CLI.md#deadline-与结果证据)。保留一致且完整的完成正文与退出 0；stderr 只提示 deadline 已过。
- 已过 deadline 的裸成功无 completed 证据报 `CLI_RUN_TERMINAL_MISSING`；最终证据矛盾报 `CLI_RUN_OUTCOME_CONFLICT`，不静默宣称“已保留成功”。completed 后又抛出 deadline 也属于矛盾，不虚构成功结果。
- 普通协作取消才归因本地 deadline。明确失败、未知请求/副作用、不可安全重放、blocked 等保留具体诊断；持久化失败、聚合异常和非精确取消异常不被错误吞掉。中途 waiting/awaiting_approval 不能把普通超时伪装成已有最终结果。
- 恢复只返回持久化 `lastEvent` 而没有回调时，formatter 输出实际返回的终态一次；不因“没回调”丢正文，也不从 bare status 伪造终态。
- 同一 attempt 的冲突通过有界终态观察器保留，不会被“只看最后一个回调”绕过；显式 `turn.attempt/resetStreaming` 正常重置。返回结果与 completed 两边已提供的会话/Turn 身份必须一致，chat 不在拒绝前采纳错误会话 ID。
- 最终独立探针又复现一个遗漏：`completed → waiting → finish(completed)` 仍可能退出 0 却丢正文，`failed → waiting → finish(failed)` 则将具体错误替换成 Waiting。已让文本缓冲和观察器使用同一有效终态；补 27 个 text/chat/JSONL 与新 attempt 重置用例，先红后绿。原始 JSONL 事件保留，不篡改诊断流。
- 新增回归通过真实 `cmdRun`/chat 与 formatter 检查 text/jsonl、stdout/stderr、退出码及状态一致性；旧的刻意晚成功防御测试历史仍保留在第五节说明中。

### 本次验证记录与边界

- 缓存配置/协议定向：6 个文件、108 项通过（`nativePromptCachePolicy`、`nativePromptCacheTransport`、`nativeModelProviders`、`promptCacheStability`、`endpointProfile`、`modelProviderModelProfiles`）。其中 transport 22 项覆盖流式/非流式真实适配调用链（含仅 system / 仅 tools 可缓存），网络依赖完全注入。
- 复现失败日志与后续通过日志分别保留；不把预修复红灯删成只有成功记录。最终验收结果如下。
- 第一轮全量在独立探针发现上述投影遗漏后主动中止，日志保留为未完成，未计入通过；仅停止本助手本次测试进程树，复查全部退出，既有 Pi 进程未被干预。修复重新冻结后启动第二轮全量。
- 本轮没有调用真实 Anthropic 或其它收费模型，也没有生成替代 R2 的新发布包；源代码回归不能代替真实端点缓存命中或跨厂商任务成功率基线。
- 跨 Turn 前缀历史、Node20 原生 SQLite、ANN/大库压力测试、Windows 原生安装器及实体键盘/完整终端矩阵仍按既有边界登记；本轮不宣称这些能力已实现或已实测。前缀指纹不是实际缓存命中指标。
- 另行发现的旧能力配置缺口：`promptCacheKeyFor` 读取 `profile.supportsPromptCacheKey`，但常规 endpoint/profile 存储链未透传它，现有开关测试直接注入 profile。官方 OpenAI 端点的默认键生成路径不受此影响；本轮不顺带启用兼容端点的此项能力，后续应单独补配置链与请求验证。

#### 冻结后最终验收（2026-09-18，Node.js v22.20.0 / Windows）

| 验证入口 | 本次实际结果 |
|---|---|
| `npm test` | **PASS，996 个文件**：897 个常规文件 + 99 个 Windows 隔离文件；日志各 TAP 进程汇总 8866 项，8857 pass / 9 skip / 0 fail / 0 cancelled |
| `npm run lint` | 0 error / 0 warning |
| `npm run typecheck` | 通过，14 个非法调用 fixture 全部被正确拒绝 |
| `npm run audit:functions -- --check` | 0 复杂度违规 / 0 parse errors；未调整门槛或添加豁免 |
| `npm run deps:check`、`npm run debt:check` | 通过；debt 13/13 |
| `npm run eval:offline` | 61/61，显式离线网络护栏与隔离数据目录 |
| `npm run licenses` | 当前安装的 402 个生产包通过 |
| 差异与快照 | 本轮改动差异检查通过（按 CRLF 行尾正确判定空白）；17 个本轮源码/测试文件的 SHA256 与启动最终全量前一致；HEAD 仍为 `849b801` |

9 次 skip 保留而非算作通过：LibreOffice 未安装、Node20 专属用例在当前 Node22 跳过、当前文件系统不区分大小写、4 个 POSIX 专属分支，以及已有反馈表单跳过（由两个入口报告）。未为本次修复删断言或新增 skip。前端隔离用例通过不是实体浏览器/键盘验收，也不等于新安装器或发布包验收。

原始记录保留于本机临时目录 `gugo-provider-deadline-review-5f1654dee21a464f86b758b4c81038fb`：最终全量 `full-test-final.log`、主动中止记录 `full-test-interrupted.md`、缓存与 capability 红/绿日志、`deadline/` 下身份及投影红/绿日志、各项门禁日志。未自动提交、推送或发布；旧 R2 包不包含本节源码增量。

## 七、用户授权后的 Git 整合范围（2026-09-18）

上述工作完成后，用户明确要求提交和推送。交付整合当前已验收的 369 项累计改动（177 项已跟踪变更、192 个新文件），不是仅提交最近的缓存/deadline 文件：CLI、DB migration、工具 schema、测试入口与网页诊断直接依赖尚未跟踪的新模块，必须保持依赖闭合。

保留接手前既有的 CSS V1–V3 紧凑样式及对应测试，不将其称为本轮新增外观工作；同时保留本轮功能配套的证据摘要、可访问性与诊断样式。`used-symbols.txt` 的既有删除仅清理无生产引用、混有 Node warning 的生成符号清单，可从父提交恢复。没有回滚或覆盖其他 agent 的修改。

提交前只读扫描覆盖当前候选及 3 个尚未推送的祖先提交（`a16a2aa`、`23c1dec`、`849b801`），未发现真实凭据、数据库、用户附件、日志或发布包。模式命中经复核为合成脱敏测试数据或 lockfile 元数据。本机无 gitleaks，不能将此扫描称为正式 gitleaks 全历史验收，也不调整现有豁免。推送限于现有功能分支；不强推、不合并 main、不打 tag 或发布版本。

本次 Git 收尾另完成隔离 Vite 生产构建（禁用 dotenv/envDir，产物只写临时目录，未初始化数据库），16.29 秒通过，不覆盖旧 R2 或本地 dist。将新文件实际纳入 index 后，差异门禁发现 `interactiveHistory.js`、`runDiagnostics.js`、`artifactRevisionMode.js` 各一行多余 EOF 空行；仅删除这 3 个空行，无逻辑变化，4 个关联文件 70/70 回归与定向 lint 通过。前述 996 文件全量记录属于此 EOF 清理之前的冻结快照，不把两次验证时间点混为一次。
