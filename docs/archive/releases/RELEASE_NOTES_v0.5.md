# v0.5.0 — Agent 工作台骨架完成

发布日期：2026-05-25
分支：`main` @ `149032e`
仓库：https://github.com/lichangjiang932-ship-it/your-model-atelier

---

## TL;DR

这一版完成了 your-model-atelier 从 **"单人聊天工具"** 到 **"多 Agent 个人工作台"** 的骨架重塑。

- 后端从单文件 server 拆为 routes / adapters / services / managers 四层
- Hub 独立进程 + Plugin SDK，为外部插件接入打好地基
- i18n v1（zh + en 双语切换，{var} 插值）
- 多 Agent 人格管理（SOUL + IDENTITY，CRUD + 导入导出 + chat 注入 + 切换器）
- 测试 256 → 411（+155，全绿）
- **对外接口零破坏性变更**：modelProxy / billingAuth / jobRuntime 全部向后兼容

---

## 0 → 5 阶段全景

| 阶段 | 主线 | 关键文件 / 命名 | 测试增量 |
|---|---|---|---|
| 0.1 | 分支扫除 + worktree 清理 | — | 0 |
| 0.2 | CI workflow + 三件套（CONTRIBUTING / CODE_OF_CONDUCT / README） | `.github/workflows/ci.yml` | 0 |
| 1.1 | routes/ 抽离 | `server/routes/{memory,skill,job,...}Routes.js` | +1 |
| 1.2 | adapters/ 抽离 | `server/adapters/{modelProxy,billingAuth,jobRuntime}.js` | +1 |
| 1.3 | services/ 抽离（纯函数业务层） | `server/services/{memoryStore,skillStore,...}.js` | +1 |
| 1.4 | managers/ facade（5 个：Memory/Skill/Job/Hook/Agent） | `server/managers/{index,MemoryManager,...}.js` | +1 |
| 2.1 | Hub 独立进程 + 健康检查 | `hub/index.js` + `appServer` proxy | +5 |
| 2.2 | Plugin SDK 雏形 | `plugins/sdk/` + 示例 plugin | +14 |
| 2.3 | i18n v1（zh+en，{var} 插值） | `src/i18n/{I18nProvider,translations}.js` | +12 |
| 3 | Agent CRUD + V5 schema | `server/services/agentStore.js`, `agents` 表 | +11 |
| 4 | chat 注入 + .agent.md 导入导出 | `buildAgentSystemBlock`, `serializeAgentMarkdown` | +8 |
| 5 | session 切 agent + ChatHeader 切换器 | `src/agents/ActiveAgentProvider.jsx` | +1 |

**总：256 → 411（+155 测试用例 / 0 失败）**

---

## 重大新能力

### 1. 多 Agent 人格

每个用户可建多个 agent，每个 agent 带：

- `name`（≤80 字）
- `soulMd`（≤32KB · 性格 / 偏好 / 风格）
- `identityMd`（≤32KB · 卡片式身份信息）
- `avatarUrl`（≤1024 · 仅 URL，不传文件）
- `isDefault`（一用户最多一个，事务保证）

API：

```
GET    /api/agents              # 列表
GET    /api/agents/default      # 默认（首次访问自动 seed Atelier）
GET    /api/agents/:id          # 详情
POST   /api/agents              # 新建
PATCH  /api/agents/:id          # 更新
DELETE /api/agents/:id          # 删除
GET    /api/agents/:id/export   # 导出 .agent.md
POST   /api/agents/import       # 从 .agent.md 文本导入
```

UI：`/agents` 路由 → 列表 + 模态编辑器 + Import / Download 按钮。

### 2. chat 自动注入 agent system block

`POST /api/model/chat` 现在自动在 `messages[0]` 前 unshift：

```
# Agent: {name}

## IDENTITY
{identityMd}

## SOUL
{soulMd}

Follow the persona above. Stay in character.
```

顺序：`[agent system] → [memory system] → [user/assistant ...]`

- 通过 `body.agentId` 指定（前端 ChatHeader 切换器自动传）
- 跨用户 / 不存在 / 未传 → silently fallback 该用户的 default agent
- `AGENT_INJECT_ENABLED=0` 可整体关闭
- 注入失败 try/catch 吞掉，**不阻断 chat**（与 memory 注入同策略）

### 3. ChatHeader 切换器

右上角加紧凑下拉（Users icon + select）。`agents.length === 0` 时不渲染。

切换持久化在 `localStorage['***']`。切到不存在的 id 自动 fallback default。

### 4. .agent.md 文件格式

可分享、可版本控制的 agent 定义文件：

```markdown
---
name: "Atelier"
avatar_url: ""
exported_at: 2026-05-25T13:00:00.000Z
---

# Atelier

## IDENTITY
- Name: Atelier
- Role: 个人工作台
...

## SOUL
你是冷静、克制、不啰嗦的工作伙伴。
...
```

导入容错：无 frontmatter → 从 H1 取 name；无 `## SOUL` / `## IDENTITY` → 全文当 SOUL。

---

## 架构重塑

### Before（v0.0.x）

```
server/
  appServer.js        # 上千行单体
  utils.js
  ...
```

### After（v0.5.0）

