# Gugo 差距补齐 Roadmap（2026-10-09）

> 依据 2026-10-09 的四维代码级深挖（循环推理 / 工具深度 / 记忆评测验证 / 安全编排）叠加项目自审
> （`REFERENCE_GAP_ANALYSIS_2026-09-13`、`GENERAL_AGENT_AUDIT_2026-09-07`、`AGENT_QUALITY_ASSESSMENT_2026-09-15`）。
> 目标：把与 **Claude Code / Pi / DeepSeek-Harness** 的差距按性价比逐项收敛，**每项都能被评测证明**。
> 本文是工作清单，不改动任何生产代码；`[ ]` 为待办，勾选即为该项落地。

## 执行原则

1. **度量先行**：先做 §1 评测，否则 §2–9 的改进无法量化证明；每项都写明「用什么验收」。
2. **不稀释领先项**：改造循环/规划/隔离时，以下必须保持回归绿——完成证据闸（`server/services/loop/runtime-finalizeRuntime.js:54`）、防假完成讲解缓冲（`runtime-runModelRequest.js:120-185`）、审批策略来源钉住（`approvalGateAuthorization.js`）、媒体/PDF 套件、工程门禁密度。
3. **可验收出口**：每阶段末跑 `npm test` + `npm run eval:offline` + 新 `eval:live` 基线对比，全绿且无回归才算过。

## 阶段划分（依赖顺序）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0 地基** | §1 评测 | — |
| **P1 能力深度** | §2 代码智能 → §3 自主规划 | P0（用评测度量） |
| **P2 可信与体验** | §4 默认隔离 → §5 UX → §6 记忆整合 | P0 |
| **P3 收敛** | §7 长任务 → §8 Provider 广度 → §9 复杂度债 | P0 |

---

## §1 评测数据集（战略，最先做）

**现状**：`eval:offline` 16 套是确定性契约（测的是壳不是 agent）；`eval:live` 仅 7 个玩具修复任务
（`evals/starter-suite.json`），无 SWE-bench 式真实仓库任务 / pass@k / 裁判。**无法回答「这 agent 在真实活上有多强」。**
基建已在：`scripts/run-live-agent-evals.mjs` 支持 `--repeat`、workspace 指纹、`compareWithBaseline`、误完成追踪。

**目标**：能用数据对比 Gugo 与基线模型/其它 harness，并随改进检测回归。

**行动**：
- [x] 聚合指标：`scripts/liveEvalMetrics.mjs` 产出 success_rate(严格)、pass@1、pass@k(≥1)、**误完成率**、均值时长/工具调用；`liveEvalComparison` 出「Gugo vs 基线」对照表，`renderComparisonTable` 输出到 stderr（stdout 保持 JSON）。已接入 `run-live-agent-evals.mjs`（`report.summary`/`report.comparison`）。测试 `tests/liveEvalMetrics.test.js`。
- [ ] 扩 `evals/` 至 50+ 真实任务：多文件重构、跨语言 bug 修复、带既有测试的真实项目（可从真实 issue/PR 派生）；每题独立 verifier（沿用 `evals/verifiers/*.mjs` 的 out-of-workspace 模式，防 agent 改判分器）。**进展**：已从 7 增至 11（`spec-template-format-repair` 规约/边界、`spec-dedupe-merge-repair` 跨模块、`spec-state-machine-repair` 状态机/终态、`spec-interval-overlap-repair` 闭区间边界），均「先红后绿 + 完整修复可过 + 不变量」，待继续扩。
- [ ] 可选 LLM-judge 对主观质量打分（裁判模型与被测模型隔离，避免自评）。
- [ ] 固定跨模型基线；每轮报告 regression/fix（`compareWithBaseline` 已有 fingerprint 防陈旧）。
- [x] 「误完成率」当一等指标长期追踪：已进 `aggregateLiveEval` 的 `falseCompletionRate` 与对照表（对应 `runtime-finalizeRuntime.js` 完成闸是否真挡住）。

**验收**：`eval:live` 产出「Gugo vs 基线」成功率表；§2–9 任一改进都能跑 eval 得到可对比数字。
**难度**：中。**证据**：`docs/LIVE_AGENT_EVALS.md`、`tests/offline-evals/`。

---

## §2 代码智能三缺

**现状**：① `edit_file` 朴素字符串替换（`server/adapters/fsFileTools.js:375-388`，无 AST）；LSP `rename` 显式拒绝（`server/adapters/lspTool.js:199`）。② 无文件名/Glob 搜索（仅 `grep_code` + 单目录 `list_directory`）。③ 无 LSP 诊断/代码动作/补全/符号索引（`DEBT-LSP-001/002/003`）。相对 Claude Code 这是最实的深度差距。

