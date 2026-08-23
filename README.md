# Gugo

**简体中文** | [English](README.en.md)

> 本地/内网可用的 Web + Windows 桌面 AI 工作台 — Agent · Skill · Memory · Tool · Subagent · Job
> 默认本机单用户免登录，可通过浏览器或桌面应用使用；模型 API 由使用者自行配置。

Gugo 是开源 BYOK（Bring Your Own Key）项目：不内置支付、充值、余额、套餐、订阅或按量收费系统。模型及连接器可能产生的费用由用户自行选择的上游 Provider 直接收取；Gugo 只可在用户显式启用时，依据用户填写的费率做本地只读估算，默认关闭。估算结果绝不影响模型调用、权限、限流、自我进化、晋升或回滚。

<p align="center">
  <img src="https://img.shields.io/badge/React-19-6366f1?logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/Node.js-20-10b981?logo=node.js" alt="Node 20" />
  <img src="https://img.shields.io/badge/SQLite-WAL-2e8fa3" alt="SQLite WAL" />
  <img src="https://img.shields.io/badge/Vite-8-ec4899?logo=vite" alt="Vite 8" />
  <a href="https://github.com/lichangjiang932-ship-it/Gugo/actions/workflows/ci.yml"><img src="https://github.com/lichangjiang932-ship-it/Gugo/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <img src="https://img.shields.io/badge/release-v0.11.38-blue" alt="v0.11.38" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT" />
</p>

---

## 这是什么

一个**完整的 AI Agent 工作平台**，跟你熟悉的 Claude Code、Cursor、Cherry Studio、LobeChat、openhanako 是同一品类，同时提供浏览器版本和 Windows Electron 桌面应用。

