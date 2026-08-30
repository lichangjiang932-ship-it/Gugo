# 分层运行配置

Gugo 支持以下配置层，后面的层覆盖前面的层：

1. `server-data/runtime.json`：当前安装的用户级默认值；
2. `.gugo/runtime.json`：可随项目共享的非敏感配置；
3. `APP_CONFIG_PATH`：显式指定的本地 JSON 配置；
4. `.env`：兼容现有安装；
5. 系统环境变量：部署平台的最终覆盖。

JSON 可以直接写环境变量键，也可以放在 `env` 对象中：

```json
{
  "env": {
    "AUTH_MODE": "local",
    "WORKSPACE_FS_ENABLED": true,
    "WORKSPACE_GIT_ENABLED": true,
    "JOB_RUNTIME_CONCURRENCY": 4,
    "MEMORY_INJECT_TOKEN_CAP": 800
  }
}
```

配置键必须使用大写环境变量形式，值必须是字符串、数字、布尔值或 `null`。包含 API key、token、secret、password、credential 或 private key 的键会被拒绝；模型密钥继续使用系统环境变量、`.env` 或现有的用户凭据库。

`npm run serve` 与直接执行 `node server/appServer.js` 都会经过同一个共享启动器，在加载应用宿主前完成配置 preflight，并把同一份运行环境传入后端。

`GUGO_TURN_PERSISTENCE_MODULE` 可在进程启动前替换完整的 Turn 持久化适配器；相对路径按启动目录解析。生产服务与 Vite 开发宿主只从宿主进程环境或部署根 `.env` 读取它；`GUGO_LOAD_DOTENV=0` 时不会读取 `.env`。CLI 可能从不可信项目目录启动，因此只接受进程环境中的该配置，明确忽略当前目录 `.env` 对 persistence 模块与信任根的选择。所有入口都禁止由用户级 `runtime.json`、普通插件库存或数据库状态选择该模块。该模块会作为受信任代码在宿主进程内执行，不属于普通运行时插件。默认只允许加载启动目录内的普通文件；需要收窄或另设部署目录时，用 `GUGO_TURN_PERSISTENCE_TRUST_ROOT` 指定可信根目录。模块必须导出 `turnPersistenceAdapter` 或默认导出，并完整实现当前 Turn persistence contract；路径、导入或契约校验失败时启动会 fail-closed，不会静默回退 SQLite。可信根只约束入口文件，不能限制该模块主动导入或执行的其他代码，因此必须把它视为与宿主同权限的部署组件。

Turn 事件默认写入 SQLite。若事件写入和数据库内的失败日志同时不可用，运行时会把完整失败事件与 checkpoint 状态追加到权限受限的 `server-data/turn-emergency-failures.jsonl`；主数据目录也不可写时会回退到系统临时目录。生产部署可用 `TURN_EMERGENCY_FAILURE_LOG_PATH` 指向独立可写卷，并将该文件纳入本地备份与访问控制。

## 独立 Hub 进程

运行 `npm run hub` 会自动启用独立 Hub。直接执行 `node server/hub/index.js` 或从其他宿主调用 `startHubProcess` 时，只有 `HUB_ENABLED=1` 才会启动；其他值会安全退出且不加载 Hub 数据库运行时。

