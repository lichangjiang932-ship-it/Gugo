# Plugin SDK v0.1

Your Model Atelier 的 Plugin 子系统。本阶段（stage-2.2 ~ 阶段 6）交付**静态配置 + 只读加载器**，
另加两条受控的"安装到用户域"通道（`skill-bundle` → skillStore，`agent-template` → agentStore），
为后续 v0.5 的代码执行（isolated-vm 沙箱）打地基。

## 为什么有 Plugin（与 Skill / Agent 的区别）

| 维度          | Skill                                                            | Agent                                              | Plugin                                          |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| 存储          | SQLite (`imported_skills` 表) + 系统种子                         | SQLite (`agents` 表) + 默认 Atelier               | 文件系统：`plugins/<id>/plugin.json`            |
| 生命周期      | 运行时可装载、可升级、有用户级隔离 (`user_id`)                   | 运行时 CRUD、按 user 隔离                          | 启动时一次性扫描，仓库级只读                    |
| 内容          | 提示词 + tool spec + 资源文件，参与对话上下文                    | SOUL.md + IDENTITY.md，注入 system block          | 主题色 / 模板 / 静态素材 / 可安装包             |
| 安全模型      | 严格 schema 校验、按用户隔离                                     | clamp + name 唯一 + default 互斥                  | v0.1 完全不执行代码；v0.5 计划接 isolated-vm    |
| 谁来发        | 用户从 UI 上传                                                   | 用户从 UI 创建/导入                                | 仓库内置 + 未来第三方静态包                     |

一句话：**Skill 是"动态认知扩展"，Agent 是"人格卡片"，Plugin 是"静态资产 + 可分发模板源"。**

## Manifest 规格

每个 plugin 是 `plugins/` 下的一个子目录，必须含 `plugin.json`：

```json
{
  "id": "ppt-theme-warm",
  "name": "Warm PPT Theme",
  "version": "0.1.0",
  "type": "ppt-theme",
  "entry": "theme.json",
  "description": "可选描述",
  "author": "可选",
  "license": "MIT",
  "tags": ["warm", "business"]
}
```

字段规则：

| 字段        | 必填 | 规则                                                                  |
| ----------- | ---- | --------------------------------------------------------------------- |
| id          | 是   | `[a-z0-9][a-z0-9-]*`，全局唯一，≤80                                   |
| name        | 是   | 1..120 字符                                                           |
| version     | 是   | semver `MAJOR.MINOR.PATCH` (可加 `-pre` / `+build`)                   |
| type        | 是   | 枚举：见下方"类型枚举"                                                |
| entry       | 是   | 相对 plugin 根目录的文件路径，禁止 `/` 开头、禁止 `..`                |
| description | 否   | ≤2000                                                                 |
| author      | 否   | ≤200                                                                  |
| license     | 否   | ≤80                                                                   |
| tags        | 否   | 数组，每个 ≤40 字符，总数 ≤20                                         |

## 类型枚举

权威定义在 `server/plugins/pluginManifest.js` 的 `PLUGIN_TYPES`：

- **ppt-theme** — PPT 主题包。entry 通常是 `theme.json`，含 palette / fonts / sizing。
- **prompt-template** — 提示词模板。entry 通常是 `template.md`，含 `{{变量}}` 占位符。
- **asset-pack** — 通用静态素材包（SVG / 图片 / JSON 数据）。entry 指向清单或主资源。
- **agent-template** — 可安装为 Agent 的人格模板。entry 通常是 `agent.md`，格式同 `POST /api/agents/import` 接受的 export 文件（frontmatter + `## IDENTITY` + `## SOUL`）。AgentList 的 "Templates" 按钮会列举这种 plugin 并支持一键导入。
- **skill-bundle** — 可安装为用户 Skill 的模板包。目录必须含 `skill.json` + `prompts/system.md`，整包通过 `POST /api/plugins/:id/install-as-skill` 写入 `imported_skills` 表（按 user_id 隔离）。

> 新增类型必须同时改 `PLUGIN_TYPES`、本文档、对应消费方（route / UI）。光改 schema 是 dead code。

## 写一个新 plugin（最小示例）

### ppt-theme

```
plugins/my-cool-theme/
  plugin.json
  theme.json
```

`plugin.json`：

```json
{ "id": "my-cool-theme", "name": "My Cool Theme", "version": "0.1.0", "type": "ppt-theme", "entry": "theme.json" }
```

`theme.json`：

```json
{
  "name": "Cool",
  "palette": { "bg": "#0B0F14", "title": "#F5F7FA", "accent": "#5EE3C1" },
  "fonts": { "heading": "Cabinet Grotesk", "body": "Geist" }
}
```

### prompt-template

```
plugins/my-prompt/
  plugin.json
  template.md
```

`template.md` 用 `{{变量}}` 标记输入槽，建议在文件头部说明所需变量与产出要求。

### asset-pack

放任意静态资源，`entry` 通常指向一个清单文件（如 `index.json`），列出包内可消费的资源路径。

### agent-template

```
plugins/my-coach/
  plugin.json
  agent.md
```

`plugin.json`：

```json
{ "id": "my-coach", "name": "My Coach", "version": "0.1.0", "type": "agent-template", "entry": "agent.md" }
```

`agent.md` 用 Agent export 格式（同 `GET /api/agents/:id/export`）：

```markdown
---
name: "Coach"
avatar_url: ""
---

# Coach

## IDENTITY
你是一个克制的教练……

## SOUL
对话风格：先共情后建议，不下指令。
```

参考实现：`plugins/example-agent-coach/`。

### skill-bundle

```
plugins/my-skill/
  plugin.json
  skill.json
  prompts/
    system.md
```

`plugin.json` 的 `entry` 通常指 `skill.json`：

