# Gugo CLI

Gugo 提供 `gugo` 命令行入口，旧名称 `yma-cli` 仍作为兼容别名。CLI 可连接已运行的 Gugo 服务管理登录与基础资源，也可在不启动 HTTP 服务或浏览器的情况下运行一个持久化 Agent Turn。

默认本地模式无需注册或登录；内部 owner 身份仅用于数据归属。工具审批、目录授权及未知结果核实仍然有效。本地模型与显式第三方 Provider 都由用户选择，Gugo 不设置付费解锁或余额门槛。

## 调用方式

安装或链接该包后：

```powershell
gugo --help
gugo --version
```

在源码目录中可直接调用：

```powershell
node .\bin\yma-cli.js --help
npm run cli -- --version
```

下文统一使用 `gugo`。

## 命令总览

| 命令 | 输出 | 用途 |
|---|---|---|
| `gugo --help` | 文本 | 显示命令帮助 |
| `gugo --version` | 文本 | 显示 `package.json` 中的当前版本 |
| `gugo login --email <email>` | 文本 | 请求邮箱验证码 |
| `gugo verify --email <email> --code <code>` | 文本 | 校验验证码并保存登录 token |
| `gugo session list [--archived true\|false\|all] [--limit <n>] [--offset <n>]` | JSON | 分页列出会话 |
| `gugo session search --query <text> [--session-id <id>] [--limit <n>] [--offset <n>]` | JSON | 搜索会话消息 |
| `gugo session show <session-id> [--limit <n>] [--offset <n>]` | JSON | 读取会话快照与消息 |
| `gugo model list [--provider <id>] [--search <text>]` | JSON | 发现可供 `run` 使用的模型 |
| `gugo agent list` | JSON | 列出 Agent |
| `gugo skill list` | JSON | 列出 Skill |
| `gugo status` | JSON 或文本 | 检查公开健康端点是否可访问 |
| `gugo doctor` | JSON 或文本 | 读取需要认证的完整运行诊断 |
| `gugo trace <turnId>` | 文本或 JSON | 从本地持久事件重建单个 Turn 的时间线 |
| `gugo goal ...` | JSON | 本地目标计划：创建 / 批准 / 步骤证据绑定 / 版本化重规划 / 事件裁剪 |
| `gugo memory reindex` | JSON 行 | 回填记忆向量索引（默认关闭，需显式启用） |
| `gugo run ...` | JSONL 或文本 | 在当前进程运行或恢复一个持久化 Turn |
| `gugo chat` | 交互式终端 | 一个终端里连续多轮：切模型/模式/工作区、实时看工具进度、看/批准计划 |

`-h` 等价于 `--help`，`-V` 等价于 `--version`。不带参数时也会显示帮助。

除 `run` 的独立参数解析外，带值选项同时接受 `--name value` 和 `--name=value`。未知选项、重复选项和多余位置参数均以退出码 `2` 结束。

## 服务地址

登录、验证、资源列表、`status` 和普通 `doctor` 通过 HTTP 访问 Gugo 服务；`run`、`chat`、`doctor --headless`、`trace`、`goal`、`memory reindex` 在本地进程运行。HTTP 默认地址为：

```text
http://127.0.0.1:5173
```

推荐用一个完整地址覆盖默认值：

```powershell
$env:GUGO_SERVER_URL = 'http://127.0.0.1:5175'
gugo agent list
```

`GUGO_SERVER_URL` 必须是绝对 `http://` 或 `https://` URL，不能包含用户名或密码。其优先级高于 `SERVER_HOST` 和 `SERVER_PORT`。未设置时，CLI 使用以下回退：

| 环境变量 | 默认值 |
|---|---|
| `SERVER_HOST` | `127.0.0.1` |
| `SERVER_PORT` | `5173` |
| `GUGO_CLI_HTTP_TIMEOUT_MS` | `10000` |
| `GUGO_CLI_RUN_TIMEOUT_MS` | 未设置（不限制） |

`GUGO_CLI_HTTP_TIMEOUT_MS` 必须是正整数，控制每次 CLI HTTP 请求的超时时间，单位为毫秒。超时以 `REQUEST_TIMEOUT` 和退出码 `1` 结束。

`GUGO_CLI_RUN_TIMEOUT_MS` 是可选的 Turn 执行超时，单位为毫秒；命令行 `--timeout <ms>` 优先于环境变量。两者都只接受 1–2147483647 的十进制整数，未设置时不限制。到期后 CLI 请求取消 Turn，并等待持久化终态和运行时清理。只有没有更具体终态证据的协作取消才以 `CLI_RUN_TIMEOUT` 与退出码 `124` 结束；一致且完整的成功保留正文与退出码 `0`，并在 stderr 提醒 deadline 已过。具体失败、恢复阻塞或未知副作用不会被改写为超时。详见下文“deadline 与结果证据”。

`gugo run` 不经由该 HTTP 地址执行。它在 CLI 进程内启动 Gugo 的内置 Headless Runtime，并使用本机运行时配置、模型配置和 Turn 持久化目录；`GUGO_SERVER_URL` 不会把 `run` 转发到远程服务。`run` 也不会读取或复用任何服务作用域的 HTTP token，远程登录凭据不会进入本地 Headless Runtime。

## 登录与 token

多用户服务先请求验证码，再完成验证：

```powershell
gugo login --email user@example.com
gugo verify --email user@example.com --code 123456
```

验证成功后，token 按目标服务隔离保存在：

```text
~/.yma-cli/tokens/<sha256>.json
```

`<sha256>` 是完整规范化服务 URL 的 UTF-8 SHA-256 十六进制摘要。规范化会使用标准 URL 解析结果，移除查询参数、片段标识和末尾 `/`；协议、主机、端口及非根路径仍属于作用域。因此，不同协议、主机、端口或服务路径不会共享凭据。凭据文件为版本化 JSON，记录其 `serverUrl` 和 `token`；读取时还会校验文件内的服务 URL 与当前作用域一致。

CLI 创建 token 目录时请求 `0700` 权限，凭据文件请求 `0600` 权限，并通过同目录临时文件原子替换。`session`、`model list`、`agent list`、`skill list` 和 `doctor` 只使用当前服务作用域的 token。

早期版本保存在 `~/.yma-cli/token` 的旧 token 只会迁移到规范化 URL **精确等于** `http://127.0.0.1:5173` 的作用域。`localhost`、其他回环地址、其他端口、自定义路径以及任何远程服务均不会读取或迁移旧 token。旧文件不会因迁移而删除。

### 本地模式自动 bootstrap

需要认证的 HTTP 命令在本地没有 token 时，会先调用 `/api/auth/bootstrap`。当目标服务处于 `AUTH_MODE=local` 且可建立当前 local owner 会话时，CLI 自动保存服务返回的 token，再执行原命令。

