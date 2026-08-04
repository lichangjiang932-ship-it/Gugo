# Gugo 操作手册

本文面向第一次安装、日常使用和维护 Gugo 的用户。命令均以仓库根目录为当前目录；完整环境变量清单见 [`.env.example`](../.env.example)，分层配置与 OAuth/Webhook 细节见 [CONFIGURATION.md](./CONFIGURATION.md)。

## 1. 环境要求

### 必需

- Node.js 20 或更高版本。若要使用本机 Edge/Chrome 自动化，推荐直接安装 Node.js 22 LTS。
- npm（随 Node.js 安装）。
- Git，用于克隆和升级源码。
- 可访问的 OpenAI 兼容、Anthropic、Gemini 或本地模型端点。

检查版本：

```bash
node --version
npm --version
git --version
```

### 可选

- Edge 或 Chrome：仅 Browser 自动化需要。
- Docker 与 Docker Compose：仅容器部署需要。
- SMTP 邮箱：公网或多人使用时必须配置；纯本地开发可在页面显示验证码。
- Python、C/C++ 构建工具：通常不需要；若 `better-sqlite3` 没有适配当前平台的预编译包，npm 会提示安装本地编译工具。

## 2. 获取与安装

```bash
git clone https://github.com/lichangjiang932-ship-it/your-model-atelier.git
cd your-model-atelier
npm ci
```

`npm ci` 会严格按 `package-lock.json` 安装，适合新安装、CI 和生产环境。只有在需要更新依赖及锁文件时才使用 `npm install`。

复制配置模板：

macOS / Linux：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

`.env` 已被 Git 忽略，不要提交 API Key、SMTP 密码或 OAuth Secret。

## 3. 最小配置

打开 `.env`，至少确认以下项目。模板中的 API Key 是占位符，不能直接使用。

```dotenv
MODEL_BASE_URL=https://api.example.com/v1
MODEL_NAME=your-model-name
MODEL_NAMES=your-model-name
MODEL_API_KEY=replace-with-your-real-key

SERVER_HOST=127.0.0.1
SERVER_PORT=5175
```

本地 Ollama 示例：

```dotenv
MODEL_BASE_URL=http://127.0.0.1:11434/v1
MODEL_NAME=qwen2.5:7b
MODEL_NAMES=qwen2.5:7b
MODEL_API_KEY=
OLLAMA_KEEP_ALIVE=30m
```

说明：

- `MODEL_NAME` 必须与上游真实模型名一致。
- 不同服务对 `/v1` 的要求不同，请以供应商文档为准。
- 登录后也可在“设置 → 模型”添加用户级 Provider；但服务端 `/api/health` 的就绪判断仍依赖默认模型环境配置。
- 本机仅自己使用时保留 `SERVER_HOST=127.0.0.1`。要从局域网访问才改为 `0.0.0.0`，并同时配置防火墙、认证和可信网络边界。

### 常用配置

| 配置 | 默认/建议 | 用途 |
|---|---|---|
| `SERVER_HOST` | 模板为 `127.0.0.1` | HTTP 监听地址 |
| `SERVER_PORT` | 模板为 `5175` | 开发和生产共用端口；无配置时生产代码回退到 `5173` |
| `APP_DATA_DIR` | `server-data/` | SQLite、运行时配置、默认凭据密钥和浏览器 Profile |
| `APP_DB_PATH` | `server-data/app.db` | 自定义 SQLite 文件位置 |
| `ARTIFACT_DIR` | `.artifacts/` | 生成的 PPT、文档等文件目录 |
| `APPROVAL_MODE` | `unattended` | `off`、`unattended` 或 `all` |
| `WORKSPACE_ROOT` | 仓库启动目录 | 文件、Shell 和 Git 工具允许访问的根目录 |
| `WORKSPACE_FS_ENABLED` | `0` | 开启工作区文件工具 |
| `WORKSPACE_SHELL_ENABLED` | `0` | 开启 Shell；等同授予服务器进程权限 |
| `WORKSPACE_GIT_ENABLED` | `0` | 开启 Git 读取工具 |
| `WORKSPACE_GIT_MUTATION_ENABLED` | `0` | 允许 Git 写操作 |
| `APP_PUBLIC_URL` | 空 | 生产 OAuth 回调的固定公网 Origin |
| `TRUST_PROXY` | `0` | 是否信任已清洗的反向代理转发头 |
| `CREDENTIAL_ENCRYPTION_KEY` | 自动生成本地密钥文件 | 连接器和模型凭据的 32 字节主密钥 |