Hub 当前读取以下运行参数：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HUB_TICK_MS` | `30000` | 队列调度间隔（毫秒），最小 `100`。 |
| `HUB_LEASE_MS` | `30000` | 作业租约时长（毫秒），最小 `300`；活动作业会在到期前续租。 |
| `HUB_SHUTDOWN_TIMEOUT_MS` | `10000` | 关闭时等待活动作业完成的时长（毫秒），必须为正整数。 |

无效值会回退到对应默认值。关闭等待超时后，Hub 会中止当前执行，并等待最后一份租约证明失效后再关闭数据库，避免已失去所有权的处理器提交终态。

## 可选 Codex app-server 互操作

Codex app-server 桥接默认关闭。只有把 `CODEX_APP_SERVER_ENABLED` 去除首尾空白后的值显式设为 `1`，Gugo 才会发现、校验并启动外部 OpenAI Codex CLI 的 `app-server` 子进程；未设置、`0` 或其他值都保持禁用。安装了 Codex CLI、设置 `GUGO_CODEX_CLI_PATH` / `CODEX_CLI_PATH`，或能够从 `PATH` 找到它，均不会自行启用桥接。

```dotenv
CODEX_APP_SERVER_ENABLED=1
# GUGO_CODEX_CLI_PATH=C:\Users\you\AppData\Local\OpenAI\Codex\bin\codex.exe
# CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS=15000
```

启用并完成握手后，Agent Loop 才会看到 `codex_models` 工具。该工具只发送固定的 `model/list` 请求，参数限定为分页游标、1–50 的数量与是否包含隐藏模型；返回值会经过字段白名单裁剪。Gugo 不开放任意 app-server JSON-RPC，也不把 account、config、thread、turn、command 等方法交给模型。每次调用仍需用户逐次批准，且受用户工具开关、独立限流和工具审计约束。

启用后会增加一个外部子进程与相应资源、协议和供应链边界。`model/list` 也可能让 Codex CLI 根据自身登录态和配置访问网络；Gugo 不把此桥接视为离线能力，也不代替 Codex CLI 自身的隐私与网络配置。要求完全本地或离线运行时，不要设置该开关（或设为 `0`）。桥接关闭、未就绪或启动失败时 `codex_models` 不会进入模型工具清单，也不会影响 Gugo 原生代码工具。

## 认证模式与模型凭据

### 默认本机模式：`AUTH_MODE=local`

`AUTH_MODE` 未设置时默认为 `local`。该模式面向一台电脑上的单个可信使用者：浏览器首次打开应用时，服务端会自动选择或创建一个本地所有者并建立会话，不要求注册、邮箱验证码或密码。

Gugo 不附带任何可用的模型 API Key。本地所有者进入“设置 → 模型”后，可添加自己的 OpenAI 兼容、Anthropic、Gemini、Ollama 或 LM Studio Provider。模型 API Key 和自定义请求头会加密保存在服务端；也可以通过 `.env` 配置服务端默认模型。公开的 `/api/health` 只检查服务和数据库 liveness，不要求模型已配置；模型 readiness 请看需认证的 `/api/health/full` 或“设置 → 系统诊断”。

删除 Provider 时，服务会先拒绝仍被任务、子代理或演进证据引用的配置；允许删除后，SQLite 使用 `secure_delete` 覆写已删除单元，并在删除前后截断 WAL。该操作只覆盖当前权威数据库及其 WAL，不会追溯清除用户自行复制的备份、磁盘快照或导出包；这些副本必须按各自的保留策略单独删除。

未配置 `CREDENTIAL_ENCRYPTION_KEY` 时，服务会在数据库旁生成 `.credentials.key`，并在每次首次使用前把它限制为仅当前 OS 用户可访问。若 chmod 或 Windows ACL 加固失败，凭据读写会以 `CREDENTIAL_VAULT_KEY_PERMISSIONS_UNSAFE` 拒绝继续；服务不会删除已有密钥，也不会在弱权限下读取它。请修复密钥文件权限后重试，或注入一个 32 字节（64 位十六进制或 Base64）的 `CREDENTIAL_ENCRYPTION_KEY`。密钥与数据库必须一并备份，丢失密钥后已有密文无法恢复。

本机建议配置：

```dotenv
AUTH_MODE=local
SERVER_HOST=127.0.0.1
```

`local` 是便利模式，不提供多用户身份边界。不要把它用于共享服务器、局域网或公网部署。

### 推理态跨轮保留（chain-of-thought replay）

工具调用循环里，模型在上一条 assistant 消息中捕获的推理（`reasoning_content`）会默认回传给同一 provider，用于提升多步任务收敛。默认对 OpenAI 兼容 provider（ollama / lmstudio / llamacpp / vllm / openai-compatible）开启；对 Anthropic / Gemini 原生关闭，因为它们用 thinking / thought 块表达推理，会拒绝 `reasoning_content` 字段。

```dotenv
# 显式 1 对原生 provider 也强制开启；显式 0 全程关闭。
# MODEL_REASONING_RETENTION=1
```

回传仅命中已捕获推理的 assistant 消息（即 provider 本就支持该字段），因此 OpenAI 兼容端点可安全往返；未解锁该能力时可在 `.env` 设 `MODEL_REASONING_RETENTION=0`。

### 非回环暴露保护

`AUTH_MODE=local` 只允许有效监听地址为回环地址（`127.0.0.0/8`、`localhost` 或 `::1`）。服务启动时会检查实际对外暴露地址：普通部署检查 `SERVER_HOST`，Compose 部署还会考虑宿主机的 `DOCKER_BIND_ADDRESS`。如果本地免登录模式将监听或发布到非回环地址，服务默认拒绝启动，而不只是打印提示。

正确做法是改用多用户认证：

```dotenv
AUTH_MODE=multi_user
SERVER_HOST=0.0.0.0
```

Docker 跨设备访问还需设置 `DOCKER_BIND_ADDRESS=0.0.0.0`，并配置 SMTP；公网部署还需 HTTPS、防火墙和可信反向代理。

仅在外层已有独立且经过验证的访问控制、并完全理解“任何能连接的人都将成为本地所有者”的风险时，才可使用危险覆盖：

```dotenv
AUTH_MODE=local
SERVER_HOST=0.0.0.0
ALLOW_INSECURE_LOCAL_AUTH=1
```

只有精确值 `1` 会放行；服务会输出 `HIGH RISK` 警告。该开关不会增加密码、用户隔离、TLS 或请求鉴权，也不是 `multi_user` 的替代品。不要在普通局域网、端口映射、隧道或公网环境中使用。

### 多用户模式：`AUTH_MODE=multi_user`

局域网共享、公网服务或任何多人使用场景都必须显式设置：

```dotenv
AUTH_MODE=multi_user
```

该模式启用邮箱验证码/密码登录，并按用户隔离模型 Provider、Agent、记忆、任务、连接器和其他服务端资源。局域网或公网部署必须配置真实 SMTP；未配置 SMTP 时验证码会出现在响应中，只允许回环地址上的开发调试。公网还必须使用 HTTPS、防火墙、可信反向代理、限流和固定的 `APP_PUBLIC_URL`。

### 从既有账户选择本地所有者

从旧版或 `multi_user` 切换到 `local` 时，服务会尽量保留既有数据归属：

- 数据库只有一个用户时，自动采用该用户；
- 尚未确定本地所有者且浏览器携带有效旧会话时，采用该会话对应用户；
- 已记录本地所有者后，其他旧 Token 不能再改变归属；
- 数据库有多个用户且无法确定归属时，会创建独立的 `local-default` 用户，原用户数据不会自动合并。

多用户数据库若要指定保留哪位用户的数据，可在第一次以 `local` 启动前设置：

```dotenv
AUTH_MODE=local
LOCAL_USER_ID=existing-user-id
```

`LOCAL_USER_ID` 必须是数据库中已经存在的用户 ID，不是邮箱；不存在时本地认证初始化会报错，浏览器无法进入工作台。服务记录选定所有者后可移除该变量。切换模式前应备份整个 `APP_DATA_DIR` 和浏览器会话导出；不同用户的数据不会自动合并或转移。

## 媒体工具可执行文件

`media_probe` 和 `media_transform` 依赖完整的 `ffmpeg` / `ffprobe` 可执行文件。运行时按以下顺序查找：

1. `GUGO_FFMPEG_PATH` / `GUGO_FFPROBE_PATH`；
2. Electron 安装目录下的 `resources/bin/ffmpeg.exe` / `resources/bin/ffprobe.exe`；
3. 可选的 static npm 包；
4. 服务进程的 `PATH`。

源码、Docker 或其他自托管部署建议使用绝对路径，且两个程序必须来自同一套 FFmpeg 发行版：

```dotenv
GUGO_FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg
GUGO_FFPROBE_PATH=/opt/ffmpeg/bin/ffprobe
```

Windows 也可使用 `C:\Tools\ffmpeg\bin\ffmpeg.exe` 类型的绝对路径。修改后重启服务，并分别执行 `ffmpeg -version` 与 `ffprobe -version` 验证二进制可用。`media_transform` 的剪辑、转码、提取音频、抽帧、变速、GIF、字幕烧录、拼接、音量调整和 `denoise_audio` 降噪都使用这套二进制。桌面安装包的构建方法见 [DESKTOP_RELEASES.md](./DESKTOP_RELEASES.md#media-sidecars)。

## 可选的只读 LSP 导航

Gugo 可以把经过授权的本地源码交给 stdio Language Server，向主工具循环、Job planning 和子代理提供 `goToDefinition`、`findReferences`、`goToImplementation` 与 `hover`。该能力默认关闭；未配置 provider、配置无效或扩展冲突时，`lsp` 不会出现在模型工具列表中。

启用时必须同时设置 provider 数组和精确命令白名单。每个命令都必须是已存在的绝对普通文件；启动时会解析真实路径并与白名单精确比较。以下是 Linux 示例：

```dotenv
LSP_STDIO_COMMAND_ALLOWLIST=["/usr/local/bin/typescript-language-server"]
LSP_STDIO_PROVIDERS=[{"id":"typescript","command":"/usr/local/bin/typescript-language-server","args":["--stdio"],"extensions":{".js":"javascript",".jsx":"javascriptreact",".ts":"typescript",".tsx":"typescriptreact"},"timeout_ms":20000}]
```

Windows 不能依赖 `.cmd` 或 PowerShell shim，因为子进程固定使用 `shell: false`。可以把原生 `node.exe` 加入白名单，并把语言服务器的绝对 JavaScript 入口作为第一个参数：

```dotenv
LSP_STDIO_COMMAND_ALLOWLIST=["C:\\Program Files\\nodejs\\node.exe"]
LSP_STDIO_PROVIDERS=[{"id":"typescript","command":"C:\\Program Files\\nodejs\\node.exe","args":["C:\\Tools\\typescript-language-server\\lib\\cli.mjs","--stdio"],"extensions":{".js":"javascript",".ts":"typescript"},"timeout_ms":20000}]
```

Provider 还可指定绝对目录 `cwd` 和小型字符串 `env` 对象。已知敏感宿主环境变量会被剥离，`NODE_OPTIONS`、`PYTHONPATH`、`LD_*` 等运行时注入键始终拒绝；但 provider `env` 是会直接交给子进程的明文部署配置，确有需要时才使用，不要把秘密写入可共享的 `.gugo/runtime.json`。每次查询都使用独立子进程，取消、超时、关闭或协议错误会回收整个进程树。除 `workspace/configuration` 与 `workspace/workspaceFolders` 外，语言服务器主动发起的请求一律以 JSON-RPC `-32601` 拒绝，Gugo 不会通过 LSP 协议接受 `workspace/applyEdit`、`workspace/executeCommand` 等写操作。

这条“只读”边界只约束 Gugo 暴露和响应的 LSP 方法，并不是进程沙箱。`shell: false`、命令白名单和协议拒绝都不能阻止受信任二进制直接调用操作系统文件或网络 API；语言服务器仍以 Gugo 的操作系统账户权限运行。只允许审核过的固定二进制和参数，不可信 server 应放进独立容器或低权限账户，通用 shell 与包执行器（如 `cmd.exe`、PowerShell、`sh`、`bash`、`npx`）不应进入白名单。

源文件、workspace root 和语言服务器返回的每个 `file:` URI 都会重新经过本地文件授权；workspace 外或未授权的位置会被过滤。模型坐标是 1-based UTF-16，协议坐标会转换为 0-based UTF-16。单 provider 最多同时处理 4 个查询，最多 8 个 provider，因此宿主理论上最多同时创建 32 个查询子进程。单文档最大 2 MiB，协议 header 最大 8 KiB、单消息最大 1 MiB，查询超时默认 20 秒且只允许 1–120 秒；provider 最多接收 500 个原始位置，工具最终最多返回 100 个位置且完整 JSON 不超过 16 KB。

每个 JSON 配置字符串最大 64 KiB；allowlist 最多 16 项；单 provider 最多 32 个参数、16 个 env 项和 32 个扩展映射，参数与 env 各自的总量最多 8 KiB。启动只校验配置、真实路径、白名单和扩展注册，不会预先启动语言服务器握手；修改配置后必须重启，二进制执行权限或协议兼容错误会在第一次查询时报告。若通过分层 `runtime.json` 配置，数组本身必须双重编码成标量字符串：

```json
{
  "env": {
    "LSP_STDIO_COMMAND_ALLOWLIST": "[\"/usr/local/bin/typescript-language-server\"]",
    "LSP_STDIO_PROVIDERS": "[{\"id\":\"typescript\",\"command\":\"/usr/local/bin/typescript-language-server\",\"args\":[\"--stdio\"],\"extensions\":{\".ts\":\"typescript\"}}]"
  }
}
```

## 专用文件处理与产物通道

普通 `read_file` 仍只用于不超过 5 MB 的 UTF-8 文本。图片、音视频、PDF 和 ZIP 不应先编码成文本或 Base64：`image_info` / `image_transform`、`media_probe` / `media_transform`、`pdf_info` / `pdf_text` / `pdf_transform` 与批量文件工具直接使用工作区路径、用户已授权路径或其规格允许的受管附件 URI，并分别执行像素、字节数、页码范围、处理时长或解压膨胀等限制。

PDF 专用通道默认允许 256 MB 输入和 512 MB 输出，可通过 `PDF_TOOL_MAX_INPUT_BYTES` / `PDF_TOOL_MAX_OUTPUT_BYTES` 收紧或放宽。`pdf_text` 默认单次最多提取 200 页、1,000,000 字符和 50,000 个定位项，分别由 `PDF_TEXT_MAX_PAGES`、`PDF_TEXT_MAX_CHARACTERS`、`PDF_TEXT_MAX_ITEMS` 配置；达到上限时应使用 `pages` / `ranges` 分批读取。

`image_transform`、`media_transform`、`pdf_transform` 和 `archive_create` 成功后，工具循环会异步把输出复制到 `ARTIFACT_DIR`，登记为受管产物并返回下载链接。该复制通道避免把大型二进制内容放入模型上下文，但不会放宽目录授权，也不会取消各专用工具自己的输入/输出上限。源文件默认保留；除非调用时明确设置 `overwrite=true`，输出路径已存在会报错。

能力边界如下：

- `archive_list` / `archive_extract` 支持单卷、未加密的 ZIP32 与 RAR4/RAR5；`archive_create` 只创建 ZIP32。ZIP64、加密或多卷归档以及创建 RAR 不在内建支持范围内。
- `pdf_text` 按页返回文本和定位项；定位项使用 PDF 点坐标且以左下角为原点，可直接作为 `overlay_text` 的测量依据，但不等同于 OCR 或视觉版式验证。
- `pdf_transform` 支持合并、拆分、90 度倍数旋转、水印、AcroForm 填写，以及 `overlay_text`。水印、覆盖文字和文本表单外观使用随应用捆绑的 CJK TTF；`overlay_text` 先用指定背景色（默认白色）遮盖，再绘制一行文字，不修改底层文本流，也不负责自动换行或段落重排。
- 内建 PDF 工具不提供 OCR、PDF→Word、Word→PDF 或任意文本重排。安装 LibreOffice 且允许 `bash_exec` 时，可以脚本方式做尽力转换，但必须渲染并人工检查版式，不能宣称无损。
- 字体创造由 `font-creator` Skill 指导脚本实现，不是内建工具；运行需要已授权的读写目录、`bash_exec`，以及外部 FontForge 或 Python `fontTools`。依赖缺失时不会自动获得字体编辑能力。

## 首次工作区引导

在服务宿主机上通过回环地址打开应用后，可在「权限中心 → 首次启动 · 开启本地工作区」选择一个目录，分别开启文件、Shell、Git 能力并选择审批模式；远程请求不能修改这项配置。提交前必须确认风险；选择“全部放行”还需要单独确认。配置会把所选目录授予 `read_write`、标记为可信工作区，并把 `WORKSPACE_FS_ENABLED`、`WORKSPACE_SHELL_ENABLED`、`WORKSPACE_GIT_ENABLED` 写入用户级运行配置（默认是 `server-data/runtime.json`，自定义 `APP_DATA_DIR` 时随之变化）。

`.env`、`.gugo/runtime.json`、`APP_CONFIG_PATH` 或系统环境变量中显式设置的同名开关仍按分层优先级生效，并在界面中显示为由部署策略管理；首次引导不能覆盖它们。引导只授权所选目录，不会自动开放整台电脑，也不把 Shell 变成安全沙箱。完成后仍可回到权限中心调整目录、能力和审批模式。

## 工作区信任

`WORKSPACE_FS_ENABLED`、`WORKSPACE_SHELL_ENABLED`、`WORKSPACE_GIT_ENABLED` 和
`WORKSPACE_GIT_MUTATION_ENABLED` 是共享工作区根目录（`WORKSPACE_ROOT`）的服务端能力上限。
工作区未信任时只允许读取；文件写入、Shell 与 Git 默认拒绝。用户显式信任工作区后，
`.gugo/config.json` 才会被读取，且其中的 `fileSystem`、`fileSystemWrite`、`shell`、`git`、
`gitMutation` 只能进一步收紧全局开关。

`WORKSPACE_SHARED_TRUSTED=1` 会把工作区视为对所有用户已信任，只适用于单机、可信用户环境。
它不是执行沙箱，也不应在不可信用户可访问的部署中开启。

### 本地文件授权与全局开关的关系

`WORKSPACE_FS_ENABLED` 只约束**工作区根目录**（`WORKSPACE_ROOT`）内的路径访问。在
「设置 → 本地文件」里**显式授权的目录**是独立的信任边界：授权行为本身就是用户的明确同意，
读取/写入这些已授权路径**不依赖** `WORKSPACE_FS_ENABLED` 全局开关。未授权的路径（无论是否在
工作区内）仍然完全拒绝。这样本机单用户使用时不强制开全局开关，也能让模型访问已授权的
本地项目（例如 `D:\destok\money`）。

代码执行遵循更严格的规则：只有用户明确授予 `read_write` 的**目录**能成为本地 Shell 工作目录；
单个文件、`read_only` 授权和“全部文件”访问都不会隐式获得执行权限。在 `AUTH_MODE=local` 且
`SERVER_HOST` 为回环地址时，这类目录默认可运行 Python、Node、PowerShell 和项目命令，无需再设置
`WORKSPACE_SHELL_ENABLED` 或工作区信任。`multi_user` 或非回环监听默认关闭，只有显式设置
`LOCAL_CODE_EXECUTION_ENABLED=1` 才会开启；设为 `0` 可在本机模式下也彻底关闭。写入型 Shell
命令始终需要单次审批，不能建立永久放行规则。

本地代码执行和共享工作区 Shell 都不是 OS 级沙箱。若服务会被不可信用户访问，应保持代码执行
关闭，或部署到容器/nsjail/seccomp 等真正的隔离环境中。

## OAuth 公网地址与反向代理

生产环境应显式设置 `APP_PUBLIC_URL=https://gugo.example.com`，MCP OAuth 回调地址只使用该 origin。
未配置时，服务使用 `SERVER_HOST`/`SERVER_PORT` 构造本机地址，并忽略请求中的 `Host`、
`X-Forwarded-Host` 和 `X-Forwarded-Proto`。只有受信反向代理已经清除客户端伪造的转发头时，
才可设置 `TRUST_PROXY=1`。

