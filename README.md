# Your Model Atelier

> 本地/内网可用的 AI 工作台 — 对标 Claude Code / OpenAI Codex  
> 🔒 安全优先 · 🧠 知识图谱 · 🎨 Artifact 渲染 · 🛠️ 全栈工具链

<p align="center">
  <img src="https://img.shields.io/badge/React-19-6366f1?logo=react" />
  <img src="https://img.shields.io/badge/Node.js-20-10b981?logo=node.js" />
  <img src="https://img.shields.io/badge/SQLite-WAL-2e8fa3" />
  <img src="https://img.shields.io/badge/Vite-8-ec4899?logo=vite" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

---

## 🚀 核心功能

### 对标 Claude/Codex

| 类别 | 功能 |
|------|------|
| 💬 AI 对话 | 多模型流式 SSE、12 种内置技能、工具调用循环 |
| 🎨 Artifact 预览 | React 沙箱、PPT/Word/Excel 实时渲染、HTML Deck |
| 🛠️ 工作区工具 | 文件读写编辑、Shell 执行、Git 状态/差异/提交 |
| 📋 任务系统 | 后台作业队列、计划步骤追踪、evidence-based 完成标记 |
| 🔌 MCP 集成 | stdio + SSE Transport、工具发现/调用/重连 |
| 🧠 知识图谱 | 实体-关系-观测值三要素、图搜索、跨会话持久化 |
| 🤖 子代理 | 隔离子代理 (explore/plan/general)、独立工具循环 |
| 📚 技能市场 | 内置 12 技能 + 可导入技能包、版本管理 |
| 🔐 安全 | CSP/CORS/CSRF 防护、SSRF 守卫、数据加密、用户隔离 |
| 🎭 3D 封面 | Three.js 粒子系统、全屏沉浸式入口 |

### 独有优势

- ✅ **Artifact 渲染** — Claude/Codex 均不提供 PPT/Word/Excel/React 实时预览
- ✅ **知识图谱** — 区别于平面记忆文件，支持图搜索和关系查询
- ✅ **作业队列** — 完整的创建/入队/重试/取消/步骤追踪生命周期
- ✅ **3D 封面页** — 交互式 3D 粒子场景 (Three.js)
- ✅ **结构化选择器** — `[[choice:...]]` 格式的多选项交互

---

## 🏗️ 架构

```
用户浏览器 (React SPA)
       │
       ├── /api/* ──→ Node.js HTTP Server (零框架)
       │                  ├── modelProxy.js     ─ OpenAI 兼容代理
       │                  ├── billingAuth.js    ─ 鉴权/计费/积分
       │                  ├── toolProxy.js      ─ Web 搜索/抓取
       │                  ├── jobRuntime.js     ─ 后台作业编排
       │                  ├── knowledgeGraph.js ─ 知识图谱 CRUD
       │                  ├── subagentRuntime.js ─ 隔离子代理
       │                  ├── mcp/              ─ MCP 客户端
       │                  ├── fsShellTools.js   ─ 文件/Shell 工具
       │                  ├── gitWorkbench.js   ─ Git 集成
       │                  ├── memoryStore.js    ─ 长期记忆
       │                  ├── skillRegistry.js  ─ 技能系统
       │                  └── middleware.js     ─ CSP/CORS/Security Headers
       │
       └── SQLite (WAL mode, better-sqlite3)
              ├── users / sessions / ledger
              ├── jobs / job_steps / job_artifacts
              ├── memories / entities / relations / observations
              ├── skills / mcp_servers / hooks / subagent_runs
              └── compaction_archive / tool_audit
```

**技术栈**: React 19 · Vite 8 · Tailwind CSS 3 · Framer Motion · Three.js · Node.js 20 · better-sqlite3 · JSDOM · JSZip · Zod · PPTXGenJS · @e965/xlsx

**代码规模**: ~17,000 行 · 46 测试文件 · ~210 个测试用例 · 零后端框架依赖

---

## ⚡ 快速开始

### 1. 配置

```bash
cp .env.example .env
# 编辑 .env: 填入 MODEL_BASE_URL、MODEL_NAME、MODEL_API_KEY
```