配置优先级从低到高为：

1. `server-data/runtime.json`
2. `.gugo/runtime.json`
3. `APP_CONFIG_PATH` 指定的 JSON
4. `.env`
5. 系统环境变量

JSON 运行时配置只接受大写环境变量风格的非敏感标量。API Key、Token、Secret、Password 和私钥必须放在 `.env`、系统环境变量或应用的加密凭据存储中。正式启动请使用 npm 脚本，它会先加载分层配置。

## 4. 启动方式

### 开发模式

```bash
npm run dev
```

打开 `http://127.0.0.1:5175`。`npm run dev` 不只是前端 HMR：Vite 中间件同时挂载了认证、模型、工具、任务和其他后端 API。

开发与生产应尽量使用相同的协议、主机和端口。浏览器登录状态与偏好位于 localStorage，会话正文位于 IndexedDB；它们都按 Origin 隔离。`localhost` 和 `127.0.0.1` 也是两个不同 Origin，混用时会看起来像“登录和历史丢失”。

### 本机生产模式

首次部署或源码变化后构建：

```bash
npm run build
npm run serve
```

也可以一次完成：

```bash
npm run local
```

`npm run serve` 只启动 Node 服务并托管 `dist/`；如果没有 `dist/index.html` 会直接退出。长期运行时建议先执行一次 `npm run build`，再让 systemd、Supervisor 或其他进程管理器在仓库根目录执行 `npm run serve`。停止时发送 `SIGTERM`、`SIGINT` 或在终端按 `Ctrl+C`，让 SQLite 和后台任务完成优雅关闭。

`npm run preview` 只是 Vite 静态预览，不提供完整应用 API，不能代替 `npm run serve`。

### Docker Compose

先创建并填写 `.env`，再执行：

```bash
docker compose up -d --build
docker compose logs -f app
```

停止与重启：

```bash
docker compose stop
docker compose start
```

删除容器但保留数据卷：

```bash
docker compose down
```

不要随意执行 `docker compose down -v`，`-v` 会删除保存 `server-data` 的数据卷。

Compose 已把 `/app/server-data` 放入命名卷。生成物默认写到容器内 `/app/.artifacts`，如需跨容器重建保留生成物，建议在 `.env` 中设置：

```dotenv
ARTIFACT_DIR=/app/server-data/artifacts
```

仓库自带镜像基于 Node.js 20 且未安装桌面浏览器，适合聊天和服务端功能；Browser 自动化建议使用安装了 Node.js 22 与 Edge/Chrome 的本机部署，或自行扩展镜像。

### 健康检查

浏览器或命令行访问：

```text
http://127.0.0.1:5175/api/health
```

macOS / Linux：

```bash
curl -i http://127.0.0.1:5175/api/health
```

Windows PowerShell：

```powershell
Invoke-WebRequest http://127.0.0.1:5175/api/health
```

数据库可用且默认模型已配置时返回 HTTP 200；缺少模型配置时即使网页能打开，也会返回 503。登录后可在“设置 → 系统诊断”查看更完整的模型和服务状态。

## 5. 首次使用