MCP OAuth 的 32 字节随机 state 只以 SHA-256 摘要保存；PKCE verifier 和授权上下文加密写入
SQLite，10 分钟后过期，并在 callback 时原子单次消费。因此服务重启不会丢失正在进行的授权，
同一 state 也不能重复使用。

## 连接器 OAuth 一键授权

「连接」页的 Notion / GitHub / Slack / Google Drive 支持 OAuth 一键授权（可选；不配置时仍可
手工填写 token）。启用步骤：

1. **设置公网地址**：`.env` 中配置 `APP_PUBLIC_URL`（如 `http://localhost:5175` 或
   `https://gugo.example.com`），回调地址只使用该 origin；
2. **到各平台创建 OAuth Client**，回调地址填
   `{APP_PUBLIC_URL}/api/integrations/oauth/callback/{provider}`（provider 为
   `github` / `notion` / `slack` / `google_drive`）；
3. **在 `.env` 填写 Client 凭据**（见下表），重启服务；
4. 回到「连接」页对应卡片，点「使用 OAuth 一键授权」即可。

| 服务 | 环境变量 | 默认 scope |
|---|---|---|
| GitHub | `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | `read:user` |
| Notion | `NOTION_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_SECRET` | 无（按集成授权） |
| Slack | `SLACK_OAUTH_CLIENT_ID` / `SLACK_OAUTH_CLIENT_SECRET` | `channels:read,channels:history` |
| Google Drive | `GOOGLE_DRIVE_OAUTH_CLIENT_ID` / `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET` | `drive.readonly` |

需要更多权限时，用对应 `*_OAUTH_SCOPES` 环境变量显式覆盖（如
`GOOGLE_DRIVE_OAUTH_SCOPES=https://www.googleapis.com/auth/drive`）。GitHub 使用 PKCE，
Google Drive 使用 PKCE + refresh token 自动续期。凭据只保存在服务端，返回前端时脱敏。
OAuth 未配置时，卡片会显示说明并继续支持手工填写令牌。

## 自定义 bridge webhook 签名

`webhook`、`wechat` 和 `wechat_personal` provider 的请求必须携带：

```text
X-Gugo-Timestamp: <Unix 秒或毫秒>
X-Gugo-Signature: sha256=<hex(HMAC-SHA256(signingSecret, timestamp + "." + rawBody))>
```

服务拒绝与当前时间相差超过 5 分钟的请求，并用 SQLite 记录签名摘要，在有效窗口内拒绝完全相同的
重放。为兼容既有客户端，也接受 `X-Webhook-Timestamp` / `X-Signature-Timestamp`、
`X-Signature-256` / `X-Hub-Signature-256`，以及无点号的 `timestamp + rawBody` 签名格式；
不再接受只签 raw body、没有时间戳的旧格式。
