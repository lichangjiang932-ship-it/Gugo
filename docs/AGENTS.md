# Agent 人格管理（阶段 3 骨架）

`SOUL.md` + `IDENTITY.md` 这一对卡片，是 OpenClaw 这类"个人 AI 工作台"的核心概念之一：
它把"模型"和"人格"解耦——同一套底层模型，可以同时承载多个 Agent，每个 Agent 有自己的口吻、底线、身份卡。

本阶段只做**管理骨架**：增删改查 + 一个默认 agent。
不动 chat 注入流程；那是阶段 4 的事。

---

## 数据模型

V5 migration 新增 `agents` 表：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `agt_` 前缀的 9 字节 base64url |
| user_id | TEXT NOT NULL | 外键 users(id) ON DELETE CASCADE |
| name | TEXT NOT NULL | 同 user 内唯一（UNIQUE INDEX） |
| soul_md | TEXT NOT NULL DEFAULT '' | SOUL.md 内容，≤ 32 KB |
| identity_md | TEXT NOT NULL DEFAULT '' | IDENTITY.md 内容，≤ 32 KB |
| avatar_url | TEXT | 头像 URL，≤ 1 KB |
| is_default | INTEGER NOT NULL DEFAULT 0 | 同 user 内只能有一个 1（在 store 层保证） |
| created_at / updated_at | INTEGER NOT NULL | ms |

索引：
- `idx_agents_user (user_id, updated_at DESC)`
- `idx_agents_user_name (user_id, name) UNIQUE`

---

## 分层

```
src/pages/AgentList.jsx           UI：列表 + 抽屉编辑器
src/lib/agentClient.js            REST 客户端
              ↓
server/routes/agentRoutes.js      HTTP
server/managers/AgentManager.js   facade
server/services/agentStore.js     业务 + SQLite
server/db.js                      v5 schema
```

## API

全部需登录（Bearer token）。

| Method | Path | 说明 |
|---|---|---|
| GET    | /api/agents          | 列出当前用户所有 agent（default 在前） |
| GET    | /api/agents/default  | 取默认 agent；无则自动 seed "Atelier" |
| GET    | /api/agents/:id      | 取详情 |
| POST   | /api/agents          | 创建：`{ name, soulMd?, identityMd?, avatarUrl?, isDefault? }` |
| PATCH  | /api/agents/:id      | 部分更新（任意字段） |
| DELETE | /api/agents/:id      | 删除 |

错误码：401（未登录）、404（agent 不存在或跨用户）、405（路径合法但方法不支持）、400（业务异常，比如同名）。

---

## 默认 Agent "Atelier"

`ensureDefaultAgent({ userId })` 是**幂等**的：
- 用户从未有 agent → 创建一个 name=Atelier、isDefault=1，预填一份克制版 SOUL + IDENTITY
- 用户已有任意 agent → 返回默认 agent（如果没有默认，返回最新更新的那个），不新建

前端 AgentList 第一次进入时如果列表为空，会先 `GET /default` 触发 seed，再 reload 列表。

---

## 红线（未来扩展时不要踩）

1. `name` 同 user 内唯一——更新时撞名会抛错，前端要捕获
2. `isDefault=true` 互斥——store 层在事务里把同 user 的其它 default 清零
3. SOUL/IDENTITY 单卡片最长 32 KB；超长直接抛错（前端 textarea 不限制，依赖后端 clamp）
4. **不要**把 SOUL/IDENTITY 内容当 system prompt 直接拼到模型请求里——那是阶段 4 的注入策略，要考虑 token 预算、与 MEMORY/SKILL 的注入顺序
5. agent 不应该写入跨用户数据。所有 store 函数都签名带 `userId` 强制隔离

---

## 测试

- `tests/agentStore.test.js` — 6 个用例：CRUD / 用户隔离 / 同名拒绝+default 互斥 / ensureDefault 幂等 / 输入校验 / 跨用户删除
- `tests/agentRoutes.test.js` — 4 个用例：401 / 完整路径 CRUD / default 自动 seed / 404+405
- `tests/managersFacade.test.js` — 追加 AgentManager 转发同源断言

总：阶段 3 新增 11 个测试。

---

## 阶段 4 预告

- `chat` 流程进入前注入 agent context：`<system>SOUL.md + IDENTITY.md</system>` 拼到 messages[0]
- 切 agent UI（聊天页右上角下拉）
- agent 维度的 MEMORY 关联（让不同 agent 看到不同记忆切片）
- agent export/import（一个 `.agent.md` 文件含双卡 + frontmatter）