Windows 安装包与自动更新元数据见 [GitHub Releases](https://github.com/lichangjiang932-ship-it/Gugo/releases)。

| 维度 | Gugo | openhanako | Claude Code |
|---|---|---|---|
| 形态 | Web（浏览器即用）+ Windows Electron 桌面 | Electron 桌面 | CLI |
| 部署 | 单 Node 进程 + SQLite | 多端打包 | 终端 |
| 使用模式 | 默认本机单用户免登录；可选多用户认证与隔离 | 单机 | 单机 |
| Artifact 实时预览 | PPT / Word / Excel / React / HTML Deck | 不支持 | 不支持 |
| 知识图谱 | entity / relation / observation 三要素 + 图搜索 | 无 | 无 |
| 后台作业 | 完整生命周期（创建/入队/重试/取消/步骤追踪） | 简化 | 无 |
| MCP | stdio + SSE | 是 | 是 |
| 子代理 | 独立上下文 + 工具白名单 | 是 | 是 |
| Skill 系统 | 内置 + 可导入 + 内置 SQLite 系统库 | 是 | 是 |
| 独立 Hub | 队列运行骨架（`HUB_ENABLED=1`，当前仅内置 `echo` 验证任务） | 是 | 无 |
| 跨平台 Bridge | 飞书 / 微信 / Telegram 等（v0.10） | Telegram/飞书/微信/QQ | 无 |
| 审批门控 | 服务端 pause/resume + 收件箱 + 单次调用批准/拒绝/改参数 | 无 | 权限提示 |

---

## 核心能力

### Agent 工作台
- 多模型流式 SSE 输出 · 工具调用循环 · `[[choice:...]]` 结构化选项交互
- 12 + N 种内置技能（PPT 大师 / 网页生成 / 调研 / 翻译 / 代码审查 / 项目规划 …）
- 子代理（explore / plan / general）在独立上下文中运行，拥有独立工具循环和上下文压缩
- `/goals <目标>` 创建可恢复的后台 Goal：先生成可编辑计划并等待显式批准，再按计划执行、验证并记录检查点；即使全局审批设为全部放行，Goal 的首次计划仍不会跳过批准

### Artifact 渲染（差异化亮点）
- PPT：layout 控制（cover / section / kpi / chart / statement / split / process / quote / bullets / end）
- Word / Excel：直接生成可下载文件
- React 沙箱 + HTML Deck 实时预览
- 主题：noir / paper / ocean / forest

### 记忆系统
- Memory 中心（type / title / slug / pinned / source）
- 知识图谱：entity ↔ relation ↔ observation 三要素，跨会话持久
- Reasonix 集成：钉记忆 / TODO / effort 滑块 / session meter 仪表盘

### 工具与集成
- 工作区文件系统（read / write / edit / apply_patch · 原子多文件）
- Shell 执行（危险命令拦截）
- Git workbench（status / diff / commit）
- 代码理解：grep_code / find_symbol / list_imports
- 图片：`image_info` 检查格式、尺寸和方向等元数据；`image_transform` 支持格式转换、缩放、裁剪、旋转、翻转、灰度、模糊、锐化与归一化
- 音视频：`media_probe` 检查流、编码和时长；`media_transform` 支持剪辑、转码、提取音频、抽帧、变速、生成 GIF、烧录字幕、兼容性诊断/重编码拼接、音量调整与 `denoise_audio` FFT 降噪
- PDF：`pdf_info` 检查页数、元数据和表单，`pdf_text` 按页提取文本及可直接用于覆盖的坐标；`pdf_transform` 支持合并、拆分、旋转、中文水印、中文表单填写与坐标式文字遮盖重绘
- 批量文件：`archive_list` 不落地预览 ZIP 与 RAR4/RAR5，`archive_create` 流式创建 ZIP，`archive_extract` 安全解压 ZIP 与 RAR4/RAR5，`batch_rename` 分阶段批量重命名文件或整个目录，`file_hash_manifest` 流式生成 SHA-256 清单和精确重复组（不会自动删除文件）
- 反思工具：manage_todos / reflect / request_clarification

图片、音视频、PDF 和归档工具按已授权路径处理二进制文件，不经过普通 `read_file` 的 5 MB UTF-8 通道；成功生成的图片、媒体、PDF 和 ZIP 会异步复制到受管 Artifact 目录并返回下载链接。普通文本读取的 5 MB 上限仍然保留。

已知边界：`archive_list` / `archive_extract` 支持单卷、未加密的 ZIP32 与 RAR4/RAR5，`archive_create` 只创建 ZIP32；不支持 ZIP64、加密或多卷归档，也不创建 RAR。PDF `overlay_text` 使用 PDF 点坐标（左下角为原点）覆盖指定矩形后以随应用捆绑的 CJK 字体绘制一行文字，不会修改或重排底层文本流。内建 PDF 工具不提供 OCR、PDF↔Word 或任意段落重排；已安装 LibreOffice 时可通过受控 Shell 做需视觉复核的尽力转换。自定义字体是脚本型 Skill，不是内建字体编辑器，需要已授权的读写目录、`bash_exec`，以及外部 FontForge 或 Python `fontTools`。

### MCP 客户端
- stdio + Streamable HTTP + Legacy SSE，工具发现 / 调用 / 自动重连
- 命令白名单 + 工具审计

### 模型与 Browser
- 设置页可新增用户隔离的 OpenAI 兼容 Provider：Base URL、API Key、模型列表、自定义 Headers 与默认模型
- 本机 Edge/Chrome DevTools 自动化：打开、快照、点击、输入、等待、截图、控制台诊断与关闭
- API Key 只保存在服务端，列表与编辑响应均脱敏

### 鉴权 / 安全
- 邮箱验证码 + 邮箱密码双通道（60s 倒计时防刷）
- 用户隔离（v2/v3 migration · 所有数据带 user_id）
- CSP / CORS / 安全 Headers / SSRF 守卫
- 敏感 env 屏蔽 · tool_audit 全闭环
- 速率限制（rateLimiterBudget）

### 审批门控（对标 openworker 的 check-in）
- 服务端 **pause / resume 原语**：后台任务与子代理执行高风险工具前挂起，等人决定
- **收件箱**：批准 / 拒绝 / **改写参数后再批准**——单次调用粒度，不是「按工具名一刀切」
- 风险分级按**具体参数**判定：`bash_exec` 命中危险命令黑名单升 high、写文件越出工作区升 high、`fetch_url` 只拦非安全方法、`apply_patch` 的 `dry_run` 直接放行
- 决策权威在 DB，进程重启后挂起的审批仍可决策；等待中的任务不会被崩溃恢复重跑
- `APPROVAL_MODE=off | unattended | all` 控制审批队列是否可用；`off` 对未授权危险操作保守拒绝，只有用户显式选择 `bypass` 才会全放行

---

## 架构

```
浏览器 (React SPA)
   │
   ├── /api/* ──→ Node.js HTTP Server（零框架）
   │      ├── adapters/modelProxy.js      ─ 模型配置、聊天 HTTP 编排与兼容门面
   │      ├── adapters/modelStreamingTransport.js ─ Provider 流、超时与增量协议适配
   │      ├── adapters/authAccount.js     ─ 鉴权 / 密码 / 验证码
   │      ├── services/jobRuntime.js      ─ 后台作业编排
   │      ├── services/subagentRuntime.js ─ 独立上下文子代理
   │      ├── services/skillRegistry.js   ─ 技能系统 + seed
   │      ├── services/memoryStore.js     ─ 记忆中心
   │      ├── services/knowledgeGraph.js  ─ 三要素图
   │      ├── mcp/               ─ MCP 客户端
   │      ├── routes/hooksRoutes.js       ─ pre/post tool use hooks
   │      ├── routes/compactionRoutes.js  ─ 上下文压缩
   │      └── routes/reasonixRoutes.js    ─ 钉记忆/TODO/effort
   │
   └── SQLite (WAL, better-sqlite3)
        ├── users / sessions / verify_codes
        ├── jobs / job_steps / job_artifacts / job_events
        ├── skills / skill_assets / mcp_servers / hooks
        ├── memories / memory_links / pinned_memories / todos
        ├── entities / relations / observations
        ├── subagent_runs / subagents_custom
        ├── compaction_archive / tool_audit
        ├── pending_approvals          ← 挂起的工具调用 + 决策结果
        └── effort_settings / session_meters
```

技术栈：React 19 · Vite 8 · Tailwind CSS 3 · Framer Motion · Node.js 20 · better-sqlite3 · JSDOM · JSZip · Zod · PPTXGenJS · @e965/xlsx

规模：持续增长的自动化测试套件 · Windows/Linux CI · 零后端框架依赖

---

## 路线图

公开路线与问题跟踪见 [GitHub Issues](https://github.com/lichangjiang932-ship-it/Gugo/issues)，发布记录见 [GitHub Releases](https://github.com/lichangjiang932-ship-it/Gugo/releases)。

**已完成**：
- [x] **v0.5**：plugin SDK 真消费 + agent-template
- [x] **v0.6**：agent-MEMORY DB v6 + session sticky agent + ChatHeader 切换器
- [x] **v0.7**：跨标签页 storage 同步 + Templates 弹层 preview + import 撞名重命名
- [x] **v0.8**：Memory 管理视图加 agent 绑定 UI（filter chip / list badge / editor select）
- [x] **v0.9**：Agent 角色卡 zip 导出/导入（对齐 openhanako）
- [x] Cron / 调度层（配置和行为见 [调度文档](docs/SCHEDULING.md)）

后续计划以 [GitHub Issues](https://github.com/lichangjiang932-ship-it/Gugo/issues)
和 Milestones 中的公开条目为准，避免在 README 中维护容易过期的内部清单。

参与开发前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

---

## 快速开始

第一次安装或准备长期运行，请先阅读 [《Gugo 操作手册》](./docs/OPERATION_GUIDE.md)。手册包含环境要求、模型配置、开发/生产/Docker 启动、可选多用户认证、备份恢复、升级、安全注意事项和常见故障处理。

```bash
git clone https://github.com/lichangjiang932-ship-it/Gugo.git
cd Gugo
npm install
cp .env.example .env   # 默认 AUTH_MODE=local，仅本机免登录使用
npm run dev            # 前端 HMR（默认 :5175）
# 或：
npm run local          # 生产模式：build + 启动 Node server
```

打开 `http://127.0.0.1:5175`，无需注册或登录。首次使用先进入「权限中心」，在「首次启动 · 开启本地工作区」中选择工作目录、分别启用文件/Shell/Git 能力并选择审批模式；只会授权所选目录，部署环境锁定的开关不会被界面覆盖。随后进入「设置 → 模型」添加自己的 OpenAI 兼容、Anthropic、Gemini、Ollama 或 LM Studio Provider；项目不附带可用的模型 API Key。也可以在 `.env` 中配置服务端默认模型。

Docker：

```bash
docker compose up -d
```

Compose 默认只把端口绑定到宿主机 `127.0.0.1`。若要从局域网或公网访问，必须先设置 `AUTH_MODE=multi_user` 并配置 SMTP，再显式设置 `DOCKER_BIND_ADDRESS=0.0.0.0`；公网还必须使用 HTTPS 与可信反向代理。

### 自定义模型与外部 MCP 应用

默认本地模式下可直接在「设置 → 模型」新增模型 Provider。模型配置会自动用于聊天、诊断、后台任务和子代理；留空 API Key 可保留原密钥。启用 `AUTH_MODE=multi_user` 后，各用户登录后分别配置自己的 Provider。

Browser 工具需要 Node.js 20 或更高版本，以及已安装的 Edge/Chrome。默认自动探测浏览器，也可在 `.env` 设置 `BROWSER_EXECUTABLE_PATH`；仅受限 CI/沙箱环境才使用 `BROWSER_NO_SANDBOX=1`。

视频/音频剪辑、转码、抽帧、拼接、音量调整和降噪需要 `ffmpeg` 与 `ffprobe`。官方 Windows 桌面包从 Electron `resources/bin` 自带 sidecar；源码或自托管部署可将它们加入 `PATH`，或用 `GUGO_FFMPEG_PATH` / `GUGO_FFPROBE_PATH` 指向绝对路径。详见 [配置说明](docs/CONFIGURATION.md#媒体工具可执行文件)。

从左侧「连接」进入 Access 中心（Hash 路由为 `/#/access`）。目录中的 Browser 应用是打开对应网站的浏览器入口，不代表原生 API 集成；Notion、GitHub、Slack 与 Google Drive 才提供可被 agent 结构化调用的原生连接，并支持 OAuth 一键授权（配置 `APP_PUBLIC_URL` 与对应 OAuth Client 环境变量），未配置时仍可手工填 token。飞书使用企业自建应用的 App ID / App Secret，个人微信使用二维码扫码。OAuth 握手使用一次性 state、PKCE（GitHub/Google Drive）与 10 分钟持久会话，凭据探测成功后才启用；GitHub 默认仅请求 `read:user`，Slack 默认仅请求公开频道读取范围，Google Drive 默认仅请求 `drive.readonly`，额外 scope 必须通过对应 `*_OAUTH_SCOPES` 显式开启。Google Drive access token 到期后会使用服务端保存的 refresh token 自动续期。凭据只保存在服务端，返回前端时会脱敏。Access 中心还提供常用 MCP Server 的一键安装预设（Chrome DevTools、Fetch、Sequential Thinking、Memory、Playwright），装完即可在对话中直接调用其工具。

MCP OAuth 的 pending state 加密持久化并原子单次消费，服务重启不会中断 10 分钟内的授权。反向代理部署必须设置 `APP_PUBLIC_URL`；默认不会采信 `Host` 或 `X-Forwarded-*` 来生成回调地址，只有代理已清除外部伪造头时才可设置 `TRUST_PROXY=1`。自定义 bridge webhook 必须用时间戳参与 HMAC 签名，并会拒绝超过 5 分钟的请求与重复投递；请求头和签名格式见 [配置说明](docs/CONFIGURATION.md)。

连接器 token、模型 API key 与自定义模型请求头使用 AES-256-GCM 加密后再写入数据库。默认会在数据库旁原子生成权限受限的 `.credentials.key`；如果系统无法把该文件限制为仅当前 OS 用户可访问，凭据读写会拒绝继续并提示 `CREDENTIAL_VAULT_KEY_PERMISSIONS_UNSAFE`，不会在弱权限下使用密钥。此时请修复文件 ACL/权限，或通过 `CREDENTIAL_ENCRYPTION_KEY` 注入 32 字节主密钥；也可用 `CREDENTIAL_KEY_PATH` 指定密钥文件。请把数据库和密钥分开备份；密钥丢失后密文无法恢复。旧版本的 JSON/base64 凭据会在首次读取时自动迁移为密文。

对外 MCP Server 位于 `http://<服务器地址>:5175/mcp`。先在「手机入口 / LAN Access Keys」创建 `ymak_...` 密钥，再作为 `Authorization: Bearer <key>` 使用。Claude Desktop、Cursor 和兼容 JSON 导入的客户端可配置：

```json
{
  "mcpServers": {
    "gugo": {
      "type": "http",
      "url": "http://127.0.0.1:5175/mcp",
      "headers": { "Authorization": "Bearer ymak_YOUR_ACCESS_KEY" }
    }
  }
}
```

Codex 的 `.codex/config.toml`：

```toml
[mcp_servers.gugo]
url = "http://127.0.0.1:5175/mcp"
http_headers = { Authorization = "Bearer ymak_YOUR_ACCESS_KEY" }
```

Cherry Studio 选择 `Streamable HTTP`，URL 填上述 `/mcp` 地址，并添加同一个 Authorization Header。跨设备连接时请把 `127.0.0.1` 换成运行本项目机器的局域网地址；生产公网部署应使用 HTTPS。

---

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `AUTH_MODE` | 否 | `local` 本机免登录；`multi_user` 启用登录与用户隔离 | `local` |
| `MODEL_BASE_URL` | 否 | 服务端默认模型 API 地址；也可在设置页按用户配置 | — |
| `MODEL_NAME` | 否 | 服务端默认模型名 | — |
| `MODEL_API_KEY` | 否 | 服务端默认模型 API Key | — |
| `MODEL_NAMES_VISION` | 否 | 视觉模型名（逗号分隔） | — |
| `MAIL_SERVER/MAIL_PORT/MAIL_USERNAME/MAIL_PASSWORD` | 多用户部署必填 | 邮箱验证码服务；本地模式不需要 | — |
| `WORKSPACE_FS_ENABLED` | 否 | 工作区文件工具开关；在「本地文件」显式授权的路径不受此开关限制 | `0` |
| `WORKSPACE_SHELL_ENABLED` | 否 | 共享 `WORKSPACE_ROOT` 的 Shell 工具开关 | `0` |
| `LOCAL_CODE_EXECUTION_ENABLED` | 否 | 用户授权 `read_write` 目录的代码执行开关；本机回环模式默认开启，远程/多人默认关闭 | 自动 |
| `WORKSPACE_GIT_ENABLED` | 否 | Git 工具开关 | `0` |
| `WORKSPACE_ROOT` | 否 | 工作区根目录 | `process.cwd()` |
| `WORKSPACE_SHARED_TRUSTED` | 否 | 单机可信环境跳过逐用户工作区信任 | `0` |
| `GUGO_FFMPEG_PATH` | 否 | `ffmpeg` 可执行文件绝对路径；优先于桌面 sidecar 和 `PATH` | 自动探测 |
| `GUGO_FFPROBE_PATH` | 否 | `ffprobe` 可执行文件绝对路径；优先于桌面 sidecar 和 `PATH` | 自动探测 |
| `APP_PUBLIC_URL` | 否 | OAuth 回调使用的固定公网 origin | — |
| `TRUST_PROXY` | 否 | 信任反向代理转发头（代理必须先清洗） | `0` |
| `MCP_STDIO_ALLOWED_COMMANDS` | 否 | MCP stdio 命令白名单 | `npx,node,uvx,…` |
| `MCP_SERVER_ENABLED` | 否 | 开启对外 `/mcp` Streamable HTTP Server | `1` |
| `MCP_RATE_LIMIT_PER_MINUTE` | 否 | `/mcp` 每来源 IP 每分钟请求上限 | `300` |
| `MCP_MAX_BODY_BYTES` | 否 | `/mcp` 单请求最大字节数 | `1048576` |
| `APPROVAL_MODE` | 否 | 审批队列策略：`off` 保守拒绝未授权危险操作，`unattended` / `all` 启用逐次审批；不会覆盖用户权限档位 | `unattended` |
| `APPROVAL_TIMEOUT_MS` | 否 | 审批超时（超时视同拒绝） | `86400000` |
| `TURN_EVENT_RETENTION_DAYS` | 否 | 服务端聊天事件整轮保留天数 | `30` |
| `TURN_EVENT_MAX_TERMINAL_TURNS_PER_USER` | 否 | 每用户最多保留的终态轮次事件 | `1000` |
| `TURN_EVENT_CLEANUP_INTERVAL_MS` | 否 | 聊天事件保留清理检查间隔（毫秒） | `300000` |
| `APP_DATA_DIR` | 否 | 数据目录 | `server-data/` |
| `APP_DB_PATH` | 否 | SQLite 路径 | `server-data/app.db` |
| `SERVER_PORT` | 否 | HTTP 端口 | `.env.example` 为 `5175`，未配置时服务端回退 `5173` |
| `SERVER_HOST` | 否 | 服务监听地址；本机模式保持回环地址 | `127.0.0.1` |
| `DOCKER_BIND_ADDRESS` | 否 | Compose 在宿主机发布端口的地址 | `127.0.0.1` |

完整列表见 `.env.example`。

> ⚠ `AUTH_MODE=local` 不提供网络访问控制，只适合绑定 `127.0.0.1` 的可信本机。任何局域网或公网监听都必须使用 `AUTH_MODE=multi_user`；公网还需要 HTTPS、SMTP、防火墙和反向代理限流。

> ⚠ **Shell 信任模型**：开启共享工作区的 `WORKSPACE_SHELL_ENABLED=1`，或在本机回环模式下把目录以 `read_write` 授权给代码执行，都等同于**完全信任**能调用 `bash_exec` 的用户——该用户可在 server 进程权限下执行命令。`server/utils/bashGuard.js` 的危险命令黑名单**只防手滑 / prompt-injection 一行 payload，不是安全边界**（变量拼接 / base64 管道 / `python -c` / `$()` 命令替换均可平凡绕过）。若需对不可信用户开放 Shell，必须上 OS 级隔离（容器 / nsjail / seccomp），不要依赖黑名单。

共享工作区的写入、Shell 与 Git 需要用户信任，并受相应全局开关限制。独立的本地文件授权中，只有明确授予 `read_write` 的目录可用于代码执行；单文件、只读和“全部文件”授权都不会获得 Shell 权限。写入型 Shell 命令仍逐次审批。`WORKSPACE_SHARED_TRUSTED=1` 仅适用于单机可信用户，不是安全沙箱。

---

## 命令速查

```bash
npm run dev      # Vite HMR
npm run build    # 生产构建
npm run serve    # 仅启动后端（需先 build）
npm run local    # build + 启动
npm run lint     # ESLint
npm test         # 全量自动化测试
```

---

## 目录结构

```
Gugo/
├── server/                # Node.js HTTP 服务与 SQLite 数据层
│   ├── appServer.js       # HTTP 入口
│   ├── db.js              # SQLite bootstrap 与 v2-v30 兼容迁移
│   ├── middleware.js      # 安全头 / CORS / CSP
│   ├── adapters/          # 模型、鉴权、浏览器与工具适配器
│   ├── routes/            # HTTP API 路由
│   ├── services/          # Job、子代理、记忆、调度与集成服务
│   ├── migrations/        # v31+ 独立迁移与版本注册表
│   ├── utils/             # 路径、网络与安全通用工具
│   └── mcp/               # MCP 客户端与服务端
├── shared/                # 前后端共享的事件契约
├── src/
│   ├── pages/             # 页面与工作区视图
│   ├── components/        # 可复用组件
│   ├── lib/               # 客户端 / 工具 / 解析器
│   └── store/             # 状态 + 持久化
├── skill-packs/           # 可分发的 skill 包
├── seed/                  # 系统 skill 静态种子
├── tests/                 # 自动化测试
├── docs/
│   ├── CONFIGURATION.md   # 配置参考
│   ├── KERNEL_BOUNDARY.md # 极简内核边界与完成标准
│   ├── OPERATION_GUIDE.md # 部署与运维
│   └── SCHEDULING.md      # Cron / 调度说明
└── .github/workflows/
    └── ci.yml             # 测试、覆盖率、安全扫描与镜像构建
```

---

## 贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

报告安全问题见 [SECURITY.md](./SECURITY.md)，行为准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

版本记录见 [CHANGELOG.md](./CHANGELOG.md)，vendored 浏览器资源和运行时依赖的许可证来源见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 致谢与启发

本项目在架构上**借鉴**了：

- [openhanako](https://github.com/liliMozi/openhanako) — Manager facade、独立 Hub、Plugin SDK、SessionFile sidecar
- Claude Code、Cursor、OpenAI Codex CLI — Agent 工作流、apply_patch、reflect 节奏
- [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) — 钉记忆、TODO、effort 滑块、session meter

技术栈来自 React / Vite / better-sqlite3 / pptxgenjs 等开源社区。

---

## License

[MIT](./LICENSE)。第三方组件仍适用各自的许可证与版权声明。