1. 始终使用同一个地址打开应用，例如 `http://127.0.0.1:5175`。
2. 进入“设置 → 账户”，输入邮箱并获取验证码。
3. 本地未配置 SMTP 时，验证码会直接显示在页面/API 响应中；生产环境必须配置 SMTP，并保持 `AUTH_DEV_CODES=false`。
4. 验证码登录后可设置登录密码，之后也可继续使用邮箱验证码。
5. 进入“设置 → 模型”，检查默认模型；需要时新增 OpenAI 兼容、Anthropic、Gemini、Ollama 或 LM Studio Provider，并运行检测。
6. 进入“设置 → 系统诊断”，执行模型连接测试。
7. 如需本地文件、Shell 或 Git，在 `.env` 中只开启必要的全局能力，并在界面中授权、信任具体工作区。
8. 新建一次普通对话确认流式输出正常，再测试工具调用。
9. 进入“设置 → 数据 & 导出”导出一次会话备份，确认自己的备份流程可用。

## 6. 日常开发与检查

```bash
npm run dev          # 开发服务器与完整 API
npm run lint         # ESLint
npm test             # 全量自动化测试
npm run i18n:check   # 五语言键与硬编码检查
npm run debt:check   # 代码债务基线检查
npm run build        # 生产构建
```

提交代码前至少运行 `npm run lint`、`npm test` 和 `npm run build`。

## 7. 备份与恢复

Gugo 同时使用服务端存储和浏览器存储，二者必须分别备份。

### 服务端备份

1. 用 `Ctrl+C`、`docker compose stop` 或进程管理器优雅停止服务。
2. 复制整个 `APP_DATA_DIR`，不要只复制 `app.db`。SQLite 使用 WAL，运行中单独复制数据库主文件可能得到不一致快照。
3. 复制默认 `.artifacts/`，或备份自定义 `ARTIFACT_DIR`。
4. 安全备份 `.env` 或部署平台的环境变量。
5. 如果使用 `CREDENTIAL_KEY_PATH` 或 `CREDENTIAL_ENCRYPTION_KEY`，单独安全备份密钥。密钥丢失后，数据库中的模型和连接器密文无法恢复。

默认情况下，`server-data/.credentials.key` 已包含在整个数据目录备份中。备份文件含登录信息、Token 和凭据密文，应加密保存并限制读取权限。

Docker 示例：

```bash
docker compose stop
docker compose cp app:/app/server-data ./backup/server-data
docker compose start
```

恢复时先停止服务，将数据目录和凭据密钥放回原路径，再启动相同或更新版本。不要把新版本数据库直接交给更旧版本程序运行。

### 浏览器会话备份

聊天会话与消息正文主要保存在当前 Origin 的 IndexedDB 中，不会因为复制服务器数据库而自动恢复。进入“设置 → 数据 & 导出”导出全部会话，并将导出文件与服务端备份一起保存。

清理浏览器站点数据、换浏览器 Profile、切换域名/端口或使用隐私模式前，务必先导出。浏览器提示“存储空间不足”指当前站点的 IndexedDB/浏览器配额或持久化能力，不等同于电脑内存不足。

## 8. 升级

升级前先完成服务端和浏览器双份备份，并确认工作树没有未保存的改动：

```bash
git status --short
```

无本地改动时：

```bash
git pull --ff-only
npm ci
npm run lint
npm test
npm run build
npm run serve
```

生产环境应先停止旧进程再启动新版本。数据库迁移会在首次启动时自动执行；迁移前备份数据目录，启动后检查 `/api/health` 和“系统诊断”。若仓库有本地改动，不要直接覆盖，先提交到自己的分支或手工合并。

