# Your Model Atelier

> 本地/内网可用的 Web AI 工作台 — Agent · Skill · Memory · Tool · Subagent · Job  
> 开浏览器就用，无需安装客户端。

<p align="center">
  <img src="https://img.shields.io/badge/React-19-6366f1?logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/Node.js-20-10b981?logo=node.js" alt="Node 20" />
  <img src="https://img.shields.io/badge/SQLite-WAL-2e8fa3" alt="SQLite WAL" />
  <img src="https://img.shields.io/badge/Vite-8-ec4899?logo=vite" alt="Vite 8" />
  <img src="https://img.shields.io/badge/tests-572%20passing-success" alt="tests" />
  <img src="https://img.shields.io/badge/release-v0.10.0-blue" alt="v0.10.0" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT" />
</p>

---

## 这是什么

一个**完整的 Web AI Agent 平台**，跟你熟悉的 Claude Code、Cursor、Cherry Studio、LobeChat、openhanako 是同一品类，但走 **Web 路线**（浏览器即用，没有 .dmg / .exe / .AppImage）。

| 维度 | Your Model Atelier | openhanako | Claude Code |
|---|---|---|---|
| 形态 | Web（浏览器即用） | Electron 桌面 | CLI |
| 部署 | 单 Node 进程 + SQLite | 多端打包 | 终端 |
| 多用户 | 内建（user_id 隔离 + 邮箱密码登录 + 积分） | 单机 | 单机 |
| Artifact 实时预览 | PPT / Word / Excel / React / HTML Deck | 不支持 | 不支持 |
| 知识图谱 | entity / relation / observation 三要素 + 图搜索 | 无 | 无 |
| 后台作业 | 完整生命周期（创建/入队/重试/取消/步骤追踪） | 简化 | 无 |
| MCP | stdio + SSE | 是 | 是 |
| 子代理 | 隔离子代理 + 工具白名单 | 是 | 是 |
| Skill 系统 | 内置 + 可导入 + 内置 SQLite 系统库 | 是 | 是 |
| 3D 沉浸式入口 | Three.js 粒子封面页 | 无 | 无 |
| 独立 Hub | ✓ 已实现（`server/hub/` · `HUB_ENABLED=1` 启动 · 详见 [docs/HUB.md](docs/HUB.md)） | 是 | 无 |
| 跨平台 Bridge | 计划中（v0.5+） | Telegram/飞书/微信/QQ | 无 |

---

## 核心能力

### Agent 工作台
- 多模型流式 SSE 输出 · 工具调用循环 · `[[choice:...]]` 结构化选项交互
- 12 + N 种内置技能（PPT 大师 / 网页生成 / 调研 / 翻译 / 代码审查 / 项目规划 …）
- 子代理（explore / plan / general）隔离运行，独立工具循环和上下文压缩

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
- 反思工具：manage_todos / reflect / request_clarification

### MCP 客户端
- stdio + SSE Transport，工具发现 / 调用 / 自动重连
- 命令白名单 + 工具审计

### 鉴权 / 安全
- 邮箱验证码 + 邮箱密码双通道（60s 倒计时防刷）
- 用户隔离（v2/v3 migration · 所有数据带 user_id）
- CSP / CORS / 安全 Headers / SSRF 守卫
- 敏感 env 屏蔽 · tool_audit 全闭环
- 速率限制（rateLimiterBudget）

---

## 架构

```
浏览器 (React SPA)
   │
   ├── /api/* ──→ Node.js HTTP Server（零框架）
   │      ├── modelProxy.js      ─ OpenAI 兼容代理 + SSE 流
   │      ├── billingAuth.js     ─ 鉴权 / 密码 / 验证码 / 积分
   │      ├── jobRuntime.js      ─ 后台作业编排
   │      ├── subagentRuntime.js ─ 隔离子代理
   │      ├── skillRegistry.js   ─ 技能系统 + seed
   │      ├── memoryRoutes.js    ─ 记忆中心
   │      ├── knowledgeGraph.js  ─ 三要素图
   │      ├── mcp/               ─ MCP 客户端
   │      ├── hooksRoutes.js     ─ pre/post tool use hooks
   │      ├── compactionRoutes.js─ 上下文压缩
   │      └── reasonixRoutes.js  ─ 钉记忆/TODO/effort
   │
   └── SQLite (WAL, better-sqlite3)
        ├── users / sessions / ledger / verify_codes
        ├── jobs / job_steps / job_artifacts / job_events
        ├── skills / skill_assets / mcp_servers / hooks
        ├── memories / memory_links / pinned_memories / todos
        ├── entities / relations / observations
        ├── subagent_runs / subagents_custom
        ├── compaction_archive / tool_audit
        └── effort_settings / session_meters
```

技术栈：React 19 · Vite 8 · Tailwind CSS 3 · Framer Motion · Three.js · Node.js 20 · better-sqlite3 · JSDOM · JSZip · Zod · PPTXGenJS · @e965/xlsx

规模：~17,000 行代码 · 50+ 测试文件 · **572 个测试用例**（v0.10.0） · 零后端框架依赖

---

## 路线图

详细进度看 [PROGRESS.md](./PROGRESS.md)，发布历史看 [CHANGELOG.md](./CHANGELOG.md)。

**已完成**：
- [x] **v0.5**：plugin SDK 真消费 + agent-template
- [x] **v0.6**：agent-MEMORY DB v6 + session sticky agent + ChatHeader 切换器
- [x] **v0.7**：跨标签页 storage 同步 + Templates 弹层 preview + import 撞名重命名
- [x] **v0.8**：Memory 管理视图加 agent 绑定 UI（filter chip / list badge / editor select）
- [x] **v0.9**：Agent 角色卡 zip 导出/导入（对齐 openhanako）
- [x] **v0.10**：integrations 中心 — 飞书/微信/钉钉/QQ/Discord/Telegram/Slack 等账号配置 + 视觉副驾（无视觉模型自动图→文）+ 频道空状态引导 CTA