---

## 阶段 4 已落地：chat 注入 + export/import

### chat 注入

`server/adapters/modelProxy.js` 的 chat handler 在 memory 注入**之前**，先 unshift 一个 system block：

```
# Agent: <name>

## IDENTITY
<identity_md>

## SOUL
<soul_md>

Follow the persona above. Stay in character.
```

- 使用 `ensureDefaultAgent({ userId })` 拿当前用户的默认 agent
- 顺序：`[agent system] → [memory system] → ...rest`
- 开关：`AGENT_INJECT_ENABLED=0` 可关闭（默认开）
- 任何异常 try/catch 吞掉，不阻断 chat（与 memory 注入同策略）

### export

`GET /api/agents/:id/export` 返回 `text/markdown`：

```
---
name: "Atelier"
avatar_url: ""
exported_at: 2026-05-25T13:00:00.000Z
---

# Atelier

## IDENTITY
...

## SOUL
...
```

### import

`POST /api/agents/import { source }` 解析上述格式，创建新 agent（不抢 default）。
容错：
- 没 frontmatter → 从首个 `# H1` 取 name；缺 H1 → "Imported Agent"
- 没 `## IDENTITY` / `## SOUL` → 把全文当 SOUL
- 撞名 → 抛 400（前端捕获展示）

---

## 阶段 5 已落地：session 维度切 agent

### 后端

`POST /api/model/chat` 现在接收 `body.agentId`：
- 传入且属于该 user → 注入指定 agent 的 SOUL/IDENTITY
- 未传 / 跨用户 / id 不存在 → silently fallback 到该 user 的 default agent
- 错误不阻断 chat（沿用阶段 4 策略）

### 前端

新增 `src/agents/`：
- `activeAgentContext.js` — `ActiveAgentContext` + `useActiveAgent()` hook（拆出便于 react-refresh）
- `ActiveAgentProvider.jsx` — Provider，localStorage 持久化 `***`，启动拉一次 list，本地 id 失效自动 fallback

`src/App.jsx`：包 `<ActiveAgentProvider>`

`ChatHeader.jsx`：右上角加紧凑 `<Users icon> + <select>`，无 agent 列表时不渲染

`ChatSplit/index.jsx`：`useActiveAgent()` 取 `activeAgentId` 传给 `callModelThroughProxyStream({ agentId })`

`AgentList.jsx`：CRUD 后调 `refreshActiveAgent()`，保证切到/删掉时 ChatHeader 立刻同步

### 关键约束

- 一个浏览器同一时刻只有一个 active agent（不区分 session）
- localStorage key `***`，跨标签页通过 storage event 同步留给后续
- 切 agent 不影响历史消息已注入的 system block（只影响下一次请求）

## Prompt Compiler（FreshCompact 风格）

`server/services/promptCompiler.js` 将 chat 前置上下文拆成 4 个独立 system block：

| block | 内容来源 | 说明 |
|---|---|---|
| identity | `agent.id/name/identityMd/avatarUrl/personaTemplate` | Agent 标题、persona template、IDENTITY |
| ishiki | `agent.id/soulMd/personaTemplate` | SOUL 与收尾行为约束；与 IDENTITY 文本变更隔离 |
| skills | 当前用户 runtime skills + `skillIds` | 选中 skill 的 manifest 与 system prompt |
| sessions | `sessionId/recentMessages` + compaction archive | 最近 tail summary；若消息带 archiveId，则只读最近一份 compaction archive summary |

每块先把参与编译的输入做稳定 JSON 序列化（对象 key 排序），再计算 `sha256`，取前 16 位 hex 作为 fingerprint。空输入返回 `fingerprint: "empty"`，调用方跳过注入。

缓存是进程内 LRU，按块隔离：identity / ishiki / skills / sessions 各 64 项，key 为 `${blockType}:${fingerprint}`，value 为已编译文本。命中时直接返回缓存文本，不再重新拼装字符串；`getPromptCompilerStats()` 暴露 hits/misses/size，`clearPromptCompilerCache(blockType?)` 供测试清理。

---

## 阶段 6 已落地：session sticky + agent-MEMORY + plugin 真消费

### session sticky agent
- AppContext NEW_SESSION 可带 `{ agentId }`；新 case `SET_SESSION_AGENT`
- ChatSplit 优先用 `session.agentId`，回落到全局 active；切换器同时写两处
- 不影响历史消息（只影响下一条请求）

