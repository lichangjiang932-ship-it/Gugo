# Gugo 内核对照分析 · 2026-07-31（实测）

对照对象：OpenWorker（local-first 桌面 beta，2026-07-31 最新提交）、Claude Code、Codex。
口径：**逐项核对 Gugo 当前源码**，不是凭上次结论。

---

## 一句话结论

Gugo 在「自主 agent 内核深度」上已经**追平甚至局部超过** OpenWorker（子代理嵌套+预算/审批继承、上下文压缩、可编辑计划、调度 cron、社交触发桥都是 Gugo 已有而 OW 偏弱的）。
但内核仍存在**一处真·架构根因**，且是 **web 多用户产品的头号风险**：

> `bash_exec`/文件写入**直接跑在服务器共享文件系统**上（`fsShellTools.js:36` 全局 `WORKSPACE_ROOT`），无 OS 级沙箱。
> —— 多用户隔离是唯一的 P0。（**注**：MCP 工具、原生浏览器工具、跨 provider 兜底此前被误报为「缺失」，经 22:57 复核均已确认存在，见下文更正小节。）

---

## 已追平 / 领先（本轮确认已修，移出缺口清单）

| 能力 | 证据 | 状态 |
|---|---|---|
| 子代理并发排队（非 429 丢弃） | `subagentRuntime.js:40/98/138` acquireUserSlot + drainLimiter | ✅ |
| 子代理预算继承 | `jobTools.js:340/671` 传入 parent budget；`subagentRuntime.js:400/670/740` effectiveBudget 兜底 | ✅ |
| 审批继承（父批过子不再弹） | `jobTools.js:475` createSubagentApprovalContext；`subagentRuntime.js:175-190` reused+pending 去重 | ✅ |
| 计划 step id 保留（不再 rewritten 成 edited-N） | `jobRuntime.js:558-567` reusableStepIds | ✅ |
| 上下文压缩（模型摘要 + 自适应尾部） | `contextCompactionRuntime.js` + `compactionService.js`，接入 jobTools/subagentRuntime | ✅ |
| 上下文可见（CJK 感知、默认显示） | `ChatMessages.jsx:229` estimateClientContextUsage（CJK 感知） | ✅（小残次见下） |

---

## 仍存在的缺口（按优先级）

### P0 — 多用户沙箱 / worktree 隔离  ❌ 缺失
- **现状**：`fsShellTools.js:36-37` 解析一个**全局**根（`WORKSPACE_ROOT` → `process.cwd()`），所有用户共享；`bashExecTool` 直接 spawn 在共享根下。代码自身也承认：`bashGuard.js:12`「需 OS 级隔离(容器/nsjail/seccomp)」、`processGroup.js:15`「不替代真正的 OS 级 sandbox」。
- **为什么对 Gugo 比 OW 更重要**：OW 是单机本地、单用户，物理上不需要隔离；Gugo 是 **web 多用户**，一个用户的 `bash_exec` 能摸到别人数据甚至服务器本身。这是上生产前的硬门槛。
- **标杆**：Claude Code 用 git worktree + 系统沙箱；Codex 直接上容器。
- **修法方向**：新增 `jobSandbox.js`，让 `bash_exec`/文件写入默认落在**按 job 独立的 worktree / 隔离目录**内，跨用户不可见；可选容器做进程级隔离。

### P1 — 计划生成仍是正则，不是模型驱动  🟡 部分
- **现状**：`jobPlanner.js` 无模型调用。`detectTaskType` 是 `/(代码|项目|仓库|bug|...)/i` 正则；`parseRequestedCount` 正则抓「N 份」；`buildInitialPlan` 固定骨架 `plan→execute→verify→finalize`。你加了「可编辑 UI」救不了「计划本身质量差」。
- **标杆**：Claude Code 计划模式先让模型探索代码库再产出可编辑计划。
- **修法方向**：计划阶段先跑一轮 `explore` 子代理收集上下文，再让模型产出步骤；前端允许编辑/增删后 `approvePlan`（你的 editable UI 已就位，只差生成端）。

### P1 — 跨 provider fallback 路由  ✅ 已存在（22:57 更正）
> **误报更正**：此前报告称「跨 provider 兜底缺失」是错的。仅查 `modelRetry.js`（确实只同 provider 重试）就下了结论，漏看了真正做 failover 的 `modelProxy.js`。
- **现状**：`modelProxy.js` 有完整实现——`isProviderFailoverError`(:181)、`resolveModelFailoverConfigs`(:188)、`runWithProviderFailover`(:218)、`streamWithProviderFailover`(:244)。**且 job 路径在用**：`callBackgroundModel`(:731，job 的 `runModel` 最终落点) → :749-750 `resolveModelFailoverConfigs` + `runWithProviderFailover`。provider 整体 5xx 会自动换家。
- **结论**：此项**移出缺口清单**，Gugo 已达 CC/Codex 同级健壮性。

### P1 — 浏览器原生工具进不了 job  ✅ 已存在（22:57 更正）
> **误报更正**：此前称「原生浏览器工具进不了 job」是错的。仅查 `jobTools.js`（对 `browser` 零引用）漏看了 `jobRuntime.js`。
- **现状**：`jobRuntime.js:187-189` 在 `enableServerTools`（默认 true）时 `listRegisteredBrowserToolSpecs()` 并入 job 工具集 `[...staticJobToolSpecs, ...mcpToolSpecs, ...browserToolSpecs]`。原生浏览器自动化在自主 job 内**已可用**。
- **结论**：此项**移出缺口清单**（MCP 进 job 此前也已证伪，详见 21:59 更正）。

