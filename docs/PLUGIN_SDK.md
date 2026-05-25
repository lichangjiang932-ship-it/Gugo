# Plugin SDK v0.1

Your Model Atelier 的 Plugin 子系统。本阶段（stage-2.2）只交付**静态配置 + 只读加载器**，
为后续 v0.5 的代码执行（isolated-vm 沙箱）打地基。

## 为什么有 Plugin（与 Skill 的区别）

| 维度          | Skill                                                            | Plugin                                          |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| 存储          | SQLite (`imported_skills` 表) + 系统种子                         | 文件系统：`plugins/<id>/plugin.json`            |
| 生命周期      | 运行时可装载、可升级、有用户级隔离 (`user_id`)                   | 启动时一次性扫描，只读                          |
| 内容          | 提示词 + tool spec + 资源文件，参与对话上下文                    | 主题色 / 模板 / 静态素材，被业务模块按需读取    |
| 安全模型      | 严格 schema 校验、按用户隔离                                     | v0.1 完全不执行代码；v0.5 计划接 isolated-vm    |
| 谁来发        | 用户从 UI 上传                                                   | 仓库内置 + 未来第三方静态包                     |

一句话：**Skill 是"动态认知扩展"，Plugin 是"静态资产扩展"。**

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
| type        | 是   | 枚举：`ppt-theme` / `prompt-template` / `asset-pack`                  |
| entry       | 是   | 相对 plugin 根目录的文件路径，禁止 `/` 开头、禁止 `..`                |
| description | 否   | ≤2000                                                                 |
| author      | 否   | ≤200                                                                  |
| license     | 否   | ≤80                                                                   |
| tags        | 否   | 数组，每个 ≤40 字符，总数 ≤20                                         |

## 类型枚举

- **ppt-theme** — PPT 主题包。entry 通常是 `theme.json`，含 palette / fonts / sizing。
- **prompt-template** — 提示词模板。entry 通常是 `template.md`，含 `{{变量}}` 占位符。
- **asset-pack** — 通用静态素材包（SVG / 图片 / JSON 数据）。entry 指向清单或主资源。

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
        │     │    check entry exists
        │     │    push to plugins[] / errors[]
        │     └─ return { plugins, errors }
        │
        └─ 写入 module-level CURRENT 缓存
             暴露 listPlugins() / getPlugin(id)
```

任意失败（plugin.json 不合法、entry 丢失、JSON 解析失败）**不抛、不阻塞**，只记录到 errors[]
并在非 silent 模式下打到 `console.warn`。

## HTTP API

只读、匿名可访问、无写入端点。

- `GET /api/plugins` — 列出全部 plugin。支持 `?type=ppt-theme` 过滤。
- `GET /api/plugins/:id` — 详情 + entry 文件内容预览（限 50KB，超过 `truncated:true`）。
- `POST/PUT/DELETE /api/plugins/*` — 一律 `405 method not allowed`。

返回示例：

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

## 安全模型

| 版本 | 能力                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------- |
| v0.1 | 纯静态 JSON / 资源文件；**绝不执行 plugin 内任何 js**；路径越界 / `..` 被 schema 与 loader 双拦 |
| v0.5 | 计划接 `isolated-vm` 沙箱，允许 plugin 暴露受限 hook（如自定义渲染器），CPU/内存/时间限额      |
| 未来 | plugin 签名 + 仓库分发 + 用户级安装/卸载                                                        |

当前阶段如果 plugin 目录里出现 `*.js`，它只会被记账为普通资源文件，**不会被 require / import**。

## 测试

```bash
node --test tests/pluginLoader.test.js
node --test tests/pluginRoutes.test.js
```

## 文件清单（stage-2.2 新增）

- `server/plugins/pluginManifest.js` — schema 校验纯函数
- `server/plugins/pluginLoader.js` — 文件系统扫描器
- `server/plugins/pluginRegistry.js` — 内存索引
- `server/routes/pluginRoutes.js` — HTTP 只读端点
- `server/core/lifecycle.js` — bootstrap 集成 initPlugins
- `server/appServer.js` — 路由表挂载 `/api/plugins`
- `plugins/example-warm-ppt-theme/` — 示例 ppt-theme
- `plugins/example-greeting-prompt/` — 示例 prompt-template
- `tests/pluginLoader.test.js` / `tests/pluginRoutes.test.js`
