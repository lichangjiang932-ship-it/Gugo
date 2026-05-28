# REFOUND PLAN · 参照 openhanako 重构 your-model-atelier

> 日期：2026-05-25  
> 触发：用户要求"以现有产品为基础，参照 openhanako 完全重构"  
> 形态约束：openhanako 是 Electron 桌面 Agent，**your-model-atelier 保持 Web 形态**  
> 借鉴范围：内核架构（Manager facade / Hub / Plugin SDK / Skill Bundle / SessionFile） + 工程外壳（CI/release/i18n/README）

---

## 0. 关键判断（必须先看）

### 0.1 现状不是"PPT 工具"

your-model-atelier 实际已是一个**完整的 Claude Code 类 Web AI 工作台**：
- server/ 8611 行：modelProxy / billingAuth / jobRuntime / subagentRuntime / mcp / knowledgeGraph / skillRegistry / hookBus / compactionService / gitWorkbench …
- src/lib 25 模块、src/pages 11 视图、tests 20+ 文件
- 与 openhanako 内核同源度 ≈ 70%（Agent + Skill + Memory + Tool + Subagent + Job）

### 0.2 openhanako 内核相对的优势

| 维度 | openhanako | your-model-atelier 现状 | 差距 |
|---|---|---|---|
| Agent runtime | Pi SDK 独立项目，规范化 | server/ 散文件，jobRuntime/subagentRuntime 各自实现 | 缺统一 runtime 抽象 |
| Manager facade | Agent/Session/Model/Preferences/Skill/Channel/BridgeSession/Plugin 8 个 Manager 统一暴露 | server/*Routes.js + server/*Store.js 散布，没统一 facade | 缺"引擎层"门面 |
| Hub | 后台心跳/巡检/自动化/路由，**独立于聊天会话** | 没有独立 Hub，定时任务散在各 service | 缺独立后台进程 |
| Plugin SDK | PLUGIN_SDK.md + examples/plugins/sdk-showcase，正式 SDK | 有 skillRegistry/skillImport 但无 SDK 文档和示例 | 缺生态入口 |
| SessionFile sidecar | 文件按 session 统一登记，多端共享 | 文件管理散在 fsShellTools/attachments | 缺统一文件层 |
| Channel/Bridge | Telegram/飞书/微信/QQ 多平台桥接 | 仅 Web UI | 缺多端接入（Web 形态下可暂缓） |
| 发版工程 | 238 release，github-actions 全自动 | 无 release，无 CI workflow | 工程外壳缺口大 |
| i18n | zh/en/ja/ko/zh-TW | 单语 zh | 暂时只补 zh+en |

### 0.3 内核重构的"不可触红线"

- PR #15 `feat/premium-pptx` 已 push（pptCore + 236 测试），**先 merge 再动**
- 现有 20+ 测试必须**全程绿**，每个阶段结束跑一遍
- `better-sqlite3` schema 必须**向前兼容**（已有 dbMigration.test.js），不破老用户数据
- `modelProxy.js`（OpenAI 兼容代理）和 `billingAuth.js`（鉴权/计费）= 营收命脉，不动接口

---

## 1. 概念映射表（openhanako → your-model-atelier）

| openhanako 概念 | 落到 your-model-atelier | 现状 | 动作 |
|---|---|---|---|
| `core/engine` (Pi SDK) | `server/core/engine.js` 新建 | 无 | **新增**，聚合 jobRuntime + subagentRuntime + skillRegistry |
| `AgentManager` | `server/managers/AgentManager.js` | 无（散在 jobRuntime） | 抽象出来，统一 Agent 生命周期 |
| `SessionManager` | `server/managers/SessionManager.js` | session 概念散在 AppContext + jobStore | 后端建立显式 session 表 + manager |
| `ModelManager` | `server/managers/ModelManager.js` | modelProxy.js + modelSelection.js | 包装为 manager，对外只暴露 facade |
| `PreferencesManager` | `server/managers/PreferencesManager.js` | 散在 localStorage + db | 服务端持久化 + 客户端同步 |
| `SkillManager` | `server/managers/SkillManager.js` | skillRegistry/skillStore/skillImport | 合并，对外统一 |
| `ChannelManager` | （Web 形态下精简）| 无 | v1：只做 web channel；v2 再考虑 |
| `PluginManager` + Plugin SDK | `server/managers/PluginManager.js` + `docs/PLUGIN_SDK.md` + `examples/plugins/` | 有 skill 系统但无 plugin 概念 | 区分 skill（提示词/工具集）和 plugin（代码+UI 贡献），后者用沙盒 |
| `Hub`（独立后台进程） | `server/hub/index.js`（独立 node 进程） | 无 | 新增，跑 heartbeat/cron/巡检 |
| `SessionFile` sidecar | `server/managers/FileManager.js` + db 表 `session_files` | 散在 attachments/fsShellTools | 统一登记，token 化下载 |
| `BridgeMedia` | （Web 形态下不需要） | — | 跳过 |
| 5 语言 i18n | `src/i18n/{zh,en}.json` + `t()` hook | 硬编码中文 | v1：只补 zh+en |
| Release workflow | `.github/workflows/release.yml` | 无 | release-please + GHCR docker push |
| Examples 驱动 | `examples/plugins/sdk-showcase/` | 无 | 写一个最小 plugin 示例 |
| 三件套（CONTRIBUTING/SECURITY/CoC） | 同名文件 | 缺 | 一次性补齐 |

---

## 2. 三阶段路线（每阶段独立 worktree + PR）

### 阶段 0：清场（半天，前置）

| 任务 | 验收 |
|---|---|
| merge PR #15 `feat/premium-pptx`（pptCore + 236 测试） | main 上 `npm test` 全过 |
| 建 `docs/ARCHITECTURE.md`，画现状架构图（mermaid） | 评审通过 |
| 加 `.github/workflows/ci.yml`：install + lint + test | PR 触发 CI 跑通 |
| 加 `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` | 文件存在 |
| README 重写：定位从"PPT 工具"→"Web AI Agent Platform"，加截图+对比 openhanako 表 | 用户审过 |

**回滚成本：零**（全是新增 / 文档 / merge）

---

### 阶段 1：内核抽象（3-5 天，核心）

**目标**：把 server/ 散文件重组成 `server/core/` + `server/managers/` + `server/routes/`，**不改对外 HTTP API**

#### 1.1 目录重组

```
server/
├── core/
│   ├── engine.js         # 单例 facade，聚合 8 个 manager
│   ├── eventBus.js       # 内部事件总线（已有 hookBus 改造）
│   └── lifecycle.js      # 启动/关闭/健康检查
├── managers/
│   ├── AgentManager.js
│   ├── SessionManager.js
│   ├── ModelManager.js   # 包 modelProxy
│   ├── PreferencesManager.js
│   ├── SkillManager.js   # 合 skillRegistry/skillStore/skillImport
│   ├── PluginManager.js  # 新
│   ├── FileManager.js    # 新
│   └── JobManager.js     # 包 jobRuntime/jobStore
├── routes/               # 仅 HTTP 层，调 managers
│   ├── chat.js / job.js / skill.js / memory.js / mcp.js / hooks.js / subagent.js / kg.js / file.js
├── adapters/
│   ├── sqlite.js         # 现 db.js 拆为 adapter
│   ├── mcp/              # 现 mcp/
│   └── openai/           # 现 modelProxy 核心
└── appServer.js          # 只做 HTTP 启动 + 路由挂载
```

#### 1.2 不动接口的 facade 模式

每个 manager 给一份 TypeScript-style JSDoc 接口；routes/ 只依赖 manager，**HTTP 请求/响应字段保持现有结构**——前端零改动，所有 20+ 测试零改动。

#### 1.3 验收

- [ ] `npm test` 全过（含新加的 manager 单测，每个 manager ≥ 3 个 case）
- [ ] `npm run lint` 0 error
- [ ] 启动 `npm run serve`，curl 主要 endpoint：`/api/chat /api/skill /api/job /api/memory /api/mcp` 行为零变化（用 `diff` 对比重构前后响应快照）
- [ ] dbMigration.test.js 全过（schema 不破）

**回滚成本：中**（如果 1 周内出问题，revert 整个 worktree）

---

### 阶段 2：Hub + Plugin SDK + i18n（3 天）

#### 2.1 Hub 独立进程

- 新增 `server/hub/index.js`，独立 node 进程
- 跑：心跳巡检（job stuck 检测）、cron（定时清理 ttl 文件）、knowledge graph 后台索引
- 用 sqlite 跨进程通信（WAL 模式天然支持）
- `npm run hub` 启动，docker-compose 加 service

#### 2.2 Plugin SDK 形式化

- `docs/PLUGIN_SDK.md`：完整文档（manifest schema + 生命周期 hook + 权限模型 + 沙箱说明）
- `examples/plugins/hello-world/`：最小可运行示例（manifest.json + index.js + README + tests）
- `examples/plugins/ppt-theme/`：把现有 4 个 theme（warm/tech/finance/consumer）改写为 plugin 形式，验证 SDK 自洽
- 区分 **skill**（纯提示词/工具配置，无代码）vs **plugin**（带代码，需沙箱）

#### 2.3 i18n 起步

- `src/i18n/zh.json` + `en.json` + `useT()` hook
- 仅覆盖**导航 + 设置页 + 错误提示** 3 块（不强行翻译聊天内容）
- README + README_EN 双语

**回滚成本：低**（全新模块，删了就回去）

---

### 阶段 3：Agent 交互层升级（2-3 天，可选 / 看用户反馈）

- 借鉴 openhanako 的"人格 + 记忆 + 自主性"：
  - `src/pages/Agent/`：独立 Agent 视图，对话不只是聊天，是"对一个有人格的助理下达任务"
  - 引入 `SOUL.md` / `IDENTITY.md` / `MEMORY.md` 三件套到产品内部（参考 openclaw workspace 规范）
  - 心跳触发：用户离线一段时间后 Hub 主动总结/推送
- 这一阶段触动**前端体验骨架**，需要单独 design review 一次再开工

---

## 3. 不做的事（明确拒绝项）

- **不做 Electron 桌面端**：用户明确说"我是网页"
- **不做多平台 Bridge**（Telegram/微信/飞书）：Web 形态下 ROI 太低，留给 v2
- **不接 Pi SDK 直接依赖**：openhanako 自己的 Agent runtime 是为 Electron 设计，Web 形态自己长一个更合身
- **不删 better-sqlite3 换 postgres**：本地优先是优势，别学糟
- **不大改 modelProxy / billingAuth 对外接口**：营收红线
- **不上 monorepo（pnpm workspace / turborepo）**：体量不到，徒增复杂度

---

## 4. 验收总线

每个阶段结束**强制**：

- [ ] `npm test` 全绿
- [ ] `npm run lint` 0 error
- [ ] `npm run build` 成功
- [ ] 启动 `npm run serve` + 手动 smoke：登录 / 发一条聊天 / 触发一次 skill / 后台跑一个 job / 查一次 memory
- [ ] **Lens 2 扫描**（adversarial：恶意输入 / 权限越界 / 并发竞态）
- [ ] git diff main..HEAD 行数报告：实际改动 vs 预估
- [ ] 写 `RELEASE_NOTES_<stage>.md`

---

## 5. 工期与里程碑

| 阶段 | 工期 | 起止 | 产出 |
|---|---|---|---|
| 0 清场 | 0.5 天 | D0 | PR #15 merge + CI + 三件套 + README v2 |
| 1 内核抽象 | 3-5 天 | D1-D5 | `server/{core,managers,routes,adapters}/` + 测试全绿 |
| 2 Hub + Plugin SDK + i18n | 3 天 | D6-D8 | `server/hub/` + `docs/PLUGIN_SDK.md` + `examples/plugins/*` + zh/en |
| 3 Agent 交互层 | 2-3 天 | D9-D11 | `src/pages/Agent/` + SOUL/IDENTITY 集成 |

**总工期：~ 8-12 天**

---

## 6. 风险与对冲

| 风险 | 概率 | 影响 | 对冲 |
|---|---|---|---|
| 阶段 1 重组动了 modelProxy 行为，付费用户报错 | 中 | 高 | smoke 脚本 + 重构前后响应 diff + 灰度开关 `USE_NEW_FACADE=1` |
| 阶段 1 测试覆盖不到的边界 break（websocket / SSE 流式） | 中 | 高 | 阶段 1 先补 SSE 流式 e2e 测试再动 |
| Hub 独立进程引入死锁（sqlite WAL 跨进程） | 低 | 中 | 限制 Hub 只写专属表 `hub_*`，主进程不写 |
| Plugin 沙箱安全漏洞（plugin 拿到 fs/net 全权限） | 中 | 高 | 阶段 2 先研究 vm2 已废 → 用 `isolated-vm` 或干脆纯静态配置 |
| 用户中途想加 Electron | 低 | 高 | 阶段 1 的 core/managers/ 抽象天然支持后续套 Electron 壳，预留口子 |

---

## 7. 用户决策点（必须先回答再开工）

1. **阶段 0 + 1 先走？** 还是直接全包 0-3 阶段？（建议先 0+1，回头看效果再上 2+3）
2. **是否允许动 PR #15 之外的现有分支**（chore/p0-security-hardening / feat/guizang-ppt-skill 等共 10+ 未合分支）？  
   建议：**全部 review 一遍**，能 merge 的 merge、过时的 close、有价值的 rebase 到 main 后再开重构
3. **Plugin 沙箱方案偏好**？isolated-vm（重但安全） vs 纯静态配置（安全无代码） vs 信任模型（开发者本机用可信任）

---

> **iron law**：每阶段 PR 必须独立、可 revert、测试全绿、smoke 过。不允许"重构途中再重构"。