已有 token 收到 `401` 时，CLI 也会调用一次 bootstrap 并重试原请求。这不会绕过多用户认证：远程服务或 `AUTH_MODE=multi_user` 无法建立本地 owner 会话时，命令以 `AUTH_REQUIRED` 和退出码 `1` 结束，用户仍须显式执行 `login` / `verify`。

## 列表命令

```powershell
gugo session list
gugo session list --archived true
gugo session list --archived all --limit 50 --offset 0
gugo session search --query "发布计划"
gugo session search --query "测试失败" --session-id <session-id> --limit 20
gugo session show <session-id>
gugo session show <session-id> --limit 200 --offset 0
gugo agent list
gugo skill list
```

`session list` 的 `--limit` 范围为 1–200，默认 100；`session search` 的范围为 1–100，默认 20；`session show` 的范围为 1–2000，默认 2000。三者的 `--offset` 都是从 0 开始的非负安全整数。`search` 必须提供非空 `--query`，可用 `--session-id` 将结果限制到单个会话。`show` 返回服务端快照，其中包含分页消息、总消息数以及下一页位置等服务端字段。

这些命令把服务返回值格式化为普通 JSON。它们不是逐行事件流，不应按 JSONL 解析。

## 模型发现

在调用 `run --model ... --provider ...` 前可查询已配置模型：

```powershell
gugo model list
gugo model list --provider <provider-id>
gugo model list --search deepseek
```

输出为 `{ "models": [...] }`，每项包含模型名、Provider ID/名称、启用状态、默认状态、该模型的就绪探测结果及能力档案。筛选在 CLI 本地执行，`--provider` 精确匹配 Provider ID，`--search` 对模型名及 Provider 标识进行不区分大小写的包含匹配。输出使用显式白名单，不包含 API Key、请求头或 Provider 基础地址。

## 服务状态与诊断

快速检查公开健康端点：

```powershell
gugo status
```

`status` 请求 `GET /api/health`，不要求 token。HTTP 响应成功时退出 `0`，非成功状态退出 `1`；响应体为 JSON 时格式化为 JSON，否则原样输出文本。

读取完整诊断：

```powershell
gugo doctor --json
```

`doctor` 请求需要认证的 `GET /api/health/full`，因此会使用 token 或尝试本地模式自动 bootstrap。模型诊断按该登录用户的默认 Agent binding 判断，与真实 `run` 启动前的 readiness 门禁保持一致。`model.configured` 只表示模型配置存在；`model.agentReady` 表示默认 binding 已通过 Agent、工具调用和最近一次 Provider 探测要求。未就绪时，`model.readinessCode` 与 `model.code` 返回同一个稳定错误码，`model.action` 返回稳定修复动作；未配置固定为 `MODEL_CONFIG_MISSING` / `configure_model`。响应不会列出缺失的 `MODEL_*` 环境变量名、密钥或服务端本地化文案。

只有数据库正常且 `model.agentReady: true` 时，完整健康端点才返回 HTTP `200`、`ok: true`，`doctor` 退出 `0`；已配置但 Provider 未验证、不可用或仅支持聊天也会返回 HTTP `503`、`ok: false`，`doctor` 退出 `1`。CLI 会把 `503` 的诊断 JSON 完整写到 stdout，便于自动化保存故障证据。

### 无网页预检：`doctor --headless`

`gugo doctor` 不带参数时仍走上面的 HTTP 端点。加 `--headless` 则在**本进程内**做本地预检，不要求服务已在运行，也不发送模型请求（除非显式加 `--probe`）：

```powershell
gugo doctor --headless
gugo doctor --headless --json --integrity  # 显式进行完整 SQLite 检查；仍只读
gugo doctor --headless --cwd "D:\demo\workspace"
gugo doctor --headless --model deepseek-chat --provider <provider-id>
gugo doctor --headless --probe   # 实际探测选定端点；仅保存的 Provider 持久化 readiness
```

| 选项 | 行为 |
|---|---|
| `--headless` | 使用本地预检而不是 HTTP `doctor` |
| `--json` | 接受显式 JSON 调用；headless 无论是否指定都输出 JSON |
| `--cwd <dir>` | 只选择任务工作区，不改变运行时目录 |
| `--model <name>` | 预检指定模型 |
| `--provider <id>` | 预检指定 Provider（ID 或 key） |
| `--probe` | 显式执行端点/补全/工具探针；环境端点结果仅本次有效，默认关闭 |
| `--integrity` | 仅 headless：显式运行 SQLite integrity/quick/FK 检查，不修复数据库 |

输出为单个 JSON 对象（stdout），退出码 `0` 表示无阻断项、`1` 表示存在阻断。字段含义：

- `runtime`：实际使用的 `dataDir` / `dbPath` / `artifactDir` / `configPath`，以及本次由进程环境显式覆盖的存储键。`runtime.cwd` 始终是启动目录，**不是** `--cwd`。
- `workspace`：`--cwd` 解析出的任务工作区及其存在性。
- `model`：选中 Provider/模型/配置版本；`toolsDeclared` 是配置声明。`probe.status` 区分 `passed` / `failed` / `not_run`，并区分持久结果与本次临时探测。环境配置存在不等于探测通过；未探测的 `checkedAt` 为 `null`。
- `probeSteps`：仅在 `--probe` 时出现，包含步骤名、是否通过、耗时、稳定错误码及可用的脱敏诊断。
- `diagnostics`：实际安装的 Node/React/DOM/可选 Ink 版本、SQLite 检查、FTS 可读性、记忆索引待处理队列、附件目录元数据、MCP 解释器解析及缓存可观测性。未检查项明确为 `not_checked` / `unavailable`；解释器存在不代表 MCP 协议可用，前缀路由能力不代表 KV 命中。
- `blocking`：阻断原因与稳定修复动作（如 `configure_model`、`test_provider`、`choose_workspace`、`login`）。

默认 headless 诊断只读取已有运行时：不创建数据库、WAL/SHM、账户、凭据密钥或附件目录，不自动迁移、重建索引或改写旧凭据。首次未初始化、旧 schema、活跃 WAL/待恢复日志会返回明确的阻断原因；不要把“无法安全检查”理解为数据已损坏。运行中的服务可改用 HTTP `doctor`，或正常关闭运行时后重试。

默认 quick/FK 检查只针对不超过 16 MiB 的数据库；更大或大小未知时需显式 `--integrity`。缺少原生只读能力时采用有界内存影像（默认 16 MiB、`--integrity` 最多 128 MiB）；超出预算明确拒绝，不忽略 WAL 读取旧数据。诊断期间源文件变化会使本次结果失效。FTS 只做读取探针，未宣称完整索引校验或自动修复。

默认预检不产生上游推理请求；`--probe` 会真实调用所选端点，本地模型可完全离线使用，第三方模型按其自身规则计费。凭据不进入 JSON 输出。歧义、禁用或模型不匹配会在探测前阻断；显式本地 legacy `MODEL_*` 配置若被保存的其他 Provider 覆盖，会报告绑定冲突，需明确 `--provider` 或使用命名环境 Provider，不能悄悄探测另一个云端默认值。