**进行中 / 下一步**（按 ROI 排，详见 PROGRESS.md）：
- [ ] prompt-template plugin 接 chat slash command
- [ ] PPT 视觉升级（gradient cover/section + 更多 chart 类型）

历史架构重构进度（已归档）：[docs/archive/REFOUND_PLAN.md](./docs/archive/REFOUND_PLAN.md)

---

## 快速开始

```bash
git clone https://github.com/lichangjiang932-ship-it/your-model-atelier.git
cd your-model-atelier
npm install
cp .env.example .env   # 配置 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY
npm run dev            # 前端 HMR（默认 :5175）
# 或：
npm run local          # 生产模式：build + 启动 Node server
```

Docker：

```bash
docker compose up -d
```

---

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `MODEL_BASE_URL` | 是* | OpenAI 兼容 API 地址；单 provider 模式使用 | — |
| `MODEL_NAME` | 是 | 默认模型名 | — |
| `MODEL_API_KEY` | 是* | API key；单 provider 模式使用 | — |
| `MODEL_PROVIDERS` | 否 | 多 provider 路由 ID 列表，例如 `deepseek,mimo`；启用后用 `MODEL_PROVIDER_<ID>_*` 配置不同上游 | — |
| `MODEL_PROVIDER_<ID>_BASE_URL` | 否 | 多 provider 模式下某个上游的 OpenAI 兼容 API 地址 | — |
| `MODEL_PROVIDER_<ID>_API_KEY` | 否 | 多 provider 模式下某个上游的 API key | — |
| `MODEL_PROVIDER_<ID>_MODELS` | 否 | 多 provider 模式下某个上游可用模型，逗号分隔 | — |
| `MODEL_NAMES_VISION` | 否 | 视觉模型名（逗号分隔） | — |
| `MODEL_PRICE_MULTIPLIERS` | 否 | 每个模型的积分倍率，例如 `model-a:1,model-b:3` | `MODEL_NAME:1` |
| `SMTP_HOST/PORT/USER/PASS` | 否 | 邮箱服务（缺省时控制台打码） | — |
| `WORKSPACE_FS_ENABLED` | 否 | 文件系统工具开关 | `0` |
| `WORKSPACE_SHELL_ENABLED` | 否 | Shell 工具开关 | `0` |
| `WORKSPACE_GIT_ENABLED` | 否 | Git 工具开关 | `0` |
| `WORKSPACE_ROOT` | 否 | 工作区根目录 | `process.cwd()` |
| `MCP_STDIO_ALLOWED_COMMANDS` | 否 | MCP stdio 命令白名单 | `npx,node,uvx,…` |
| `APP_DATA_DIR` | 否 | 数据目录 | `server-data/` |
| `APP_DB_PATH` | 否 | SQLite 路径 | `server-data/app.db` |
| `PORT` | 否 | HTTP 端口 | `5175` |

完整列表见 `.env.example`。

---

## 命令速查

```bash
npm run dev      # Vite HMR
npm run build    # 生产构建
npm run serve    # 仅启动后端（需先 build）
npm run local    # build + 启动
npm run lint     # ESLint
npm test         # 572 测试
```

---

## 目录结构

```
your-model-atelier/
├── server/                # Node.js 后端 (8000+ 行)
│   ├── appServer.js       # HTTP 入口
│   ├── db.js              # SQLite + migration v1→v4 + reasonix
│   ├── middleware.js      # 安全头 / CORS / CSP / 鉴权
│   ├── modelProxy.js      # OpenAI 兼容代理 + SSE
│   ├── billingAuth.js     # 验证码 + 密码 + 积分
│   ├── jobRuntime.js      # 后台作业 + 工具循环
│   ├── subagentRuntime.js # 隔离子代理
│   ├── knowledgeGraph.js  # 图谱 CRUD
│   ├── seedSystemSkills.js# 系统技能种子
│   ├── mcp/               # MCP 客户端
│   └── reasonixRoutes.js  # 钉记忆/TODO/effort
├── src/
│   ├── pages/             # 11 个页面（含 3D CoverPage、ChatSplit）
│   ├── components/        # 可复用组件
│   ├── lib/               # 客户端 / 工具 / 解析器
│   └── store/             # 状态 + 持久化
├── skill-packs/           # 可分发的 skill 包
├── seed/                  # 系统 skill 静态种子
├── tests/                 # 50+ 测试文件
├── docs/
│   ├── archive/           # 历史归档（REFOUND_PLAN / 旧 RELEASE_NOTES 等）
│   ├── superpowers/       # 任务级 specs/plans
│   └── HUB.md / PLUGIN_SDK.md / I18N.md / AGENTS.md
└── .github/workflows/
    └── ci.yml             # PR / push 自动跑 lint + test + build
```

---

## 贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

报告安全问题见 [SECURITY.md](./SECURITY.md)，行为准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

---

## 致谢与启发

本项目在架构上**借鉴**了：

- [openhanako](https://github.com/liliMozi/openhanako) — Manager facade、独立 Hub、Plugin SDK、SessionFile sidecar
- Claude Code、Cursor、OpenAI Codex CLI — Agent 工作流、apply_patch、reflect 节奏
- [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) — 钉记忆、TODO、effort 滑块、session meter

技术栈来自 React / Vite / better-sqlite3 / pptxgenjs / Three.js 等开源社区。

---

## License

MIT