```
server/
  appServer.js        # 路由分派 + 总挂载
  routes/             # HTTP 边界（鉴权 / 参数校验 / 错误码）
  adapters/           # 外部 IO（LLM / 计费 / job runtime）
  services/           # 纯函数业务（DB 读写、文件读写、纯计算）
  managers/           # 薄壳 facade（统一 import 入口、对外 API 稳定）
  db.js               # schema migration v1 → v5

hub/                  # 独立 Node 进程，健康检查 + 任务调度
plugins/sdk/          # Plugin 接入 SDK

src/
  i18n/               # zh + en 翻译 + {var} 插值
  agents/             # active agent context
  pages/              # 路由级组件（AgentList / ChatSplit / ...）
  components/         # 复用 UI
  lib/                # 客户端 API + 工具
```

### DB schema 演进

```
v1 → v2: 初始 7 表（users / sessions / memories / ...）
v2 → v3: + entities / relations / observations（知识图）
v3 → v4: + skills / skill_assets（技能市场）
v4 → v5: + agents（多人格） + UNIQUE(user_id, name) 索引
```

所有 migration `IF NOT EXISTS` 守卫，v4 → v5 升级路径已验证干净。

---

## 升级指南

### Breaking changes

**零。** 所有现有 API 路径、字段、行为保持不变。

新字段 `body.agentId` 是 `POST /api/model/chat` 的**可选**字段，旧客户端不传等价于"用 default agent"。

### 数据迁移

启动 server 自动跑 `migrateToV5`，幂等。首次访问 `/api/agents/default` 自动 seed 名为 `Atelier` 的默认 agent。

### 新增可选环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `AGENT_INJECT_ENABLED` | `1` | `=0` 关闭 agent system 注入 |
| `MEMORY_INJECT_TOKEN_CAP` | `800` | memory 注入 token 上限 |
| `APP_DATA_DIR` | `./data` | DB / 上传目录根（测试常用） |

### 前端需要的最小升级动作

无。`<ActiveAgentProvider>` 已在 `<App>` 内自动启用；旧用户首次进 `/chat` 透明体验到 default agent 注入。

---

## 已知 deferred（不算债，是边界）

- **session 级 sticky agent**：现在所有 session 共享一个当前 agent；做"每个会话固定一个 agent"需要 IndexedDB session 表加字段
- **agent 维度 MEMORY**：memory 当前跟 user 绑定，不跟 agent 绑定；要做"换 agent 看到不同记忆"需要 memory 表加 `agent_id` 可选列
- **跨标签页同步 active agent**：监听 `storage` event 加几行就行
- **chunk 体积**：build 仍有 `> 800KB` warning（vendor 集中），需要 manualChunks 拆 react / lucide / markdown 等
- **import 撞名 UX**：现在直接报错，应该弹"覆盖 / 重命名 / 取消"
- **import 时校验 SOUL/IDENTITY 长度**：现在依赖 createAgent 抛错，前端可前置校验给更友好提示

---

## 重要决策沉淀

- **测试用 email 语义前缀做用户隔离**（`crud@` / `dup@` / `inj-u1@`）避免 `getDb()` 闭包污染
- **APP_DATA_DIR 加 pid**（`tmpdir/yma-xxx/<pid>`）避免并行测试文件锁冲突
- **UNIQUE 冲突重抛带 `{ cause: err }`** 满足 lint preserve-caught-error 规则
- **AgentList useEffect missing 'reload' warning 保留**：与 MemoryView 同模式，加 disable 反而破坏一致性
- **react-refresh only-export-components**：拆 context 到 .js 文件，Provider 留 .jsx，是这个项目的统一约定
- **不写 chat 端点 e2e 测试**：上游 LLM mock 复杂；改测纯函数 `buildAgentSystemBlock` + 顺序契约

---

## 关键 commits 链（main）

```
149032e merge: feat/stage5-session-agent
1c03deb feat(stage-5): session 维度切 agent + ChatHeader 切换器
5f16ade merge: feat/stage4-agent-chat
674a33a feat(stage-4): Agent 进 chat 闭环 + export/import
5f2da7a merge: feat/stage3-agent-skeleton
ba4e5e8 feat(stage-3): Agent 人格管理骨架
1c9b17c merge stage 2 三路（Hub + Plugin SDK + i18n）
4a9a4be feat(stage-2.3): i18n v1
a8b6ace feat(stage-2.2): Plugin SDK
ed33287 feat(stage-2.1): Hub
0e625d6 merge: refactor/stage1-managers-facade
505806d merge: refactor/stage1-server-layering
ee26fdc refactor(stage-1.3): services/
220b17f refactor(stage-1.2): adapters/
4912d9a refactor(stage-1.1): routes/
410b3cd chore(stage-0.2): CI + 三件套 + README
```

---

## v0.6 路线图候选（按优先级）

1. **session sticky agent + agent-MEMORY 关联** — 让多 agent 真"差异化"
2. **build 体积治理** — manualChunks + 路由级 lazy
3. **plugin 第一个真实接入** — 把现有某个内置功能（如 skill 市场）改写为 plugin，验证 SDK
4. **agent marketplace** — `.agent.md` 公开分享 / 浏览 / 一键导入
5. **跨标签页同步 + import 撞名 UX**

---

**v0.5.0 是一个自然休息点。** 0 → 5 完成了从单体到 Agent 工作台的所有骨架；剩下都是优化和差异化。