`--probe` 仅可在结构有效的已有数据库上保存选定 Provider 的 readiness；仍不初始化数据库、不迁移或回写凭据，也不自动下载模型。

LM Studio 空闲卸载模型后，`run` 的已确认 HTTP 400 会显示 `MODEL_NOT_LOADED` 和固定加载提示；先加载已选择的模型再重试，不会自动下载权重或改用云模型。

### 单 Turn 时间线：`gugo trace`

```powershell
gugo trace <turnId>
gugo trace <turnId> --session-id <session-id> --limit 500
gugo trace <turnId> --json
```

`trace` 只读本地持久事件（不启动 HTTP、不调用模型），把 `sessionId` / `turnId` / `toolCallId` /
`modelRequestId` 关联成一条时间线，并汇总模型阶段数、工具调用/失败数、审批数、检查点数，
以及 prompt/completion/measured cached token。`--json` 输出完整事件与聚合对象，
便于脚本消费。无法仅凭 Turn ID 定位会话时需同时传 `--session-id`（与 `run --resume` 一致）。
退出码：找到并读出为 `0`；未找到、缺少身份或缺少 Turn ID 为 `1`；参数错误为 `2`。

`context_prepared` 还记录工具 schema / 稳定前缀指纹和脱敏记忆覆盖诊断，阶段为 `pre_compaction`，不代表最终供应商 tokenization 或 GPU KV 命中。稳定前缀只统计开头**连续且显式标记 `__gugoPromptStability==='stable'`** 的 system 块；未标记、`volatile`、未知标记或非 system 消息都会结束前缀并按保守“无稳定前缀”处理。诊断的 `comparisonScope` 固定为 `within_turn`：指纹对比仅在同一 Turn 内相邻两次模型请求之间进行，不跨 Turn 持久化，也不重建历史边界；旧版（v1 快照、全部 system 坍缩边界）的先前值不可比，显示为 `prefix not comparable`。实际 cache usage 未报告时保持未知，不能显示成零命中。兼容流在请求了 usage 时，会有限读取 `finish_reason` 后的统计帧；缺失统计不会触发模型重试。LM Studio 默认支持该请求选项，显式 `MODEL_STREAM_USAGE=0` 可关闭。

### 目标计划与步骤证据：`gugo goal`

```powershell
gugo goal create "修复计数器缺陷" --steps '[{"title":"复现","acceptance":["失败测试可见"]},{"title":"修复"}]'
gugo goal list [--status approved] [--limit 50]
gugo goal show <planId>            # 含 steps 与事件时间线
gugo goal approve <planId>
gugo goal step <planId> <stepId> --status done --turn <turnId> [--tool-call <id>] [--note <text>]
                      [--manual-confirm] [--confirmed-by <who>]
gugo goal rewrite <planId> --steps '<新的步骤 JSON>' [--objective <新目标>]
gugo goal prune [<planId>] [--keep <n>]        # 事件保留上限,默认每计划 500 条
```

计划提供乐观并发控制：`show` 返回的 `version` 可作为 `--expect-version <n>` 传给
`approve` / `step` / `rewrite`；版本不符时操作失败并返回 `GOAL_PLAN_VERSION_CONFLICT`，不会覆盖别人的修改。
`revision` 是重规划代数，`version` 是写入版本，两者独立。

服务端持久化目标计划（`goal_plans` / `goal_plan_steps` / `goal_plan_events`），不是客户端 TODO：

- **步骤只能带证据完成**。“证据真实存在”与“证据证明该步骤完成”是两件事：
  - **同会话绑定**：证据所在 Turn 必须属于该计划所在会话。另一个会话里的成功工具调用不能完成
    本计划的步骤（`GOAL_EVIDENCE_SESSION_MISMATCH`）。
  - **验收条件**：步骤可以声明可机器核验的验收条件，引用 `--tool-call` 时必须命中其中之一，
    否则 `GOAL_EVIDENCE_TOOL_CALL_IRRELEVANT` / `GOAL_EVIDENCE_ACCEPTANCE_UNSATISFIED`：

    | kind | 判定 | 附加字段 |
    |---|---|---|
    | `tool` | 同会话内任意成功工具调用（**未声明任何对象条件时的默认值**） | — |
    | `command` | 指定命令类工具成功且退出码为 0 | `tools?: string[]`、`cwd?: string` |
    | `file` | 写入了该路径（可同时校验摘要） | `path`、`sha256?` |
    | `artifact` | 产生了对应产物 | `artifactId?` 或 `type?` |
    | `verification` | 宿主 `taskVerification` 通过 | — |
    | `manual` | 需要人工确认（`--manual-confirm [--confirmed-by <who>]`），**工具成功永远不能替代** | — |

    字符串型 acceptance 只作人工可读说明，不参与判定。
  - **必需步骤不能被跳过**：带对象型验收条件的步骤用 `--status skipped` 会被拒绝
    （`GOAL_PLAN_INVALID_TRANSITION`）——那是绕过验收。要么 `blocked`（会写 `plan.replan_required`），
    要么 `rewrite` 重规划。
  - 证据不通过时步骤状态不变，返回 `GOAL_STEP_EVIDENCE_REQUIRED`（附带具体 evidence code 与
    `satisfied` 说明：通过的是哪一条验收）。
- **状态机**：计划 `awaiting_approval → approved → completed`（另有 `blocked`/`cancelled`/`superseded`）；
  步骤 `pending → in_progress → done | blocked | skipped`。未批准的计划不能改步骤；批准只允许计划所有者。
- **一个工具调用只能证明一个步骤**：证据落在 `(user_id, evidence_turn_id, evidence_tool_call_id)` 上，
  重复引用会返回 `GOAL_EVIDENCE_ALREADY_USED`；把旧步骤退回 `in_progress` 才会释放。
- **步骤 blocked 会写下 `plan.replan_required` 事件**（带 stepId），供人和 agent 据此决定是否重规划。
- **事件保留**：`gugo goal prune [--keep n]`，默认保留**每个计划**最新 500 条（不是整个用户共享一份预算）。
- **工具结果是自包含的**：`goal_step_update` / `goal_plan_status` 直接返回 `openSteps` /
  `nextStepId` / `openStepCount` / `completed`，agent 不需要再发一次读请求。

### agent 侧的计划工具（loop 已接入）

当会话存在未终结（`awaiting_approval` / `approved`）的计划时，本轮会额外挂载三个工具（没有计划的会话工具集不变）：

- `goal_plan_status`：读取计划与每步状态/证据；
- `goal_step_update`：推进步骤，`status=done` 必须带 `turn_id` / `tool_call_id` 证据，宿主即时核验；
- `goal_plan_rewrite`：提出新计划（创建 `revision+1` 并把旧计划置 `superseded`，**需用户重新批准**）。

