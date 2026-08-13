# AGENTS.md

> Codex / Claude Code 进项目第一件事：**读完本文档，再动手**。
> 这是项目主人沉淀的偏好、红线和约定。违背它写代码 = 我会让你重写。

---

## 一、项目是什么

**Gugo**（yma）—— 浏览器即用的本地/内网 Web AI 工作台。React 19 SPA + Node.js HTTP（**零框架**） + SQLite（better-sqlite3, WAL）。和 Claude Code / Cursor / Cherry Studio / openhanako 同品类，但走 Web 路线。

当前：v0.10.24 · DB schema **v49** · **383 个 test 文件** · 零后端框架依赖。

---

## 二、给 AI 助手的核心规则（违反 = 重做）

### 2.1 沟通方式（中文项目，回话也用中文）

- **只给结果，别给过程**。不要"我做了 1/2/3..."，不要"主要变化"，不要"下一步建议"。merge 完只汇报当前真实测试数。
- **能用表就用表**，别写散段。状态汇报固定格式：

  ```
  | 批 | 状态 | 备注 |
  |---|---|---|
  | C1 | ✅ 合 main | 全量测试通过 |
  | C2 | 🔄 跑中 | feat/c2-xxx |
  ```

- **群里克制**。这是用户群聊环境，多余的话是噪音。

### 2.2 任务连续失败 3 次 → 立即停下汇报

不要无限重试。不要静默换方案。**汇报失败原因 + 已试方案 + 等用户决定**。

### 2.3 后端 PR 不要等前端

后端能力闭环（schema + service + route + adapter）先**独立**合 main。前端 UI 走后续 PR。**不要**为了"一次交付完整功能"把后端阻塞在长 PR 里。后端只要 `node --check` + 相关 test 绿就该 commit/push/PR/merge。

### 2.4 不要瞎拆 batch、不要瞎合 batch

- 一个**真 bug 在 leaf 文件**（一个组件/一个函数）+ 一个**改 build 链/runtime infra** = **拆两个 batch**。前者 30 分钟落地，别拖在后者卡点里。
- 文档 + i18n + 测试是**顺手**的事，不要单独开 batch 浪费 review 配额。codex 一次性带上。

### 2.5 不准做的事

1. **不要改 `server/db.js` 的旧 migration 函数**。要加字段就写 `migrateToVN+1`，把 `DB_SCHEMA_VERSION` 推一档。
2. **不要把 SOUL/IDENTITY 直接塞 messages[0]**，那是 `promptCompiler.js` 的活，走 4-block 编译路径。
3. **不要在 prompt 注入路径里 throw**。沿用现有 try/catch 吞错 + 不阻断 chat 的策略。
4. **不要新增后端框架依赖**（express/fastify/koa 都不要）。本项目是零框架 HTTP，手写 router + middleware 是设计选择，不是"还没来得及迁"。
5. **不要在 chat handler 里同步跑慢 I/O**。耗时 > 50ms 的活进 `jobRuntime` / `subagentRuntime`。
6. **不要 import `lucide-react` 里的 `Github`**（这个包没有 `Github` 这个 named export，会构建失败）。要 GitHub 图标用 inline SVG 或换 `GitBranch`。
7. **不要新增 `console.log`**。统一走现有的日志路径。debug 用 `console.error` 临时打，PR 前清干净。

---

## 三、目录约定（别走错门）

```
server/
├── adapters/       # 上游/外部协议适配（modelProxy, visionAssist, social/*）
├── core/           # lifecycle 启动序列、plugin/cron/integration bootstrap
├── managers/       # facade（薄壳，转发到 services/）
├── services/       # 业务逻辑 + SQLite（所有 store 都在这）
├── routes/         # HTTP 路由（薄壳，参数校验 + 调 service + 写 response）
├── plugins/        # plugin loader / registry / sandbox / manifest
├── mcp/            # MCP 客户端（stdio + SSE）
├── hub/            # 独立 Hub 进程入口（HUB_ENABLED=1）
├── utils/          # 纯函数工具，不能 import services/
├── db.js           # ⚠️ 改这里 = 加 migration
├── middleware.js   # 安全头/CORS/CSP/鉴权
└── appServer.js    # HTTP 入口
src/
├── pages/          # 顶层页面（AgentList/ChannelsPage/ChatSplit/...）
├── components/     # 可复用组件
├── lib/            # 客户端 REST helper、纯工具
├── store/          # AppContext + reducer + localStorage 持久化
├── agents/         # ActiveAgentProvider + context
└── i18n/           # 5 语言 translations.js + I18nProvider.jsx
tests/              # node:test，每个 .test.js 对应一个 service/route
scripts/
└── run-tests.js    # node --test 包装；npm test 走这里
```