### 2. 开发模式

```powershell
npm run dev -- --host 127.0.0.1 --port 5175
# 打开 http://127.0.0.1:5175
```

### 3. 生产模式

```powershell
npm run local
# 构建 dist/ → 启动 Node 服务 (默认 :5175)
# 同时提供静态文件 + /api/* 后端
```

### 4. Docker 部署

```bash
docker compose up -d
# 或手动构建:
docker build -t your-model-atelier .
docker run -p 5175:5175 --env-file .env your-model-atelier
```

---

## 📖 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `MODEL_BASE_URL` | ✅ | 模型 API 地址 (OpenAI 兼容) | — |
| `MODEL_NAME` | ✅ | 模型名称 | — |
| `MODEL_API_KEY` | ✅ | API 密钥 | — |
| `MODEL_NAMES_VISION` | ❌ | 视觉模型名称(逗号分隔) | — |
| `MODEL_MULTIPLIER` | ❌ | 积分倍率 | `1.0` |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` | ❌ | 邮箱服务(缺省时控制台打码) | — |
| `WORKSPACE_FS_ENABLED` | ❌ | 启用文件系统工具 | `0` |
| `WORKSPACE_SHELL_ENABLED` | ❌ | 启用 Shell 工具 | `0` |
| `WORKSPACE_GIT_ENABLED` | ❌ | 启用 Git 工具 | `0` |
| `WORKSPACE_ROOT` | ❌ | 工作区根目录 | `process.cwd()` |
| `MCP_STDIO_ALLOWED_COMMANDS` | ❌ | 允许的 stdio 命令 | `npx,node,uvx,…` |
| `APP_DATA_DIR` | ❌ | 数据目录 | `server-data/` |
| `APP_DB_PATH` | ❌ | SQLite 路径 | `server-data/app.db` |
| `PORT` | ❌ | 服务端口 | `5175` |

---

## 📋 常用命令

```powershell
npm run dev          # 开发模式 (Vite HMR)
npm run build        # 生产构建
npm run serve        # 仅启动后端 (需先 build)
npm run local        # 构建 + 启动
npm run lint         # ESLint 检查
npm test             # 运行 210+ 测试
```

---

## 🧪 测试

```powershell
npm test                          # 全量测试
node --test tests/knowledgeGraph.test.js  # 单个模块
```

**覆盖范围**: 鉴权/计费 · 模型代理 · 文件工具 · Git · 作业系统 · 技能 · 导出 · SSRF · MCP · 子代理 · 知识图谱 · 前端库

---

## 🗂️ 目录结构

```
your-model-atelier/
├── server/               # Node.js 后端
│   ├── appServer.js      # HTTP 服务入口
│   ├── db.js             # SQLite + 迁移 (v1→v4)
│   ├── middleware.js      # 安全头/CORS/CSP/鉴权
│   ├── modelProxy.js     # OpenAI 兼容代理 + SSE 流
│   ├── billingAuth.js    # 邮箱验证码登录 + 积分
│   ├── knowledgeGraph.js # 知识图谱 (v4 新增)
│   ├── subagentRuntime.js # 隔离子代理
│   ├── mcp/              # MCP 客户端 (stdio/SSE)
│   └── ...               # 工具/技能/记忆/钩子
├── src/
│   ├── pages/            # 10 个页面
│   │   ├── CoverPage/    # 3D 封面
│   │   ├── ChatSplit/    # 核心聊天工作台
│   │   └── ...
│   ├── components/       # 可复用组件
│   ├── lib/              # 工具/客户端/解析器
│   └── store/            # 状态管理 + 持久化
├── tests/                # 46 个测试文件
├── dist/                 # 构建产物
├── docs/                 # 设计文档
└── server-data/          # SQLite + artifacts
```

---

## 🤝 贡献

欢迎 PR。请遵循现有代码风格：
- JSX 导入顺序：React → 第三方 → 本地
- 新功能必须有测试
- 服务器端 API 需同时在 `appServer.js` 和 `vite.config.js` 注册路由
- 用 `★ #N` 注释标记可追溯的修改

## 📄 License

MIT