同时把当前计划作为一条 system 上下文注入本轮 prompt（在 memory 之后、plugin 块之前，属易变尾部，不改动稳定前缀）。
每一步的进度计数与“下一步可执行步骤”也直接写进块尾，`>32` 步时不会静默丢弃而是写明截断。
**agent 不能自己创建计划**：计划由人 `gugo goal create` 创建并 `approve`。批准前可只读检查或讨论计划，但普通工具审批模式（包括 `bypass`）不能授权新副作用。宿主在工具审批前与实际分发前复核绑定的计划 id/revision；计划已改版会停止旧操作，要求核对后开启新一轮。已确认的副作用结果不重做，结果未知时仍须先核实原操作。

人工确认仅来自可信的人操作入口，确认者按宿主身份记录；模型 `goal_step_update` 不能提交 `manual_confirm` 或伪造确认者。模型只能操作本会话的计划，并可携带 `expected_version` 防止覆盖新决定。`command` 验收支持精确 `command` 和 `cwd`，必须有已终结的成功退出；`file` 的路径与摘要必须来自同一输出记录。计划查询和记账不算任务实质完成，也不会清空失败反思状态。

### 记忆向量索引回填：`gugo memory reindex`

```powershell
gugo memory reindex [--limit 200] [--batch 8] [--all-agents | --agent <agentId>]
```

逐批把长期记忆里缺失/过期/换模型的向量补上（启用条件：`MEMORY_EMBEDDINGS_ENABLED=1` + endpoint，
否则返回 `MEMORY_EMBEDDINGS_DISABLED` 并以非零退出，避免脚本把空跑当成功）。
每批进度以一行 JSON（`{"event":"progress"...}`）输出，结束时输出 `{"event":"done"...}`。

**作用域是显式的**，因为以前它隐式且会谎报：默认只覆盖**全局记忆**；自动记忆可能属于某个 agent，
默认跑完会跳过它们却仍报 `ok:true`。现在：

- `--agent <id>`：该 agent + 全局；`--all-agents`：该用户全部记忆；两者互斥。
- 报告里带 `scope`（`global` / `agent` / `all_agents`）、`space`、`coverage`、`scanComplete`、`nextCursor`、`remaining` 和 `remainingIsExact`。`ok:true` 只表示本次没有操作错误；达到扫描/数量边界时仍可能是 `coverage:partial`，未知剩余量可以为 `null`，不能将部分覆盖当成全量完成。

向量空间区分端点协议/路径/参数、模型、显式 revision/维度；换空间或内容改变后，旧向量不参与跨空间相似度。词法候选与向量候选独立，再在同一 owner/Agent 范围合并。当前是有界 SQLite + JS 精确扫描，不是 ANN；大库可能报告部分覆盖。真实本地模型与隔离数据库的验证记录见 [接续记录](AGENT_HARDENING_CONTINUATION_2026-09-17.md)。

> 修复：`listMemoriesNeedingEmbedding` 以前先做 SQL `LIMIT` 再做 JS 陈旧度过滤，
> 积压大于一批时永远只会看到开头那批。现在按有界分页扫描到收集满为止。

### 真实模型回归基线：`npm run eval:live`

```powershell
$env:GUGO_LIVE_EVAL=1
npm run eval:live -- --dataset evals/starter-suite.json --output output/live-eval.json
npm run eval:live -- --dataset evals/starter-suite.json --baseline output/live-eval.json --repeat 3
```

- **必须显式授权**：`GUGO_LIVE_EVAL=1`，否则在启动任何任务前就拒绝。需要已配置的模型端点。
- **数据集指纹**：报告带 `fingerprint`，覆盖任务定义、验证器脚本**内容**和 fixture 工作区内容。
  换了验证器或改了一个夹具，指纹就变——这是防止“把验证器改绿”当成绩的前提。
- **基线对比**：`--baseline <report.json>` 输出 `baseline` 字段，区分 `regressions` / `fixes` /
  `metricDeltas`；指纹不一致时状态为 `not_comparable`（除非 `--allow-fingerprint-change`），
  退出码非零，不会拿陈旧基线给新结果背书。
- **重复运行**：`--repeat <1-5>`；任务只有在**每一次**都通过时才算 `passed`，并同时报告
  `passedRuns` / `passRate`，单次幸运通过不能变成绿。
- 退出码：`failed > 0` 或基线 `regressed` / `not_comparable` 时为 1。
- CI 不跑这条路径（无网络）；它是变更后手动执行的回归门。
- **版本化重规划**：`rewrite` 不改写旧步骤，而是创建 `revision+1` 并将旧计划置为 `superseded`，
  两个计划都留下 `plan.created` / `plan.superseded` 事件。
- 计划在**没有 `pending`/`in_progress`/`blocked` 步骤**时进入 `completed`；`skipped` 表示“不需要做”，
  其数量会记入 `plan.completed` 事件（`skippedSteps`），所以“完成”与“每步都 done”不会被混为一谈。
- 默认需要批准（`awaiting_approval`）；`--no-approval` 仅用于已授权的受限场景，不能在任意夹具中自动放行。

### HTTP / 网页端

`/api/goals/*` 与 CLI、loop 工具写的是**同一份**持久计划（规则全在 `goalPlanService`，路由只做 HTTP）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/goals/list?status=&sessionId=&limit=` | 列表（可按会话过滤） |
| GET | `/api/goals/show?planId=&eventLimit=` | 详情 + 事件时间线 |
| POST | `/api/goals/create` | `{objective, steps, sessionId?, requireApproval?}` |
| POST | `/api/goals/approve` | `{planId, expectedVersion?}` |
| POST | `/api/goals/step` | `{planId, stepId, status, evidence?, expectedVersion?}` |
| POST | `/api/goals/rewrite` | `{planId, objective?, steps, requireApproval?, expectedVersion?}` |
| POST | `/api/goals/prune` | `{planId?, keepPerPlan?}` |

错误用服务端错误码映射：`INVALID_INPUT→400`、`NOT_FOUND/STEP_NOT_FOUND→404`、
`INVALID_TRANSITION/PLAN_NOT_APPROVED/EVIDENCE_REQUIRED/EVIDENCE_ALREADY_USED/VERSION_CONFLICT→409`。

网页 `/goals` 面板（`SlashInlinePanelHost`）现在读/写这份服务端计划，不再是客户端勾选表：

- 展示目标、状态、`revision`、每步状态与**宿主核验标记**；`awaiting_approval` 时给“批准计划”（带 `expectedVersion`，冲突就失败而不是覆盖）。
- 可以创建目标、把步骤置为 `in_progress` / `blocked` / `skipped`、重新打开已完成步骤。
- **面板故意不能把步骤置为 `done`**：完成必须由 agent 引用一次宿主可核验的工具调用。它只提示这一点。
- 旧的客户端聊天 TODO 仍在面板底部（“更早的聊天目标”）展示，不丢数据。
- 区分两条路径：`/goals <目标>` 仍走 **Job**（持久多步执行 + 审批 + 检查点）；面板创建的
  **session 计划**会被下一轮的 loop 自动接管（挂载 `goal_*` 工具 + 注入 prompt）。

### 交互式会话：`gugo chat`

```powershell
gugo chat [--model <name>] [--provider <id>]
          [--mode normal|acceptEdits|plan|bypass]
          [--cwd <dir>] [--session-id <id>]