**分层红线**：
- `routes/` 只做"HTTP ↔ service"翻译。**不准**写业务逻辑。
- `services/` 是业务 + DB，不准 import `routes/` 或 react 任何东西。
- `managers/` 是 facade，**禁止**在 manager 里写新业务——直接转 services 就行（保持文件薄）。
- `utils/` 必须纯函数，无副作用，无 DB，无 IO。

---

## 四、加新功能的标准动作

### 4.1 后端新能力

1. **DB schema 改动**：`server/db.js`
   - 写 `migrateToVN+1(db)`，幂等（`IF NOT EXISTS` / `hasColumn` 守门）
   - 末尾 `setSchemaVersionInternal(db, N+1)`
   - `runMigrations` 链尾追加
   - `DB_SCHEMA_VERSION` 改成 N+1
   - 跨表 FK 用 `ON DELETE SET NULL`（任务/记忆）或 `ON DELETE CASCADE`（强从属）。**不要默认 RESTRICT**。
2. **业务逻辑**：`server/services/xxxStore.js` (或 `xxxService.js`)
   - 所有函数签名带 `userId`（强制隔离），不准跨用户写
   - 用 better-sqlite3 prepared statement，不要拼字符串
3. **HTTP route**：`server/routes/xxxRoutes.js`
   - 路径前缀 `/api/xxx`
   - 401 未登录 / 404 资源不存在或跨用户 / 405 方法不支持 / 400 业务异常 / 500 内部
   - 错误返回 JSON `{ error: { code, message } }`
4. **manager facade**（如果有跨 service 协调）：`server/managers/XxxManager.js`，薄壳
5. **测试**：`tests/xxxStore.test.js` + `tests/xxxRoutes.test.js`
   - store 必测：CRUD / 用户隔离 / 边界 / 输入校验
   - route 必测：401 / 完整路径 happy-path / 错误码
   - 用 `mkdtempSync(...)` 隔离 DB；每个 test 用不同 email 避免 user 串载

### 4.2 前端新页面

1. `src/pages/XxxView.jsx`（或子目录如 `ChatSplit/index.jsx`）
2. `src/lib/xxxClient.js` REST 调用
3. `src/i18n/translations.js` 加 5 语言 key（zh/en/ja/ko/zh-TW）—— **5 语言必须全加**，不准只加中文
4. `src/store/` 里如果要持久化，走现有的 AppContext reducer pattern
5. 导航入口：`src/components/LeftRail.jsx`

### 4.3 plugin 新类型

`server/plugins/pluginManifest.js` 加进 `PLUGIN_TYPES` 枚举（已有 5 种：ppt-theme / prompt-template / asset-pack / agent-template / skill-bundle）。**必须有真消费方**（参考 agent-template 接到 AgentList "Templates" 按钮），不要做 PPT 展示。

---

## 五、测试 / lint / build

```bash
npm run lint          # ESLint，必须 --max-warnings 0 通过
npm test              # node:test，全量用例必须全绿
npm run build         # vite build，生成 dist/
npm run dev           # vite HMR :5175
npm run serve         # 仅启动 node 后端（需先 build）
npm run local         # build + serve
```

**CI 矩阵**：`.github/workflows/ci.yml` 跑 `ubuntu-latest` + `windows-latest`（required gate）。Node 20。任何 PR 必须 windows 也绿才能合。

**Windows pitfall**：
- `worker_threads` 冷启动 ~1000–1100ms。任何 sandbox/plugin/timeout 默认值 `< 5000ms` 都会在 windows runner 上 flake。默认设 5000ms。
- `path.join` 用 `path.posix.join` 处理 URL 类路径（CSP nonce / artifact 路径）。
- `\r\n` 换行：测试比对字符串前 `.replace(/\r\n/g, '\n')`。

**CI 跑 test 前不会 build**：测试如果依赖 `dist/index.html` 存在，**测试自己**要写一个占位 + cleanup，不要去改 workflow 顺序。

---

## 六、Git / PR / commit 约定

### 6.1 分支命名