```json
{ "id": "my-skill", "name": "My Skill", "version": "0.1.0", "type": "skill-bundle", "entry": "skill.json" }
```

`skill.json` + `prompts/*.md` 的内部结构与 `POST /api/skills/import` 接受的 zip 包一致，会经 `validateSkillPack` 校验。安装时通过 `POST /api/plugins/:id/install-as-skill` 写入登录用户的 `imported_skills` 表。

参考实现：`plugins/example-skill-bundle/`。

## 加载流程

```
bootstrap() (server/core/lifecycle.js)
   │
   ├─ seedSystemSkills()  (失败 try/catch)
   │
   └─ initPlugins({ rootDir: <repo>/plugins })
        │
        ├─ loadPlugins(rootDir)
        │     ├─ readdir(rootDir)
        │     ├─ for each subdir:
        │     │    read plugin.json
        │     │    JSON.parse
        │     │    validateManifest()      ← pluginManifest.js
        │     │    check entry exists（且不越界）
        │     │    去重 id
        │     │    push to plugins[] / errors[]
        │     └─ return { plugins, errors }
        │
        └─ 写入 module-level CURRENT 缓存
             暴露 listPlugins() / getPlugin(id) / getLoadErrors()
```

任意失败（plugin.json 不合法、entry 丢失、JSON 解析失败、id 撞车、entry 越界）**不抛、不阻塞**，
只记录到 errors[]，非 silent 模式下打到 `console.warn`。

## HTTP API

| Method | Path                                          | Auth   | 说明                                                                 |
| ------ | --------------------------------------------- | ------ | -------------------------------------------------------------------- |
| GET    | `/api/plugins`                                | 匿名   | 列出全部 plugin，支持 `?type=ppt-theme` 等过滤                       |
| GET    | `/api/plugins/:id`                            | 匿名   | 详情 + entry 文件内容预览（限 50KB，超过 `truncated:true`）          |
| POST   | `/api/plugins/:id/install-as-skill`           | 登录   | 把 `skill-bundle` plugin 装为当前用户的 skill；非 skill-bundle 拒    |
| 其他   | `/api/plugins/*`                              | —      | 一律 `405 method not allowed`                                        |

GET 返回示例：

```json
{
  "plugin": {
    "id": "example-warm-ppt-theme",
    "name": "Warm PPT Theme",
    "version": "0.1.0",
    "type": "ppt-theme",
    "entry": "theme.json",
    "tags": ["warm", "business", "earth-tone"]
  },
  "entryPreview": { "size": 488, "truncated": false, "bytes": 488, "content": "{ ... }" }
}
```

`install-as-skill` 错误码：

- 401 未登录
- 404 plugin 不存在
- 400 类型不是 skill-bundle / 缺 `skill.json` / 缺 `prompts/system.md` / 路径越界 / 文件超限
- 409 校验失败或重名冲突

## 安全模型

| 版本 | 能力                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------- |
| v0.1 | 纯静态 JSON / 资源文件；**绝不执行 plugin 内任何 js**；路径越界 / `..` 被 schema 与 loader 双拦 |
| v0.5 | 计划接 `isolated-vm` 沙箱，允许 plugin 暴露受限 hook（如自定义渲染器），CPU/内存/时间限额      |
| 未来 | plugin 签名 + 仓库分发 + 用户级安装/卸载                                                        |

当前阶段如果 plugin 目录里出现 `*.js`，它只会被记账为普通资源文件，**不会被 require / import**。

`install-as-skill` 通道的额外硬约束（见 `server/services/pluginToSkill.js`）：

- 只允许后缀 `.md` / `.txt` / `.json`
- 单文件 ≤ 256 KB
- 单 plugin 总文件数 ≤ 64
- 通过 `realpathSync` 守 symlink 跳出
- 校验最终走 `validateSkillPack` + `installValidatedSkillPack`，结果绑定 `user_id`

## 真实消费方（不是 PPT 展示）

- **AgentList "Templates" 按钮** → `GET /api/plugins?type=agent-template` → 用户选一个 → `GET /api/plugins/:id` 取 `entryPreview.content` → `POST /api/agents/import` 写入用户 agents 表
- **SkillManager** → `POST /api/plugins/:id/install-as-skill` 把 skill-bundle plugin 写到 `imported_skills`，按 user 隔离
- 后续 ppt-theme / prompt-template / asset-pack 等会接到对应业务模块的"主题选择器 / 模板选择器"上

## 测试

```bash
node --test tests/pluginLoader.test.js
node --test tests/pluginRoutes.test.js
```

## 文件清单

### stage-2.2 起步

- `server/plugins/pluginManifest.js` — schema 校验纯函数
- `server/plugins/pluginLoader.js` — 文件系统扫描器
- `server/plugins/pluginRegistry.js` — 内存索引
- `server/routes/pluginRoutes.js` — HTTP 端点
- `server/core/lifecycle.js` — bootstrap 集成 initPlugins
- `server/appServer.js` — 路由表挂载 `/api/plugins`
- `plugins/example-warm-ppt-theme/` — 示例 ppt-theme
- `plugins/example-greeting-prompt/` — 示例 prompt-template
- `tests/pluginLoader.test.js` / `tests/pluginRoutes.test.js`

### 阶段 6 扩展

- `server/services/pluginToSkill.js` — skill-bundle plugin → 用户 skill 的安装通道
- `plugins/example-agent-coach/` — 示例 agent-template
- `plugins/example-skill-bundle/` — 示例 skill-bundle
- `server/plugins/pluginManifest.js` — `PLUGIN_TYPES` 加 `agent-template` / `skill-bundle`
- `src/pages/AgentList.jsx` — Templates 按钮消费 agent-template plugin