```

在一个终端里连续对话，不用记 `--resume <turnId>`：

- **同一 session 多轮**：每轮复用同一个 `sessionId`，历史从持久 Turn 事件重建。
- **实时进度与暂定正文**：工具调用/模型阶段写入 stderr；`assistant.delta` 正文在 stdout 以 `[assistant provisional]` 标注，私有 reasoning 不展示。只有运行时成功返回并完成清理后才标为 `[assistant confirmed]`；相同正文不重复打印，最终正文若改写则明确标为替换版本。失败、取消或关闭错误留下 `[assistant not confirmed]`，不能将部分回答当作成功结果。`gugo run --output text` 仍严格只输出成功终态正文，不启用此流式显示。
- **输入历史**：readline 的 Up/Down 保留最近 100 条输入；磁盘历史按本地 owner 分区保留最多 200 条，重启时载入最新记录。审批回答不进入聊天历史；空行、前导空格行和超过 8192 字符的行不写盘。设置 `GUGO_CLI_HISTORY=0` 禁止读写磁盘历史；原有未分区历史文件不会自动读取或删除。
- **Ctrl-C 请求取消当前轮**：首先显示 `turn cancellation requested`，等待运行时终态与清理；等待期间再次按 Ctrl-C 只显示 pending，不宣称已取消，也不启动下一轮。正常取消后保留会话，可用 `/exit` 离开。
- 如果取消期间发生执行、持久化或关闭错误（包括聚合错误），保留原错误并结束 chat，由 CLI 顶层错误处理输出原因和非零退出码；不把任意 `AbortError` 当作取消成功，也不继续消费排队提示。若取消与正常完成竞速，以运行时返回的实际终态为准。
- **同一时刻只开一个 readline**：一轮运行期间会话 readline 关闭，让审批/恢复提示安全占用 stdin
  （否则两个 readline 抢 stdin，审批会漏读）。

命令：

| 命令 | 作用 |
|---|---|
| `/help` | 命令列表 |
| `/draft` | 进入多行草稿；`/send` 整体提交，`/undo` 删除末行，`/discard` 放弃 |
| `/new` | 换一个全新 session |
| `/session [id]` | 查看/切换 session |
| `/sessions [offset]` | 分页列出当前本地 owner 的会话，每页 20 条，包含已归档会话，不依赖 HTTP 服务 |
| `/resume <session-id>` | 校验本地会话归属后续聊；下一条输入开始新 Turn，不恢复旧 Turn 的权限、模型或工作目录 |
| `/search <query> [--limit n] [--offset n] [--cursor token]` | 检索当前 owner/session 的持久消息；未查完时明确显示部分结果和续查游标 |
| `/attach <path>` | 为下一轮附加文件，支持带引号的空格路径 |
| `/attachments` | 列出待提交附件 |
| `/detach <index\|all>` | 只移除待提交引用，不删除原文件 |
| `/model [name]` | 读取当前本地配置后选择 Provider+模型；无参数时在支持的终端打开选择器 |
| `/mode [mode]` | 查看/切换权限模式 |
| `/cwd [dir]` | 查看/切换工作区 |
| `/plan` | 打印本会话的宿主核验计划（状态 / 每步 / 证据标记） |
| `/approve [planId]` | 批准本会话待批准的计划 |
| `/exit` / `/quit` | 离开 |

其他输入都当作下一轮 prompt。`gugo i` 是别名。


模型目录直接读取当前本地身份的配置，不依赖未认证 HTTP 发现。模型名自身带 `/` 时按完整名称匹配；同名模型需明确 Provider。目录缓存只用于显示，选择时重读配置和版本；禁用或改版不能被旧缓存绕过。模型选择器、审批、目录授权与恢复提示均先释放主输入，不会并发抢读 stdin。

`/search` 保留全文索引的远历史命中，并补中文子串、NFKC 全角/组合字符和 `%`/`_` 字面匹配。字面召回有行数/字符/时间预算；未完成时只显示结果下界，不能据此判断“没有匹配”。按输出的 `--cursor` 续查；数据库可见写入会保守使游标失效，需要重搜。游标绑定 owner/session/query，不是持续数据库快照。

`chat --timeout <ms>`（或 `GUGO_CLI_RUN_TIMEOUT_MS`）对**每个 Turn**单独计时；等待下一条输入时不计时。到期后取消当前执行及审批，等待清理完成，不自动重放附件或任务。纯协作超时时，`run` 退出 `124`，`chat` 显示 `CLI_RUN_TIMEOUT` 后允许下一轮；其余结果按下面的统一规则处理。Ctrl-C、外部取消与超时遵循先到的取消原因，后来的本地 deadline 不会覆盖前一个取消原因。

模型目录同时保留已保存的 Provider 和有效的命名环境 Provider。已配置的 `org/model` 裸名称按模型名精确匹配；未知、删除、禁用或未包含该模型的 `provider/model` 选择会在 CLI 拒绝，不回退到默认端点。未在目录声明的带 `/` 模型名须先配置后选择。

### deadline 与结果证据

到期是本地取消请求，不是改写运行时终态的授权。`run`（text/jsonl）与 `chat` 使用同一判定：

| 运行时证据 | 到期后的处理 |
|---|---|
| 返回成功，且有一致、完整的 `turn.completed`（回调或返回的 `lastEvent`） | 保留正文和成功结果；`run` 退出 `0`，stderr 提醒 deadline 已过 |
| 明确不完整、failed、blocked、interrupted、未知请求/副作用等 | 保留具体状态、诊断和非成功结果，不改成 `124`；不自动重放 |
| 只有普通 cancelled / 抛出本次 deadline 原对象，没有更具体终态 | `CLI_RUN_TIMEOUT`；`run` 退出 `124`，`chat` 可继续下一轮 |
| 到期后声称成功，却没有 completed 终态证据 | `CLI_RUN_TERMINAL_MISSING`，不输出成功正文 |
| 成功与失败/取消的最终证据互相矛盾，或 completed 后又抛出本次 deadline | `CLI_RUN_OUTCOME_CONFLICT`，不把矛盾输出当成成功 |
| 真正的持久化、清理、未知请求或聚合异常 | 保留原异常，不凭 `AbortError` 名称、相同错误码或嵌套 cause 猜成超时 |

没有 deadline 时，历史 bare-status 嵌入式 runtime 的兼容行为不因本次缺证据检查收紧，但真实终态矛盾不能算成功。`text` 的 stdout 仍是确认成功的结果通道；JSONL 保留原始事件和末尾 `cli.error`，消费者必须检查完整流和退出码。chat 的即时文本标为 provisional，失败/冲突时不能将其视为已确认答案。恢复仅返回持久化 `lastEvent`、没有回调重放时，formatter 补输出原事件一次，不凭状态字段编造 completed。

同一 attempt 的首个最终事件不会被后到的 waiting、awaiting_approval、paused 或 blocked 抹掉；文本缓冲与终态判定遵循同一有效结果，因此既保留完成正文，也保留具体失败诊断。只有显式 `turn.attempt` 且 `resetStreaming: true` 才清除上一 attempt 的证据和待输出文本。结果与完成事件两边都明确提供 `sessionId` / `turnId` 时必须一致；没有提供身份的旧接口不会仅因缺字段被拒绝。

### 可回退输入层

输入模式使用 `GUGO_CLI_INPUT=readline`（默认）或 `GUGO_CLI_INPUT=ink`。旧配置 `auto` 仅作为 **readline 的兼容别名**保留，始终选择 readline，不做 TTY/Node 能力自动判断。显式 `ink` 启用可选 Ink 7 多行输入，要求 Node.js 22+ 和真实 TTY；Node.js 20 继续使用 readline。Ink 支持完整字素编辑、CJK/emoji 显示宽度、终端 resize、Ctrl+J 换行和 bracketed paste；其历史/Tab 补全尚未与 readline 等价，因此不会自动成为默认。渲染/提交失败不会隐式重放草稿。

供嵌入调用的两种 `InputEditor` 使用同一生命周期契约：`question(prompt, { signal } = {})` 同时最多等待一个问题，重入返回 `CLI_INPUT_BUSY`，不是排队多个问题。单次 signal 取消返回 `null`、丢弃未提交输入并解除本次监听；可以用新的 signal 继续下一问。创建输入器时的全局 signal 取消或 `close()` 则清空队列并永久结束读入。EOF 不再读取或重开终端，不提交半行草稿，但 EOF 前已完整提交的排队行仍可读完，之后返回 `null`。`clear()` 丢弃草稿并将待回答问题结算为 `''`；`suspend()` 结算为 `null` 并释放终端、丢弃未提交草稿，下一问从空草稿开始。readline 已接收的完整行队列仍属于后续聊天，不会交给审批读取器。键盘取消与单次 signal/EOF 分开处理，不会把外部取消当成 Ctrl-C 重新挂载。

模型目录只使用 `interactiveModelCatalog` 的结构化 Provider/model 数据：`list()`、`entries()`、`diagnostics()` 是同步快照，`refresh()` 异步刷新，`select()` 重新核实当前配置，`close()` 结束目录生命周期。chat 在装配时校验这个真实契约；缓存仅用于显示，不是选择授权。

开发工作树可运行 `node tools/inkProbe.mjs` 做两轮真实终端探针；`--self-check` 只检查纯模型，不能代替实体键盘、IME 或全部终端验收。

readline 多行文本请先输入 `/draft`，等到 `draft>` 再粘贴。空行、缩进及普通 slash 文本均保留；只有独占一行且无额外空格的 `/send`、`/undo`、`/discard` 是草稿操作。正文需要以 `/` 开始时可用 `//` 转义，例如 `//send` 变成正文 `/send`。`/send` 将整个非空草稿提交为一个 Turn；空草稿不会提交，Ctrl-C 或 EOF 放弃草稿。编辑当前行使用 readline 键位，已加入草稿的末行用 `/undo` 移除后重输。