| 前缀 | 用途 | 例 |
|---|---|---|
| `feat/<batch>-<slug>` | 新功能 | `feat/c1-patch-approval-vision` |
| `fix/<batch>-<slug>` | bug 修复 | `fix/f4-markdown-sanitize-csp-nonce` |
| `chore/<batch>-<slug>` | 杂项（CI/依赖/配置） | `chore/f7-windows-required-gate` |
| `docs/<slug>` | 纯文档 | `docs/progress-sync-v010` |

batch id 约定（用户分配）：`S1..S6` / `A1..A6` / `B*` / `C1..Cn` / `F1..Fn` / `U1..Un` / `P0..Pn`。

### 6.2 commit message

格式：`<type>(<scope>): <短描述>`
- 例：`feat(channels): add v11 channel store`、`fix(f6): Windows CI green (19 → 0 fail)`
- 顺手提交的文档/i18n：加 `(C1 顺手)` 后缀，例 `docs(readme): 标 Hub 已实现 (C1 顺手)`
- 中文 OK，英文 OK，**别混**。一个 commit 选一种语言。

### 6.3 PR 标题

跟随 commit。**不要写 Co-Authored-By: Claude / Generated by Codex** 这类标注。

### 6.4 merge 策略

- 默认 `--no-ff`（保留分支历史）
- `main` 不直接 push；走 PR + squash 或 PR + merge commit（看 PR 大小）
- merge 前 verify：`npm run lint && npm test`，windows CI 绿

---

## 七、I18n

**5 语言**：`zh / en / ja / ko / zh-TW`。`src/i18n/translations.js` 是单一来源。

新 UI 加新 key 必须 5 语言都填。**别留 TODO/占位**——如果某语言不会写，至少给英文兜底（不要给中文兜底，因为日文/韩文用户看不懂）。

key 命名：`<domain>.<feature>.<element>`，例 `channels.list.empty`、`agents.editor.saveButton`。

---

## 八、环境变量

完整列表见 `.env.example`。核心：

| 变量 | 必填 | 说明 |
|---|---|---|
| `MODEL_BASE_URL` / `MODEL_NAME` / `MODEL_API_KEY` | 是 | 单 provider 模式 |
| `MODEL_PROVIDERS` | 否 | 多 provider 路由（如 `deepseek,mimo`），启用后用 `MODEL_PROVIDER_<ID>_*` |
| `MODEL_NAMES_VISION` | 否 | 视觉模型名（逗号分隔） |
| `AGENT_INJECT_ENABLED` | 否 | `0` 关闭 agent persona 注入 |
| `WORKSPACE_FS_ENABLED` / `WORKSPACE_SHELL_ENABLED` / `WORKSPACE_GIT_ENABLED` | 否 | 文件/Shell/Git 工具开关 |
| `MCP_STDIO_ALLOWED_COMMANDS` | 否 | MCP stdio 命令白名单 |
| `APP_DATA_DIR` / `APP_DB_PATH` | 否 | 数据目录 / SQLite 路径 |
| `PORT` | 否 | HTTP 端口，默认 5175 |
| `HUB_ENABLED` | 否 | `1` 启用独立 Hub |

**新加 env 必须同步改 `.env.example`**，否则用户拿不到。

---

## 九、Prompt Compiler（chat 注入路径，改这里要谨慎）

`server/services/promptCompiler.js` 把 chat 前置上下文拆成 **4 个独立 system block**：

| block | 内容 | 缓存 fingerprint 来源 |
|---|---|---|
| `identity` | agent name / IDENTITY.md / persona template | agent.id+name+identityMd+avatarUrl+personaTemplate |
| `ishiki` | SOUL.md + 收尾约束 | agent.id+soulMd+personaTemplate |
| `skills` | 用户 runtime skills + skillIds | skill manifest hash |
| `sessions` | 最近消息 tail + compaction archive | sessionId+recentMessages+archiveId |

每块独立 fingerprint（sha256 前 16 hex），独立 LRU（各 64 项）。这是**性能关键路径**，不要：
- 把 block 合并成一个大字符串（破坏缓存隔离）
- 把易变字段（时间戳、随机数）塞进 fingerprint 输入
- 在 compile 时同步跑 DB 查询（先在 caller 把数据查好传进来）

注入顺序：`identity → ishiki → skills → sessions → memory → ...rest`。**别改顺序**。

---

## 十、和 openhanako 对标的功能映射

我们项目对标 openhanako（Electron 桌面 AI 工作台），实现路径不同但能力对齐：