**目标**：结构化重构、按名找文件、读到编译/报错，达到 Claude Code 级代码智能。

**行动**：
- [x] **Glob/文件名发现**：新增 `find_files`（`rg --files` + 名字过滤，回退 walker），注册进 catalog/metadata/dispatch/subagent/plan-mode/审批只读集。附带把共享 `globToRegex` 的 `**/` 修正为「匹配零或多级目录」（`src/**\/*.py` 现在也匹配 `src/pay.py`）。测试 `tests/codeSearch.test.js`（9 项）。
- [x] **结构化编辑**：`edit_file` 引入 AST 感知（先 JS，复用 acorn）——多处匹配时按真实解析优先落在代码（非注释/字符串）那一处；仅「唯一代码命中」才替换，否则仍报「不唯一」。非 JS / 解析失败回退精确匹配。`server/utils/jsAstEdit.js` + `fsFileTools.js`。测试 `tests/jsAstEdit.test.js`(7) + `tests/editFileAst.test.js`(3)。**仍开放**：TS 需 TS 解析器、结构化目标（按函数名改主体）、LSP rename。
- [ ] **LSP 扩展**：接 `rename`、`documentSymbol`/`workspaceSymbol`、`diagnostics`、`codeAction`（复用 `lspStdioProvider.js`/`lspWorkspacePool.js` 的 stdio 池）。
- [ ] **冷启动优化**：LSP 池预热 + 复用，关掉 `DEBT-LSP-002`（每次查询冷启动）。
- [ ] **诊断闭环**：编辑后把 diagnostics 喂回模型（在 `run_project_check` 之外提供轻量错误面）。
- [ ] 非 JS 用 tree-sitter 建统一符号索引（`symbolSearchPatterns.js:9` 已标 deferred，`codeSearch.js:8` 同）。

**验收**：跨文件 rename/重构类任务在 §1 评测成功率显著提升；`DEBT-LSP-001/002/003` 关闭。
**难度**：高。

---

## §3 自主规划 / 分解

**现状**：`manage_todos` 是纯回显工具（`server/services/loop/heuristics/toolExecutor.js:386` 只归一化返回，无宿主持久化/不强制）；ReAct 仅提示词契约（`outputContractPrompt.js:22`，循环不校验三元组）；宿主 goal-plan 是真规划器（证据绑定、未批准不开工，`goalPlanExecutionPolicy.js:86`）但**用户创建/审批驱动，非 agent 自主**。相对 Claude Code（todo 真被跟踪、plan-act 是核心闭环）偏弱。

**目标**：agent 能自主把任务拆成宿主可跟踪、证据可核验的子步，而不仅靠提示词。

**行动**：
- [x] `manage_todos` 从 echo 升级为宿主跟踪 + drift 检测：`server/services/todoTracker.js` 按 session 记录待办状态，**已完成的待办被改回未完成时标 drift**（模型须解释或纠正），不再是纯回显。测试 `tests/todoTracker.test.js`（5 项）。**仍开放**：持久化到 DB/checkpoint、与真实工具进展的交叉校验。
- [ ] 轻量校验 ReAct 三元组完整性（缺 Observation 不推进），保留提示词契约但加结构护栏。
- [ ] goal-plan 支持 **agent 自主提案 → 用户批准 → 执行** 的半自动拆解（复用现有 `goal_plan_rewrite` + 审批门）。
- [ ] 计划步骤与工具调用/证据一一绑定成可重入 plan-DAG（`AGENT_QUALITY_ASSESSMENT` 指出「两段式非 DAG」）。
- [ ] 失败反思写回（Reflexion 式）：把 `reflect` 结论结构化存入记忆，供后续轮次检索，而非仅提示注入。

**验收**：多步任务在 §1 评测里，计划-证据绑定成功率、断点续跑成功率提升。
**难度**：中高。**证据**：`server/services/loop/agenticTools.js:1-32`（自认缺 Reflect/Clarification）、`goalToolSpecs.js`。

---

## §4 默认隔离强度

**现状**：shell 沙箱默认 `host`（`server/adapters/shellDockerSandbox.js:108-117`，`SHELL_SANDBOX_MODE`），黑名单 `bashGuard.js:4-13` **自认可绕过、非安全边界**；`run_code`/`codex_models` 模型生成代码强制逐次审批但未见容器包裹；MCP/插件风险靠名字启发式（`WRITE_INTENT_RE`，`server/utils/approvalPolicy.js:217`）。设计是好的，缺的是默认强度。