默认 readline 尚未实现 bracketed-paste 自动识别、外部编辑器或运行中 steering/RPC。其普通提示符直接粘贴多行仍是多个输入，不要用它代替 `/draft`；可选 Ink 的粘贴语义单独按上述探针验证。运行期间不要预输入审批：每次打开审批/恢复读取器前会丢弃 stdin 已缓冲的输入；chat 已接收的排队行只属于后续聊天，不会传入审批。只在对应确认提示出现后作答。此边界不声称能识别终端尚未交付、随后才到达的粘贴字节。

**非 TTY 下拒绝运行**（`CLI_INTERACTIVE_REQUIRES_TTY`，并提示用 `gugo run`）：管道输入无法知道提示符
从未出现，静默挂死比报错更糟。带位置 prompt（`gugo chat hello`）或 `--resume` 会被拒绝并说明原因。

**其他模式对照**：`gugo run --output text|jsonl` = print / json-event 模式；
库模式 = 直接 `import { runHeadlessTurn }`（`server/services/headlessTurnRuntime.js`）或
`cmdRun` / `cmdChat`（`bin/yma-cli.js`），不需要起 HTTP；目前没有 JSON-RPC 传输层。

### 隔离演示环境

```powershell
npm run cli:demo:prepare -- --all --root output/cli-demo/run1
npm run cli:demo:verify  -- --root output/cli-demo/run1
```

`prepare` 会复制 `evals/starter-suite.json` 的工作区到可丢弃目录，并创建独立的运行时数据、产物与日志目录；`verify` 证明解析出的 `APP_DATA_DIR` / `APP_DB_PATH` / `ARTIFACT_DIR` 都落在隔离根目录内、不会指向用户真实数据，并且任务工作区里的 `.env` 无法接管可信运行时。验收脚本位于 `evals/verifiers/`，**不在**模型可修改的工作区内。请从仓库根目录运行 CLI，让运行时 cwd 与 `--cwd` 保持分离。

## 运行一次任务

最简调用：

```powershell
gugo run "检查当前项目并报告测试失败原因"
```

也可从标准输入读取最多 1 MiB 的 UTF-8 Prompt：

```powershell
"检查当前项目并报告测试失败原因" | gugo run
```

非 TTY 标准输入始终会被读取。位置 Prompt 与管道内容同时存在时，CLI 将位置 Prompt 作为指令放在前面，再用一个空行连接管道内容，例如：

```powershell
git diff | gugo run "审查这些改动"
```

这会把审查指令和完整 diff 一起交给 Turn。`--resume` 只恢复已持久化的未完成 Turn，不能再附加位置 Prompt 或非空管道内容；冲突以退出码 `2` 结束。

完整语法：

```text
gugo run "<prompt>" [--model <name>] [--provider <id>]
                      [--mode normal|acceptEdits|plan|bypass]
                      [--cwd <dir>] [--session-id <id>]
                      [--timeout <ms>]
                      [--output jsonl|text] [--progress]

gugo run --resume <turnId> [--session-id <id>] [--cwd <dir>]
                           [--timeout <ms>]
                           [--output jsonl|text]
```