| openhanako 能力 | yma 实现 |
|---|---|
| Manager facade | `server/managers/*` |
| 独立 Hub | `server/hub/` + `HUB_ENABLED=1` |
| Plugin SDK | `server/plugins/` + `docs/PLUGIN_SDK.md`（已删，等下个 PR 重写） |
| SessionFile sidecar | `sessionStore` + `compaction_archive` 表 |
| 角色卡 | agent + `.agent.md` 导出 / zip 导入（v0.9） |
| 跨平台 bridge | `server/adapters/social/*` + `integrations` 表（v0.10） |
| 视觉副驾 | `visionAssist.js`（无视觉模型时图→文回退） |

不要在 PR 描述里写"对标 openhanako 的 XX 功能"——直接描述能力即可。

---

## 十一、常见踩坑（按出现频次排）

1. **改了 service 忘改 route 的 response 字段** → route 测试里 `assert.equal(body.field, ...)` 会挂。先跑相关 test 文件。
2. **加 DB 字段忘改 prepared statement 的 column 列表** → SQL 报 `no such column` 或 silent skip。grep `INSERT INTO <table>` 全文找补。
3. **i18n 只加了中英文** → 日韩繁体三语 fallback 到 key 字符串，UI 上显示成 `channels.list.empty`。lint 时会报 missing key。
4. **frontend `useEffect` 缺依赖** → eslint-plugin-react-hooks 会报，**不要** `// eslint-disable-next-line`，是真有 bug。
5. **better-sqlite3 prepared statement 跨 user 复用** → 不准。每次操作都要把 `userId` 当 param 传进去。
6. **写 plugin 忘加 manifest type 校验** → loader silently skip。`pluginManifest.js` 的 `PLUGIN_TYPES` 是 source of truth。
7. **CSP nonce 拼错** → `script-src 'nonce-...' 'strict-dynamic'`，不要 `'unsafe-inline'` 回退。`tests/cspNonce.test.js` 守这条。
8. **给模型调用加"整请求超时"** → 见下面第十二节。本地模型正在正常吐字也会被砍断。要加只能加 idle 超时。
9. **测试里走真 planner / 真模型** → 单个用例几十秒、要配 key、断言随模型措辞变化随机变红。用 `planner:` / `runModel:` 注入 stub，见 `tests/jobRuntime.test.js`。

---

## 十二、本地模型支持约定（改模型链路前必读）

本项目要同时支持 **Ollama / LM Studio / llama.cpp / vLLM / 云端自定义 API**。本地推理和云端 API 的性能特征完全不同，下面这些是踩过坑之后定下的规矩。

### 12.1 唯一的能力判断入口：`server/utils/endpointProfile.js`

「这个端点是什么、能干什么、该给多少耐心」全部由 `resolveEndpointProfile()` 回答。**不要**在别处重新猜端点类型、上下文窗口、是否支持工具。纯函数、无 IO，探测结果作为 `overrides` 传进去。

```js
resolveEndpointProfile({ baseUrl, modelName, env, overrides }) → {
  kind, isLocal, timeouts: { probeMs, firstTokenMs, idleMs, requestMs, backgroundMs },
  contextWindow, supportsTools, supportsStreaming, supportsVision, failoverEligible, keepAlive,
}
```

adapters 层用 `profileForConfig(config, env)` 拿画像。

### 12.2 超时必须是「首 token + idle」双轨，绝不能是整请求超时

- **首 token 超时**：从发请求到第一个字。本地加载几个 G 的权重可能要几分钟。本地默认 10 分钟。
- **idle 超时**：两个 chunk 之间的最大间隔，**每收到一个 chunk 就重置**。含义是「N 秒一个字节都没有 = 连接死了」。

只要模型还在吐字，就永远不该有上限 —— CPU 上 1 tok/s 也要让它跑完。`tests/modelProxyTimeout.test.js` 守这条。

### 12.3 超时错误**不准带 `status`**

用 `modelTimeoutError()` 造，它给 `code: 'MODEL_TIMEOUT'` 但不给 status。原因：曾经把超时伪装成 `status: 504`，而 `isProviderFailoverError` 判定 `>= 500` 可转移 —— 结果「本地模型慢了一下」= **静默切到云端 provider 并产生意外的上游 API 成本**，用户既不知道换了模型，也无法控制预算。

同理 `modelRetry.js` 里 `MODEL_TIMEOUT` 不重试：对着单槽推理服务器重试 3 次只会更慢。

