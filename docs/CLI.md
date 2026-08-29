# Gugo CLI

Gugo 提供 `gugo` 命令行入口，旧名称 `yma-cli` 仍作为兼容别名。CLI 可连接已运行的 Gugo 服务管理登录与基础资源，也可在不启动 HTTP 服务或浏览器的情况下运行一个持久化 Agent Turn。

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
| `gugo run ...` | JSONL 或文本 | 在当前进程运行或恢复一个持久化 Turn |

`-h` 等价于 `--help`，`-V` 等价于 `--version`。不带参数时也会显示帮助。

除 `run` 的独立参数解析外，带值选项同时接受 `--name value` 和 `--name=value`。未知选项、重复选项和多余位置参数均以退出码 `2` 结束。

## 服务地址

除 `run` 外，登录、验证、列表、状态和诊断命令都通过 HTTP 访问 Gugo 服务。默认地址为：

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

`GUGO_CLI_RUN_TIMEOUT_MS` 是可选的 Turn 执行超时，单位为毫秒；命令行 `--timeout <ms>` 优先于环境变量。两者都只接受 1–2147483647 的十进制整数，未设置时不限制。到期后 CLI 会请求取消 Turn，等待持久化终态和运行时清理，再以 `CLI_RUN_TIMEOUT` 与退出码 `124` 结束。

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
gugo doctor
```

`doctor` 请求需要认证的 `GET /api/health/full`，因此会使用 token 或尝试本地模式自动 bootstrap。模型诊断按该登录用户的默认 Agent binding 判断，与真实 `run` 启动前的 readiness 门禁保持一致。`model.configured` 只表示模型配置存在；`model.agentReady` 表示默认 binding 已通过 Agent、工具调用和最近一次 Provider 探测要求。未就绪时，`model.readinessCode` 与 `model.code` 返回同一个稳定错误码，`model.action` 返回稳定修复动作；未配置固定为 `MODEL_CONFIG_MISSING` / `configure_model`。响应不会列出缺失的 `MODEL_*` 环境变量名、密钥或服务端本地化文案。

只有数据库正常且 `model.agentReady: true` 时，完整健康端点才返回 HTTP `200`、`ok: true`，`doctor` 退出 `0`；已配置但 Provider 未验证、不可用或仅支持聊天也会返回 HTTP `503`、`ok: false`，`doctor` 退出 `1`。CLI 会把 `503` 的诊断 JSON 完整写到 stdout，便于自动化保存故障证据。

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
                      [--output jsonl|text]

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
| `--resume <turnId>` | 从持久化状态恢复一个未完成 Turn |
| `--timeout <ms>` | 限制 Turn 执行时间；到期后安全取消并以退出码 124 结束 |
| `--output jsonl\|text` | 选择 stdout 输出格式，默认 `jsonl`；值不区分大小写 |
| `--` | 其后的值一律作为 Prompt 文本，不再解析为选项 |

同一个单值选项不能重复。未知选项、空选项值和无 Prompt 调用均以退出码 `2` 失败。

### 权限模式

| 模式 | 行为 |
|---|---|
| `normal` | 文件修改、命令和外部副作用按策略请求审批 |
| `acceptEdits` | 已授权的本地文件编辑自动继续；命令和外部副作用仍请求审批 |
| `plan` | 只提供本地只读工具，不执行修改或其他副作用 |
| `bypass` | 跳过操作审批；只应用于完全可信的本机环境 |

当 stdin 和 stderr 都连接到 TTY 时，CLI 可在 stderr 显示单次工具审批问题。非交互运行不会等待人工输入，危险操作会保守拒绝。

### 恢复 Turn

```powershell
gugo run --resume <turn-id>
```

如果当前持久化适配器不能仅凭 Turn ID 唯一确定会话，则同时传入：

```powershell
gugo run --resume <turn-id> --session-id <session-id>
```

恢复会使用已持久化的模型、Provider 和权限模式，因此 `--resume` 不能与 Prompt、`--model`、`--provider` 或 `--mode` 组合。`--cwd` 和 `--session-id` 可用于定位恢复环境。

## `run` 输出契约

`--output` 只接受 `jsonl` 或 `text`，默认值为 `jsonl`。无效值以 `CLI_OUTPUT_INVALID` 和退出码 `2` 结束。两种模式都把交互审批问题、信号提示等面向人的运行诊断写入 stderr。

### JSONL 模式

`gugo run ... --output jsonl` 的 stdout 只包含 JSONL：每一行都是一个完整 JSON 对象，对应一个经过客户端投影的持久化 TurnEngine 事件。进度、工具调用、审批和终态会按事件顺序输出。省略 `--output` 时行为相同。

成功结果示意：

```jsonl
{"type":"turn.started","sessionId":"...","turnId":"...","sequence":0,"payload":{}}
{"type":"turn.completed","sessionId":"...","turnId":"...","sequence":4,"payload":{"text":"任务完成"}}
```

脚本应读取 `turn.completed` 的 `payload.text`，不要把 stdout 当作纯助手文本。失败时 stdout 仍保持 JSONL，并可能包含：

```jsonl
{"type":"cli.error","error":{"code":"MODEL_CONFIG_MISSING","message":"no configured model","action":"configure_model"}}
```

CLI 在 Turn 建立前发生的失败会把稳定的 `cli.error` JSON 对象写入 stdout，同时把可读错误诊断写入 stderr；这不会破坏 stdout 的逐行 JSON 解析。

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