**目标**：默认即隔离，把「信任用户」从默认前提降为显式选择。

**行动**：
- [ ] shell 沙箱默认从 `host` → docker（digest 固定镜像），`SHELL_SANDBOX_MODE=host` 变成显式降级选项。
- [ ] `run_code`/模型生成代码纳入容器包裹（沿用 `shellDockerSandbox.js` 的 hardening：`--network=none --read-only --cap-drop=ALL` 等）。
- [ ] MCP/插件工具风险改**能力声明清单**并在运行时强制（替代 `WRITE_INTENT_RE` 名字启发式），对不上则保守升级风险。
- [ ] 保留 `bashGuard` 黑名单但持续标注「非边界」；补充 seccomp/nsjail 路径覆盖无 docker 主机（对应 `DEBT-NET-002` 的诚实边界）。

**验收**：默认配置下恶意/越权 shell、模型生成代码逃逸用例被沙箱挡下；`bypassPermissionIntegration` 类回归扩展。
**难度**：中。**证据**：`server/adapters/shellDockerSandbox.js`、`server/utils/approvalPolicy.js`。

---

## §5 UX / 流式体验打磨

**现状**：`REFERENCE_GAP_ANALYSIS_2026-09-13` 第六节明确「UI 差距需真实运行对比（布局密度、流式渲染节奏、工具卡片样式），本轮不动」；`DEBT-UI-001`（深历史渲染开销）。这是用户**最直接看得见**的差距，也是近几轮一直在修的（预览自适应、按钮行常驻）那条线的延续。

**目标**：交互观感对齐顶尖 agent 的节奏与密度。

**行动**：
- [ ] 隔离浏览器实测出**具体 UI 差距清单**（对 Claude Code / zcode / codex：布局密度、流式节奏、工具卡片、diff/预览呈现）——先列清单再立项，不盲改。
- [ ] 流式渲染节奏：工具卡片逐步展开、讲解缓冲释放时机的观感（已修「图四」，继续对齐「图五」终态一致性）。
- [ ] 深历史渲染性能（`DEBT-UI-001`）：虚拟滚动/分页，避免长会话卡顿。
- [ ] 按清单逐项改，每项配 `tests/unit/` 组件测试 + 截图对照。

**验收**：清单每一项关闭；`npm test` 相关组件用例绿；实测截图前后对照。
**难度**：中。**证据**：`docs/WORKBENCH_FILE_PREVIEW_2026-09-19.md`、`src/pages/ChatSplit/`。

---

## §6 记忆整合

**现状**：记忆强（模型可写 `remember` + 自动捕获 + 新鲜度标注 + 知识图谱 + `.agent/experience.md` 日志），但**无 consolidate 式合并/剪枝/矛盾消解**（`memoryStore.js` / `experienceJournal.js` 只增不减）；compaction archive 只导出/GC，不喂回 recall。

**目标**：记忆会「整理」而不只是「累积」。

**行动**：
- [x] 记忆合并/剪枝/矛盾消解 pass（对标 Claude `consolidate-memory`）：`server/services/memoryConsolidation.js` 的 `consolidateMemoryPass`——精确去重合并（保留 pinned/最新）、矛盾标注（同标题异正文，不擅自判定）、**被 `[[slug]]` 引用的副本保留不删**（防断链）、默认 dry-run。测试 `tests/memoryConsolidation.test.js`（4 项）。
- [ ] `.agent/experience.md` 定期蒸馏（`experienceAbstraction.js` 已有雏形）成可检索的高层记忆。
- [ ] compaction archive 喂回 recall：检索时可召回历史摘要，而非只存档。
- [ ] 记忆去重/冲突策略统一（`AGENT_QUALITY_ASSESSMENT` 指出 auto memory 与显式 remember 各自处理）。

**验收**：长会话/跨会话记忆不膨胀且检索命中率不降；`memoryRelevanceScoring`/`memoryEmbeddings` 用例扩展。
**难度**：中。

---

## §7 长任务鲁棒性

**现状**：压缩有损、无「无限上下文」；token 估算靠启发式（`estimateContextTokens`，非真分词器）；语义摘要可能静默退化为机械摘要（`contextSemanticSummaryExecution.js`）。自审反复强调「不能宣称任意模型任意任务必然成功」。

**目标**：长任务关键约束可追溯、压缩不静默丢关键信息。