| 选项 | 行为 |
|---|---|
| `--model <name>` | 为新 Turn 选择模型名称 |
| `--provider <id>` | 为新 Turn 选择已持久化的 Provider ID |
| `--mode <mode>` | 为新 Turn 选择本次权限模式，默认 `normal` |
| `--cwd <dir>` | 选择本次执行的工作目录；路径必须存在且是目录 |
| `--session-id <id>` | 指定新 Turn 所属的会话 |
| `--resume <turnId>` | 从持久化状态恢复一个未完成 Turn，不能组合新 Prompt 或附件 |
| `--file <path>` / `--image <path>` | 可重复；合计最多 8 个、每个最多 10 MiB；由认证后的宿主存入受管理附件再传 ID |
| `--timeout <ms>` | 限制 Turn 执行时间；到期后安全取消并以退出码 124 结束 |
| `--output jsonl\|text` | 选择 stdout 输出格式，默认 `jsonl`；值不区分大小写 |
| `--progress` | 将简洁的事实性进度写入 stderr（复用 Turn 事件），不影响 stdout 契约；不带值 |
| `--` | 其后的值一律作为 Prompt 文本，不再解析为选项 |

同一个单值选项不能重复。未知选项、空选项值和既无 Prompt 也无附件的调用以退出码 `2` 失败。允许仅附文件的 run；宿主补充“请分析附件内容”的新任务提示，绝不用于 resume。

附件路径按选定工作目录解析，图片/PDF 校验内容签名及当前模型能力；不支持时发模型请求前拒绝。`--resume` 与附件冲突在 argv 阶段报 `CLI_RESUME_ATTACHMENT_CONFLICT`，不先读 stdin 或文件。原文件不被修改或授予父目录权限；字节、摘要、owner/session 和 message ID 由受管理存储绑定，不能靠模型参数伪造。自定义持久化/附件后端必须提供匹配的上传端口，不能偷偷回退写入本地 SQLite。

chat 启动附件和 `/attach` 队列仅作用于下一轮。提交（含失败）、取消、丢弃草稿或切换会话后清空待提交引用；使用普通空行可提交仅含附件的分析任务。附件准备失败会清理本次未绑定的上传；已经原子绑定到消息的回执（包括结果未知）保留，不随清理删除。

### 权限模式

| 模式 | 行为 |
|---|---|
| `normal` | 文件修改、命令和外部副作用按策略请求审批 |
| `acceptEdits` | 已授权的本地文件编辑自动继续；命令和外部副作用仍请求审批 |
| `plan` | 只提供本地只读工具，不执行修改或其他副作用 |
| `bypass` | 跳过操作审批；只应用于完全可信的本机环境 |

权限模式仅作用于当前用户、会话和 Turn，不修改账户的长期权限设置，也不会泄漏给并行任务。账户权限在执行中收紧时，本次任务也会收紧；恢复检查点不能借此扩大原有权限。

当 stdin 和 stderr 都连接到 TTY 时，CLI 可在 stderr 显示单次工具审批问题。非交互运行不会等待人工输入，仍需人工审批的操作会保守拒绝；显式 `bypass` 不会仅因没有 TTY 就退回 `normal`。`bypass` 不会跳过产物校验、检查点持久化或执行所有权检查。

拒绝、过期、取消、授权身份不可核实和未知结果会停止本批后续工具及自动模型收尾，并保留已确认结果。`bypass` 不代表目标计划已获批准，也不能覆盖用户的明确只读约束。子代理继承这些约束；不支持逐工具治理的 opaque Provider 在无法维持边界时明确拒绝，不静默更换执行方式。

明确“不调用工具、仅回复”的当前用户指令在网页、`run` 和 `chat` 共用同一边界，不会被“网页/PDF”等正文关键词变成产物任务。该轮不向模型开放工具，违规提案在审批和执行前拒绝，旧动态工具也不能通过恢复重新开启。相反，“运行测试，然后只回复 PASS”是输出格式要求，不会取消真实测试；限定外部工具、显式例外和引用材料不等于全局禁工具。已知回执和未知结果仍保留各自事实。

目录访问也在当前终端确认：CLI 显示规范化的完整路径、只读或读写权限及用途，输入 `y` 后继续原 Turn。新增授权仅用于本次 CLI 运行，不修改账户权限设置；已经存在的持久授权不会被改写。任务在确认期间已取消或被其他进程恢复时，旧确认会被拒绝。

真正的 `SIDE_EFFECT_OUTCOME_UNKNOWN` 不是普通审批。CLI 会显示当前工具、目标和可用错误证据，然后提供 `1`（已核实未发生）、`2`（已核实完成）或回车（暂不处理）。不需要复制工具 ID，系统将选择绑定到当前操作；普通 `y` 不代表核实了未知结果。确认后在原 Turn 继续，已完成的操作不会重做。自定义持久化宿主须显式提供受控恢复能力，CLI 不会回退到其他数据库。

### 图形界面中的确认

网页和桌面聊天中的工具审批、目录授权直接在当前对话内处理。结果未知的操作也使用消息内的确认卡片，展示具体工具、目标和可用错误证据，无需跳到设置页或手工复制工具 ID。用户核实后可选择“未执行”或“已完成”并继续原任务，也可以暂不处理。

运行中请求目录时，卡片保留本次请求的只读或读写权限，默认临时授权；只有主动选择永久保留才新增持久授权。也可以选择“拒绝并取消本轮”，已完成的正文和文件会保留。拒绝绑定原始暂停序号，不会取消其他窗口已经恢复的执行。

确认仅绑定当前用户、会话、工具调用及事件边界；取消任务、切换账户或其他进程已经恢复任务后，旧确认不能再次启动操作。确认已经保存但页面刷新或响应丢失时，卡片可读回已保存的确认，并提供显式的“继续原任务”按钮；读取记录不会自动重复提交或执行。

### 自动验证与修复

文件修改完成后，如果仅缺少精确路径的读回验证，内核会在同一 Turn 中通过普通工具执行链调度只读检查，不需要为补做这一步再输入 `--resume`。检查仍受当前权限、工具范围和执行预算约束，不会为了验证现有文件而自动重跑生成脚本。

产物格式损坏时，真实校验失败会反馈给模型；修复后必须用新产物的验证凭据才能交付。命令退出码为 `0` 或模型声称“完成”，都不能代替文件校验。

未配置的项目检查返回 `PROJECT_CHECK_NOT_CONFIGURED`、`executed:false` 和 `availableChecks`，不会把未运行的 lint 记为待修复测试。Shell 回执额外保存实际执行前的绝对 `executionCwd`，用于目标目录证据；原显示 `cwd` 不变，命令内部 `cd` 后的位置不冒充入口目录。保留函数名/API 的局部要求不会自动把独立代码修改任务降为整轮只读，但审批与其他全局禁令仍然有效。

### 恢复 Turn

