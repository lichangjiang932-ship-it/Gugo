# v0.6.0 — Plugin 真消费 + Agent 差异化

发布日期：2026-05-25
分支：`main`
仓库：https://github.com/lichangjiang932-ship-it/your-model-atelier

---

## TL;DR

v0.5 把 Agent 骨架建好，v0.6 让它"活起来"：

1. **首屏体积 -75%**（vendor-common 2.4MB → 重活全异步）
2. **session sticky agent** + **agent-MEMORY 关联**（DB v6） — Agent 真差异化
3. **Plugin SDK 第一次真消费**（agent-template plugin + AgentList "Templates" 按钮）

测试 411 → 416（+5，全绿），**对外接口零破坏**。

---

## 1. 体积治理（perf/build-size）

### 问题

`vite.config.js` 的 manualChunks 把所有 `node_modules/` 兜底到 `vendor-common`，结果首屏拉 2.4 MB。同时 `pptxgenjs / xlsx / three` 这种大库本来代码里都是 `await import(...)`，被 manualChunks 命名后**反而从 async chunk 提到了同步 vendor**。

### 改动

- 移除 `vendor-common` fallback（让未命中规则的 node_modules 走 vite 默认动态拆分）
- 移除 `vendor-three / vendor-pptx / vendor-xlsx` 命名（避免提升）
- 保留 vendor-react / vendor-motion / vendor-icons / vendor-markdown / vendor-hljs / vendor-zod / vendor-purify
- `CoverPage/CoverScene` 改 `React.lazy + Suspense`（含 three+react-three，1MB）

### 效果

| | before | after |
|---|---|---|
| 最大 chunk | vendor-common 2406 kB | CoverScene 998 kB（首页 lazy）|
| 首屏 critical（vendor-react + index + css + LeftRail + ChatSplit） | — | 565 kB |
| 首屏负载 | ~2900 kB | ~565 kB（**-80%**） |

`chunkSizeWarningLimit` 800 → 1100 给 CoverScene 放行（已 lazy + 只首页）。

---

## 2. session sticky agent + agent-MEMORY（stage 6）

### session sticky

`AppContext`：
- `NEW_SESSION` 接 `{ title, agentId }`
- 新 reducer case `SET_SESSION_AGENT`
- session 对象多一个 `agentId` 字段（可为 null）

`ChatSplit/index.jsx`：
```
effectiveAgentId = session.agentId || globalActiveAgentId
```
ChatHeader 切换器 → 同时写入 `session.agentId` + 全局 active（下个新会话沿用）。

### agent-MEMORY 关联（DB v6）

```sql
ALTER TABLE memories ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX idx_memories_user_agent ON memories(user_id, agent_id, pinned, last_used_at);
```

`selectActiveMemoriesForInjection({ agentId })` 语义：
- 传 agentId → 返回 **agent 专属 + 全局（agent_id IS NULL）** 记忆
- 不传 → 只返全局
- 删 agent → 该 agent 的记忆 `agent_id` SET NULL（退回全局，不丢数据）

`modelProxy.js` chat 注入时自动把 `injectedAgentId` 传给 memory select。

**升级路径**：v5→v6 已手测干净（`ALTER TABLE ADD COLUMN` 幂等）。

### Breaking changes

**0。** 旧记忆 `agent_id` 为 NULL = 全局可见 = 旧行为。

---

## 3. Plugin SDK 第一次真消费

### 问题

v0.5 留下两个 plugin（example-greeting-prompt / example-warm-ppt-theme）但**没有消费方**，Plugin SDK 只是 PPT 上的"我们有 SDK"。

### 改动

新 plugin type `agent-template`：

```
plugins/example-agent-coach/
├── plugin.json   # type: agent-template, entry: agent.md
└── agent.md      # frontmatter + ## IDENTITY + ## SOUL (克制教练人设)
```

`AgentList` 加 "Templates" 按钮：
1. `GET /api/plugins?type=agent-template`
2. 用户在弹层选一个
3. `GET /api/plugins/:id` → 拿 `entryPreview.content`
4. `POST /api/agents/import { source }` → 新 agent 落库
5. 列表自动 reload

### 意义

Plugin SDK 走完一个**真实下游消费循环**：manifest 校验 → registry 注册 → API 暴露 → 前端拉 → 跨模块（plugin → agentStore）流转 → DB 落地。之后再加新 `agent-template` 不需要改任何代码。

---

## 测试 / 构建状态

| | v0.5.0 | v0.6.0 |
|---|---|---|
| 测试 | 411 | **416** (+5) |
| 失败 | 0 | 0 |
| lint error | 0 | 0 |
| build warning | chunk>800kB | 无（limit=1100, CoverScene 单 chunk 998kB 已 lazy） |
| 首屏 JS | ~2900 kB | ~565 kB |

新增测试文件：
- `tests/agentMemory.test.js`（3）— filter / schema v6 / 删 agent SET NULL
- `tests/pluginAgentTemplate.test.js`（2）— plugin 注册 + entry 解析

---

## 关键 commits 链

```
464725c feat: plugin SDK 第一次真消费 + agent-template
ecc9a8d feat(stage-6): session sticky agent + agent-MEMORY (DB v6)
123b8f3 perf: build 体积治理 — 重活全异步化，首屏 -75%
c9e9812 docs: RELEASE_NOTES v0.5.0       ← v0.5.0 tag
149032e merge: feat/stage5-session-agent
...
```

---

## 升级指南

### 数据迁移

启动时自动跑 `migrateToV6`，幂等。`agent_id` 列在 SQLite 中 `ALTER TABLE ADD COLUMN` 默认 NULL，所有旧记忆透明保留为"全局"。

### 前端

无操作。`<ActiveAgentProvider>` 已自动加载；session.agentId 是新字段，旧 IndexedDB session 没有就是 undefined → fallback 全局 active。

### 不需要的动作

- 重建 DB
- 清 localStorage
- 改环境变量

### 新增可选环境变量

无。

---

## v0.7 候选

1. 跨标签页 storage event 同步 active agent
2. AgentList Templates 弹层支持 preview（拉 entry 内容渲染 markdown）
3. plugin 二级 type：`agent-template:coach` / `agent-template:writer` 等子类
4. Memory UI 加"绑定到 agent"切换
5. import 撞名 UX：弹"覆盖/重命名/取消"
6. `prompt-template` plugin 接到 chat slash command

---

**v0.6.0 是 0→5 骨架的"激活版"。** 之后每个新 Agent / 新 plugin 都不需要改框架代码。