**行动**：
- [ ] 语义压缩质量护栏：摘要失败必须**显式降级并告知**，不静默退回机械截断。
- [ ] 真 tokenizer 计数替代启发式估算（至少覆盖主力模型），工具结果截断按真实 token 而非字符。
- [ ] 长任务样本跨模型回归（依赖 §1 评测集里的长任务），验证关键约束跨压缩仍可追溯。
- [ ] `trimOldestContext` 的有损路径持续标注「仅兼容、不用于自动恢复/检查点」（保持现状诚实）。

**验收**：长任务评测里约束丢失率下降；压缩前后关键事实可追溯。
**难度**：中高。**证据**：`server/services/contextCompactionRuntime.js`、`docs/CONTEXT_COMPACTION.md`。

---

## §8 Provider / infra 广度

**现状**：Anthropic + Gemini 原生 + OpenAI 兼容 + Ollama/LM Studio（`nativeModelProviders.js`），failover 有隐私护栏（默认不跨 Provider，`modelFailover.js:4-25`）；缺 Bedrock/Vertex/Azure 一等适配，failover 单配置顺序、无对冲/竞速。

**目标**：覆盖企业/云主流端点，提升模型调用韧性。

**行动**：
- [ ] Bedrock / Vertex / Azure 适配器（`modelProviderRegistry.js:46` 已有 `buildRequest/parseResponse/extractUsage/requestReconciler` 契约，照此实现）。
- [ ] 对冲/竞速 failover（同 Provider 多端点），保留隐私护栏与 `REASONING_RUNAWAY` 不切换的既有语义。
- [ ] 可选本地响应缓存 / 语义去重（`modelRequestCache.js` 目前只管 provider 前缀缓存，非响应缓存）。

**验收**：新 Provider 通过 `nativeModelProviders` 适配器契约测试；failover 用例（`modelFailoverSafety`）扩展。
**难度**：中。

---

## §9 复杂度债（贯穿 P0–P3）

**现状**：循环是单体词汇（~100 标记常量、~20 独立重试计数器挤一个依赖袋 `runtime.js:106-158`）；`completionPolicy.js:1-30` 自认「难审计易漂移」且只描述不强制；缺统一 trace 根/子 span（`AGENT_QUALITY_ASSESSMENT` 遗留）。

**目标**：可维护、可审计的循环，不因补功能而继续膨胀。

**行动**：
- [ ] `runtime.js` 标记/计数器收敛为显式状态机 + 可校验转移表（`AGENT_QUALITY_ASSESSMENT` §1 指出「无显式状态机图」）。
- [ ] `completionPolicy` 从「描述」变「强制」：终止决策单一入口校验，计数器语义统一。
- [ ] 统一 trace：根/子 span 设计（表达「根 trace ↔ 子 turn/子 agent」父子关系），持久化进 Turn 事件（`gugo trace` 只读命令已备）。
- [ ] 新增能力时同步清理对应 `DEBT-SIZE-001`（超大运行时清单）条目。

**验收**：`audit:functions -- --check` 复杂度违规持续为 0；新增循环逻辑走状态机而非再加计数器。
**难度**：持续。

---

## 不在本 roadmap（记录，按需另立项）

- **OS 级 air-gap**（`DEBT-NET-002`）：本地优先 ≠ 任意脚本的 OS 级隔离，是产品边界非缺陷。
- **Windows 代码签名**（`DEBT-RELEASE-001/002`）：已明确接受的未签名风险。
- **插件公开兼容契约**（`DEBT-PLUGIN-001`）、**WS 信任边界**（`DEBT-REALTIME-001`）：等 P0–P3 收敛后按产品需要排。

---

## 一页速览（按性价比）

| 优先 | 项 | 难度 | 一句话 |
|---|---|---|---|
| 1 | §1 评测数据集 | 中 | 先能度量，否则后面都白改 |
| 2 | §2 代码智能三缺 | 高 | 结构化编辑/rename、Glob、LSP 诊断 |
| 3 | §3 自主规划 | 中高 | todo 真跟踪、ReAct 校验、半自动拆解 |
| 4 | §4 默认隔离 | 中 | 沙箱默认开、模型代码容器化 |
| 5 | §5 UX 整形 | 中 | 实测清单逐项改（延续预览/按钮线） |
| 6 | §6 记忆整合 | 中 | 合并/剪枝/矛盾消解 |
| 7 | §7 长任务 | 中高 | 压缩不静默丢、真 tokenizer |
| 8 | §8 Provider 广度 | 中 | Bedrock/Vertex/Azure + 对冲 failover |
| 9 | §9 复杂度债 | 持续 | 状态机化、completionPolicy 强制 |