### P2 — token / 美元成本上限  🟡 部分
- **现状**：`server/utils/jobBudget.js` 只有 `maxTotalCalls`（默认 80）+ `maxWallMs`（默认 10min）。80 次长上下文请求 = 无 token 上限开销。嵌套子代理更明显。
- **标杆**：按 token 或美元设硬上限。
- **修法方向**：预算加 `maxTokens` / `maxCostUsd`，从模型 `usage` 回传累计。

### P2 — 连接器数量透明化  🟡 部分
- **现状**：真实后端 **4 provider / 10 tools**（Notion/GitHub/Slack/Google Drive）；`shared/webConnectorCatalog.js` 有 **32 个书签**（只 `open url` + 营销文案，零后端）。对用户有「31 个集成」的误导。
- **标杆**：OW 25+ 是真实集成。
- **修法方向**：UI 区分「已接入」与「敬请期待」，别把书签当集成数。

### P2 — 上下文条真实化 + 常驻  🟡 小残次
- **现状**：`ChatMessages.jsx:229` 调用 `estimateClientContextUsage` 时**没传 `systemPrompt`** → 真实 system 提示词被折叠成固定 `FIXED_CONTEXT_OVERHEAD_TOKENS=16`（`contextUsage.js:2/69`），系统性低估。
- **修法方向**：传入真实 system 提示词，纳入 tool-spec/附件开销，常驻显示。

### P2 — 图像生成  ❌ 缺失（按你要求暂不做）
- 全库无 `image_gen`/`generate_image`。OW 在多模态上也就一般，这不是最紧迫项。

### P2 — 语音服务端 STT 回退  🟡 小残次
- **现状**：`ChatSplit/index.jsx:1151` 已有 Web Speech API（zh-CN）且接进输入框；但无服务端 STT，Firefox 等直接没语音。
- **修法方向**：要「像 OW 那样」得补服务端识别兜底（OW 用 Rust `stt/` 侧车）。

---

## 本轮（22:57）误判更正与元教训

本次复核过程中，我**连续三次把"已存在的能力"误报成"缺口"**，三次根因相同——只查了 `jobTools.js` 一个文件，漏看了 `jobRuntime.js` / `modelProxy.js`：

| 误报项 | 真相 | 证据 |
|---|---|---|
| MCP 工具进不了 job | 已能进（21:59 更正） | `jobRuntime.js:140-143` 合并 `listUserToolSpecs` |
| 原生浏览器工具进不了 job | 已能进（22:57 更正） | `jobRuntime.js:187-189` 合并 `listRegisteredBrowserToolSpecs()` |
| 跨 provider 兜底缺失 | 已实现且 job 在用（22:57 更正） | `modelProxy.js:731→749-750` `runWithProviderFailover` |

**结论倾向**：Gugo 的实际成熟度高于前几轮报告所写。后续任何 gap 复核，**必须跨 `jobTools.js` / `jobRuntime.js` / `modelProxy.js` / `fsShellTools.js` 多文件交叉验证**，不能再以单文件下结论。

---

## 标杆对照要点（OpenWorker 最新）

- **形态差异**：OW 是 local-first 桌面（Tauri+Rust+Python aisuite 引擎），单机单用户、BYO key、本地密钥库、自动更新。Gugo 是 **web 多用户**——这是 Gugo 的差异化，也是隔离风险的根源。
- **OW 强项**：25+ 真实连接器（GitHub/Slack/Jira/Notion/Linear/HubSpot/Outlook/Gmail/Calendar…）、MCP + per-tool 控制、Slack `@OpenWorker` 原生触发、调度自动化、Ask-before-acting 审批。
- **OW 弱项 / 与 Gugo 重叠**：上下文条默认折叠（刚修了一个扫描进 `~/Library` 的 bug）；无 web 多用户；agent 内核深度（子代理继承、压缩、可编辑计划）不如 Gugo 当前实现。

---

## 建议落地顺序（按 ROI）

| 优先级 | 事项 | 关键文件 | 收益 |
|---|---|---|---|
| **P0** | 执行沙箱 / worktree 隔离 | `fsShellTools.js` + 新增 `jobSandbox.js` | 消除多用户最大风险，上生产前提 |
| **P1** | 计划改为模型驱动 + 可编辑 UI 已就位 | `jobPlanner.js` + 现有 `EditablePlanCard` | 复杂任务不跑偏，体感最直接 |
| **P2** | 成本上限 token/美元 | `server/utils/jobBudget.js` | 多用户计费安全 |
| **P2** | 连接器数量透明化 | `webConnectorCatalog.js` + UI | 不误导用户 |
| **P2** | 上下文条真实化常驻 | `ChatMessages.jsx` + `contextUsage.js` | 真实用量可见 |

> 注：此前你要求的 `chrome-devtools-mcp` 集成与 `gsap-skills` 技能**尚未落地**，但**阻塞点已消除**——MCP 工具经 `listUserToolSpecs` 已进入 job 运行时，接入 chrome-devtools-mcp 后即可在自主任务里直接调用；gsap-skills 作为 skill 注入 system prompt 也不受 job 工具链限制。可直接开工。