### agent-MEMORY 关联（DB v6）
- memories 加可选 `agent_id`（`ON DELETE SET NULL`）
- `selectActiveMemoriesForInjection({ agentId })`：传则返"全局 + 该 agent"，不传只返全局
- chat 注入处自动传 `injectedAgentId`
- v5→v6 升级路径已手测
- breaking = 0：旧记忆 `agent_id IS NULL` = 全局 = 旧行为

### plugin 第一次真消费：agent-template
- 新增 plugin type `agent-template`
- `plugins/example-agent-coach/` 一个克制的教练 agent 模板
- AgentList 新按钮 "Templates"：列 agent-template plugins，一键 import
- 路径：`GET /api/plugins?type=agent-template` → 用户选 → `GET /api/plugins/:id` 拿 `entryPreview.content` → `POST /api/agents/import`
- 验证 Plugin SDK 不是 PPT 展示，真有消费方

---

## 阶段 7-11 已落地：schema 演进概览

文档以 Agent 视角写，但 DB 还在并行长其它能力。下表是 v6→v11 实际加进 `server/db.js` 的迁移，标注哪些直接动了 agents/相关字段、哪些是平行能力：

| 版本 | 迁移函数 | 主题 | 表/字段 | 与 Agent 的关系 |
|---|---|---|---|---|
| v7 | `migrateToV7` | A3：Agent 绑定 persona 模板 | `agents.persona_template` (TEXT) | **直接相关**——agent 可选挂一个内置 Yuan/persona 模板名 |
| v8 | `migrateToV8` | A6：统一通知中心 | `notifications` 表 (kind: info/success/warn/error/job + read_at) | 平行能力，agent 后续可作为通知来源 |
| v9 | `migrateToV9` | A4：Chat sessions archive + 跨会话搜索 | `sessions` 扩列 (id/title/updated_at/last_viewed_at/archived_at)、`messages` 表、`messages_fts` (fts5 unicode61) + 三个 triggers | 不动 agents，但 chat 注入路径会落地到这里 |
| v10 | `migrateToV10` | S2：Studio cron + per-agent heartbeat | `cron_jobs` 表 (kind: heartbeat/cron, exec_type: agent_session/direct_notify/plugin_action, `agent_id` FK ON DELETE SET NULL) | **直接相关**——心跳/定时任务可绑定到具体 agent |
| v11 | `migrateToV11` | S1：多 agent 频道（DM/Group） | `channels` + `channel_agents` (PK=channel_id+agent_id) + `channel_messages` + `channel_messages_fts` | **直接相关**——agent 与 user 之间的多对多协作通道，并行于 sessions/messages |

### 与上面阶段 3-6 叙事的衔接

- **agent persona_template (v7)**：`agentStore.createAgent / updateAgent` 接受可选 `personaTemplate`，模板表定义在 `server/services/agentTemplates.js`，通过 `getAgentTemplateSystemPrompt(name, { lang })` 渲染。chat 注入时若有 personaTemplate，会在 `## SOUL` 之前追加一段 `## PERSONA TEMPLATE`，三段拼成完整 system block。export/import (`.agent.md`) frontmatter 也带 `persona_template` 字段。
- **per-agent cron (v10)**：`cron_jobs.agent_id` 可空——空 = 全局任务；非空 = "以这个 agent 的身份"在 tick 时跑（exec_type=`agent_session` 走 `ensureDefaultAgent`-like 注入路径）。**红线**：删 agent 时不级联删 cron，而是 `SET NULL`，让任务退化为全局，避免静默丢任务。
- **channels (v11)**：channels 是一条独立路径，**不复用** `sessions/messages`。原因：sessions 是"一 user 对一 agent"的线性 chat；channels 是"一 user 对多 agent" + 可 `@mention`，sender_kind 同时包含 `user` 和 `agent`，路由逻辑差异大。两套表暂时不互通，迁移留给后续阶段。
- **v12**：integrations 表（社交媒体/IM/视觉副驾凭据，per-user CRUD + 测试连通性）

### 当前 schema 版本

```js
// server/db.js
export const DB_SCHEMA_VERSION = 12
```

新增迁移时记得：
1. 写 `migrateToVN(db)`，幂等（`IF NOT EXISTS` / `hasColumn` 守门）
2. 末尾 `setSchemaVersionInternal(db, N)`
3. 在 `runMigrations` 链里追加
4. `DB_SCHEMA_VERSION` 同步更新
5. 跨主表新增 FK 用 `ON DELETE SET NULL`（任务/记忆）或 `ON DELETE CASCADE`（强从属），不要默认 RESTRICT