```powershell
gugo run --resume <turn-id>
```

如果当前持久化适配器不能仅凭 Turn ID 唯一确定会话，则同时传入：

```powershell
gugo run --resume <turn-id> --session-id <session-id>
```

恢复会使用已持久化的模型、Provider 和权限模式，因此 `--resume` 不能与 Prompt、`--model`、`--provider` 或 `--mode` 组合。`--cwd` 和 `--session-id` 可用于定位恢复环境。

交互恢复遇到待授权目录或待核实操作时，会先在终端展示该请求，收到确认后才继续；不会先重试未知操作再询问。非交互运行或选择暂不处理时仍返回结构化暂停/阻断结果。

## `run` 输出契约

`--output` 只接受 `jsonl` 或 `text`，默认值为 `jsonl`。无效值以 `CLI_OUTPUT_INVALID` 和退出码 `2` 结束。两种模式都把交互审批问题、信号提示等面向人的运行诊断写入 stderr。

`--progress` 在 stderr 额外输出简洁的事实性进度行（前缀 `[gugo]`），内容直接来自 Turn 事件：`turn started`、`model <phase>`、`tool <name> started/finished/failed`、`progress <n>/<m>`、`approval required/approved/denied`。它不输出私有推理、不预告未经宿主提交的完成，也不向 stdout 写任何东西，因此 JSONL/文本管道契约不变。终态诊断仍由下面的终态处理输出，不会重复。

### JSONL 模式

`gugo run ... --output jsonl` 的 stdout 只包含 JSONL：每一行都是一个完整 JSON 对象，对应一个经过客户端投影的持久化 TurnEngine 事件。进度、工具调用、审批和终态会按事件顺序输出。省略 `--output` 时行为相同。

交互确认期间可以先出现 `turn.paused` 或 `turn.blocked`，确认后继续产生同一 Turn 的恢复和完成事件。判断最终结果时应同时等待 CLI 退出并检查最后的状态，不能把中途的暂停当作最终失败。授权提示始终写入 stderr。

成功结果示意：

```jsonl
{"type":"turn.started","sessionId":"...","turnId":"...","sequence":0,"payload":{}}
{"type":"turn.completed","sessionId":"...","turnId":"...","sequence":4,"payload":{"text":"任务完成"}}
```

脚本应读取 `turn.completed` 的 `payload.text`，不要把 stdout 当作纯助手文本。失败时 stdout 仍保持 JSONL，并可能包含：

```jsonl
{"type":"cli.error","error":{"code":"MODEL_CONFIG_MISSING","message":"no configured model","action":"configure_model"}}
```

CLI 在 Turn 建立前发生的失败，或执行中无法提交持久化终态的失败，会把稳定的 `cli.error` JSON 对象写入 stdout，同时把可读错误诊断写入 stderr；这不会破坏 stdout 的逐行 JSON 解析。

本地执行已经结束但最终读回仍没有持久化终态时，CLI 会以退出码 `1` 返回原始运行时错误；若原错误已不可取得，则返回 `TURN_TERMINAL_EVENT_MISSING`，不会继续无限轮询。失去执行租约的进程不能伪造 `turn.completed` 或 `turn.failed`；已经提交的真实终态则优先于旧进程的退出错误。连接仍在运行的远程任务不受此本地结束检查影响。

PowerShell 中提取最终文本：

```powershell
gugo run "只回复 ok" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object type -eq 'turn.completed' |
  ForEach-Object { $_.payload.text }
```

### 文本模式

面向人或只需要最终答案的调用可使用：

```powershell
gugo run "只回复 ok" --output text
```

文本模式遵循以下管道契约：

- 只有 Turn 最终以 `turn.completed` 且退出码为 `0` 结束时，stdout 才写入 `payload.text`；非空文本末尾会补一个换行。
- 进度事件、工具调用、审批事件和中间内容不会写入 stdout。
- `turn.failed`、`turn.blocked`、`turn.cancelled`、`turn.paused` 或 `turn.interrupted` 等非成功终态不会泄漏部分结果到 stdout；stdout 保持为空，终态诊断写入 stderr。
- CLI 在 Turn 建立前发生的错误同样只写入 stderr，stdout 保持为空。

因此，脚本需要完整事件和机器可读错误时应使用默认 JSONL；只希望在成功时捕获最终文本时可使用 `--output text`。

## 中断与关闭

自动记忆提取属于可选的终态后处理。Headless Runtime 关闭时会取消尚未开始或仍在进行的自动提取，不等待额外模型请求；迟到的提取结果不会写入记忆。完整会话消息、Turn 终态和检查点仍正常保存，显式 `remember` 工具不受影响。网页服务正常运行期间仍照常自动提取记忆。

运行期间第一次收到 `SIGINT` 或 `SIGTERM` 时，CLI 会：

1. 在 stderr 说明正在取消当前 Turn；
2. 请求 TurnEngine 取消正在运行的模型或工具工作；
3. 等待持久化的 `turn.cancelled` 终态；
4. 停止 Headless Lifecycle 并释放持久化 lease。

`Ctrl+C` 对应 `SIGINT`。如果优雅取消未在 5 秒内完成，CLI 会按该信号的退出码强制退出；等待期间再次收到信号也会立即强制退出。

即使取消流程本身完成，原始信号退出码仍会保留：`SIGINT` 为 `130`，`SIGTERM` 为 `143`。

## 退出码

| 退出码 | 含义 |
|---:|---|
| `0` | 命令成功，或 `run` 以 `turn.completed` 结束 |
| `1` | HTTP、认证、模型、运行时或持久化失败；`run` 以非 completed 终态结束 |
| `2` | 命令或参数用法错误、缺少 Prompt、选项值无效 |
| `130` | 收到 `SIGINT`，包括完成优雅取消后的退出 |
| `143` | 收到 `SIGTERM`，包括完成优雅取消后的退出 |

JSONL 自动化调用应同时检查退出码和终态。退出码 `1` 可能对应 `turn.failed`、`turn.blocked`、`turn.cancelled`、`turn.paused` 或 `turn.interrupted`；具体原因以最后一个 Turn 事件或 `cli.error.error.code` 为准。文本模式应检查退出码；失败时 stdout 按契约保持为空，原因见 stderr。

## 安全边界

- `GUGO_SERVER_URL` 不接受 URL 内嵌凭据；HTTP token 按完整规范化服务 URL 隔离，且只通过 Authorization Header 发送。
- `gugo run` 使用本地 Headless Runtime，不读取或复用 HTTP token。
- `--cwd` 是本次 CLI 进程的工作区选择，不会让项目目录中的 `.env` 选择可执行的持久化宿主模块。
- `bypass` 会放行高风险操作，不应在共享机器、多用户服务或不可信项目中使用。
- 管道运行没有交互审批能力；需要人工审批时应在 TTY 中执行，或选择更保守的任务范围。