### 12.4 本地端点默认不参与 failover

`resolveModelFailoverConfigs` 在主 provider 是本地时只返回它自己。用户要这个行为可以在 provider 设置里显式打开 `failover_enabled`。

### 12.5 SSE 必须有心跳

`flushHeaders()` + `X-Accel-Buffering: no` + 每 15s 一个 `: keepalive` 注释帧。本地模型冷启动时几十秒一个字节都没有，任何中间层（nginx 默认 60s）都会掐断。另外首 token 前要发 `phase: 'connecting'` 帧，否则界面全白，用户只会以为卡死了。

### 12.6 前端必须能区分「截断」和「正常结束」

`callModelThroughProxyStream` 跟踪 `sawDone`。reader 结束但没见过 done 帧 → 抛 `StreamTruncatedError`（带 `partialText`）。**不准**静默 `return` —— 那样用户看到半句话却没有任何提示。截断后要给「继续生成」入口，不要让用户整轮重发（本地慢模型上代价极大）。

### 12.7 agent 循环任何退出路径都不准返回空文本

预算耗尽 / 达到轮数上限 / 无进展，**每一条**都要做一次 `toolChoice: 'none'` 的收尾调用，拿不到就给兜底文案。模型中途报错且已经跑过至少一轮 → 降级返回已收集的工具结果，**不要** throw 掉整个 step（那会连 checkpoint 一起删掉，前面几十轮全白干）。

「做到一半就没有后续」几乎都是这里出的问题。`tests/jobLoopContinuity.test.js` 守这条。

### 12.8 上下文窗口不准默认成一个大数

本地模型常见 4k–8k。默认值给大了 → 压缩阈值算成几十万 → 主动压缩永远不触发 → 每个长对话都撞上游 400。本地默认 8192，且允许配到 1024（不要再加 `>= 4096` 这种下限）。

`isContextLengthError` 要认各家的说法（llama.cpp 说 `exceeds the available context size`、有的返 413/500），别只认 OpenAI 那套文案。

### 12.9 本地模型不产生上游 API 成本

本地端点不应计入可选的上游 API 美元成本预算。`isLocalEndpoint` 认回环 + RFC1918 私网段 + Tailscale + `.local`/`.lan`，别只认 `127.0.0.1`。

### 12.10 不准给「工作量」设紧上限

这条是反复踩坑之后的硬规矩。项目里所有 `MAX_*` 常量分两类，改之前先想清楚自己在改哪一类：

| 类型 | 例子 | 该怎么设 |
|---|---|---|
| **安全上限** | 单文件 5MB、patch 30 个操作、登录尝试 5 次 | 保持紧，这些防的是攻击和资源耗尽 |
| **工作量护栏** | 工具轮数、累积调用数、墙钟、子代理并发 | 给到正常任务**碰不到**的量级，并且可配 |

第二类给紧了，症状永远是同一个：**任务做到一半停下，用户看到半成品**。而且往往看不出是撞了限制——所以每一条退出路径都必须说清楚原因（见 12.7）。

当前默认值（全部可用 env 覆盖，见 `.env.example`）：

- `max_tokens`：**不限制**（不发这个字段）。填数字对推理模型是灾难——思考和正文共用预算。
- Job 单步轮数 2000 / 累积调用 2000 / 墙钟 6 小时（**不含等模型的时间**）
- 子代理 1000 轮 / 1000 次 / 2 小时，深度 3，并发 8，每批 8
- 规划探索 40 轮，工具结果回喂 24000 字符

`TOOL_MAX_ROUNDS` 默认 0 = 不限制，循环靠模型自己停。

**墙钟必须排除模型延迟**（`jobBudget.trackModelMs`）。把等模型的时间算进墙钟，等于「模型越慢能做的事越少」——方向完全反了，本地模型慢是常态，不是失控信号。

---

## 十三、给"主人"的话

我（项目主人）习惯：
- **直接告诉我结果**。"合了"、"挂了第 23 行"，不要"我先 ... 然后 ... 最后 ..."。
- 改完用一下，**自己跑一遍**。光跑测试通过不算完。
- 遇到自己不确定的设计取舍，**列两个方案**让我拍，不要自己拍完闷头改。
- **保持文件薄**。一个 service 超过 600 行就该拆。一个 component 超过 300 行就该拆。

如果违反本文档，我会让你重写。读完了再动手。