Docker 升级：

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs -f app
```

## 9. 常见问题

### `dist/index.html` 不存在

`npm run serve` 不会自动构建前端。先执行：

```bash
npm run build
npm run serve
```

### `Port 5175 is already in use`

开发服务器使用 `strictPort`，不会静默换端口。通常是另一个实例仍在运行：直接打开现有地址，或先用 `Ctrl+C`/进程管理器停止旧实例。不要为了绕过冲突随意改端口，否则浏览器会切到另一套 Origin 存储。

### 网页能打开，但健康检查返回 503

`/api/health` 同时检查数据库与默认模型配置。确认 `.env` 中 `MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY` 已填写真实值，并从仓库根目录启动。登录后再到“设置 → 系统诊断”运行端点测试。

### 模型返回 401、404 或没有流式输出

- 检查 API Key、Base URL 和模型名是否完全匹配供应商。
- 检查端点是否要求 `/v1`。
- 在“设置 → 模型”正确标记流式、工具、视觉和 PDF 能力；不确定时先使用自动检测。
- 本地模型很慢时提高首字和空闲超时，不要误开跨模型故障转移。

### 登录验证码收不到

本地开发未配置 SMTP 时，验证码会显示在页面中。生产环境检查 `MAIL_SERVER`、`MAIL_PORT`、`MAIL_USERNAME`、`MAIL_PASSWORD`、`MAIL_DEFAULT_SENDER`、TLS/SSL 设置和服务日志。未配置 SMTP 会把验证码放入响应，不适合公网部署。

### 登录状态或历史突然为空

确认是否从 `127.0.0.1` 换成了 `localhost`，或修改了端口、协议、域名、浏览器 Profile。它们属于不同 Origin，数据没有自动迁移。回到原地址或从之前导出的备份恢复。

### 出现“浏览器存储空间不足”

这通常是浏览器给当前站点的 IndexedDB 配额、隐私设置或持久化权限问题，不是系统内存不足。先立即导出会话，再检查浏览器站点存储、是否处于隐私模式，以及磁盘是否真的已满。不要在导出前清除站点数据。

### Browser 工具不可用

使用 Node.js 22+，安装 Edge/Chrome，必要时设置 `BROWSER_EXECUTABLE_PATH`。普通桌面环境不要设置 `BROWSER_NO_SANDBOX=1`。容器中还需自行安装浏览器及其系统依赖。

### `better-sqlite3` 安装失败

先确认 Node.js 为受支持的正式版本并重新执行 `npm ci`。若平台没有预编译包，按错误提示安装 Python、编译器和构建工具；Windows 通常需要 Visual Studio Build Tools，Debian/Ubuntu 通常需要 `python3 make g++`。

### Docker 容器显示 unhealthy

先看日志：

```bash
docker compose logs app
```

健康检查会在数据库或默认模型未就绪时失败。确认 `.env` 已传入容器、`SERVER_PORT` 映射一致、模型配置不是模板占位符，并检查数据卷权限。

## 10. 安全注意事项

- Gugo 的 Shell 工具不是安全沙箱。`WORKSPACE_SHELL_ENABLED=1` 表示受信用户可用服务器进程权限执行命令；只应在单机、可信用户环境开启。
- 未信任工作区默认只读。不要为了省事在多人或公网部署中设置 `WORKSPACE_SHARED_TRUSTED=1`。
- 公网部署必须使用 HTTPS、SMTP、强密码、反向代理限流与防火墙，并设置固定 `APP_PUBLIC_URL`。
- 只有反向代理已经清除客户端伪造的转发头时才设置 `TRUST_PROXY=1`。
- 生产环境建议使用 `APPROVAL_MODE=all`；`off` 会让高风险工具不经人工确认直接执行。
- 保持 `MCP_STDIO_ENABLED=0`、`HOOKS_SHELL_ENABLED=0`，除非明确需要并配置了最小命令白名单。
- 不要在普通桌面或公网服务上设置 `BROWSER_NO_SANDBOX=1`。
- 自定义 Webhook 必须配置签名 Secret，并使用带时间戳的 HMAC；OAuth 回调必须使用固定公网 Origin。详见 [CONFIGURATION.md](./CONFIGURATION.md)。
- 定期更新依赖并运行测试；任何升级、迁移或清理前先完成备份演练。
