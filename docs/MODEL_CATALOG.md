# 模型知识库（models.dev）

模型配置页的供应商与模型清单不再只依赖仓库里手写的 preset，而是以
[models.dev](https://models.dev) 作为上游知识库，用一份随应用发布的快照作为
离线基线。本文说明为什么这样分层、数据长什么样、以及怎么维护。

## 为什么不是"只联网取"或"只手写"

两种只做一半的做法都试过，各自坏在不同的地方：

- **只手写 preset（本次之前的做法）**：仓库里维护了 16 个供应商，每个带一份模型
  ID 清单。厂商上新模型比这个应用发版快得多，清单必然过期。实测：preset 里
  OpenAI 写的是 `gpt-5.6-*`，而上游当前的 ID 是 `gpt-6.1-sol` 等；`amazon-bedrock`、
  `cerebras`、`baseten`、`github-copilot`、`google-vertex`、`minimax-cn`
  这些供应商因为没写进 preset，在界面上**根本无法配置**。
- **只联网取**：本项目是本地优先、且测试要求离线且确定性（AGENTS.md §8）。
  一个只存在于网络调用后面的模型选择器，恰好在使用者没有网络时不可用。

所以：**快照是离线基线，刷新是可选的改进**。两者用同一套契约校验。

## 分层

| 层 | 位置 | 作用 |
|---|---|---|
| 契约 | `shared/modelCatalogSnapshot.js` | 快照的结构校验、字段压缩与边界。生成器与运行时**都**用它。 |
| 生成器 | `scripts/generate-model-catalog.mjs` | 从上游抓取并写出快照；`--validate` 是离线门禁 |
| 快照 | `shared/modelCatalogSnapshot.json` | 随应用发布的离线基线，226 个供应商 / 8154 个模型 |
| 运行时 | `server/services/modelCatalogService.js` | 读取快照、按需刷新、解析供应商别名 |
| 路由 | `server/routes/modelProviderRoutes.js` | `/api/model/catalog*`，复用模型设置页的鉴权入口 |

**契约为什么放在 `shared/` 而不是生成器旁边**：运行时（server）要校验刷新回来的
文档，而桌面包 `electron-builder.yml` 的 `files` 只包含 `dist/ server/ shared/ seed/`
等，**不包含 `scripts/`**。契约留在 `scripts/` 会让打包后的应用在 import 时失败。

## 数据形状

上游文档约 5 MB、226 个供应商、8000+ 模型，且大多数字段本应用不读。快照只保留
用得到的字段，压缩后 3 MB（**gzip 后约 190 KB**，实际传输的是这个）。

```jsonc
{
  "schemaVersion": 1,
  "source": "https://models.dev/api.json",
  "generatedAt": "2026-10-07",
  "providerCount": 226,
  "modelCount": 8154,
  "providers": [{
    "id": "openai",
    "name": "OpenAI",
    "env": ["OPENAI_API_KEY"],   // 可选：上游声明的环境变量名
    "doc": "https://...",         // 可选：官方文档
    "models": [{
      "id": "gpt-6.1-sol", "name": "GPT-6.1 Sol",
      "context": 1050000, "output": 128000,
      "tools": true, "vision": true, "pdf": true, "reasoning": true,
      "released": "2026-09-29",           // 可选
      "deprecated": true,                  // 可选，上游 status === 'deprecated'
      "cost": { "input": 2, "output": 10 } // 可选，每百万 token
    }]
  }]
}
```

约定：

- `output` 上游常为 `0` 表示未声明，这里**规范化为 `0`** 而不是省略键，调用方不必
  区分"没有输出上限"和"字段缺失"。
- 模型按 `released` 倒序、同日期按 id 升序。刷新不能重排使用者正在看的列表，
  未标日期的条目也不能插到有日期的前面。
- 没有模型的供应商直接丢弃——没有可配置内容的供应商不是供应商。
- 已弃用的模型**保留并标记**，而不是删掉：供应商可能仍在提供服务，
  让它继续可选好过让它凭空消失。

## 供应商别名

本应用的 preset id 早于上游命名，四个对不上，必须映射：

| preset id | models.dev id |
|---|---|
| `gemini` | `google` |
| `qwen` | `alibaba` |
| `moonshot` | `moonshotai` |
| `zhipu` | `zhipuai` |

其余（`openai`、`anthropic`、`deepseek`、`xai`、`groq`、`mistral`、`openrouter`、
`siliconflow`）同名。映射在 `PROVIDER_ID_ALIASES`，由 `catalogIdForPreset()` 应用，
生成器与路由都不需要知道这件事。

## 刷新语义

`POST /api/model/catalog/refresh`：

- 只接受通过 `isUsableSnapshot` 的文档。**校验失败不替换现有数据**：刷新只是对
  已有数据的改进，失败不能把使用者的模型清单清空。
- 失败**不抛给调用方**，而是写在 `catalog.error` 里，连同仍在生效的
  `catalog.source` 一起返回。刷新永远不能成为设置页打不开的原因。
- 边界：20 秒超时、响应体上限 16 MB、供应商 400、每供应商模型 400、
  单条文本 200 字符。

`catalogStatus()` 的 `source` 取值：`bundled`（用随包快照）、`models.dev`
（刷新已生效）、`none`（快照缺失或损坏）。

## 接口

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/model/catalog` | 来源与计数（`catalog.source` / `providers` / `models` / `generatedAt` / `error`） |
| GET | `/api/model/catalog?providers=1&q=<s>` | 上面这些，外加可搜索的供应商索引 |
| GET | `/api/model/catalog/<providerId>` | 该供应商当前的模型清单 |
| POST | `/api/model/catalog/refresh` | 拉取 models.dev 并返回刷新后的来源状态 |

## 界面的两个来源

新增供应商时打开的选择器有两个来源，对应读者实际可能拥有的两种东西
（`src/components/modelProviders/ProviderSourcePicker.jsx`）：

| 标签 | 内容 | 得到什么 |
|---|---|---|
| 第三方模型提供商 | 模型知识库：常用供应商直接列出，搜索框可检索目录里全部 226 个 | 选供应商 → 只填 API Key → 保存即用 |
| 自定义模型 API | Provider ID / 显示名称 / API 地址 / API 协议 / API Key | 中转站、自部署服务、知识库不认识的接口 |

设计取舍：

- **知识库是默认标签**。这正是替代原来手写 preset 网格的地方：网格只能列出
  有人记得写进去的供应商，`amazon-bedrock`、`cerebras` 这些因此长期无法配置。
- **常用供应商不搜索也能一眼看到**，但名字用本应用 preset 的显示名
  （`Google Gemini`、`阿里云通义千问`），而不是目录里的 `google`、`alibaba`；
  模型数只在目录确认后才显示。目录 id 随条目一起带上，因为四个供应商两边 id 不同。
- **搜索框输入任意 id 都能用**：命中 preset 走 preset 路径，否则按目录 id 走
  自定义路径，因此"知道 id 但目录里没有"也不挡路。
- **自定义接口按钮在知识库标签下也保留**，它是逃生口而不是第三个来源。
- 本地模型（Ollama / LM Studio / llama.cpp / vLLM）仍在知识库标签下方，
  它们不是供应商而是本机端点。

供应商索引是**显式可选**的：设置页平时不需要 226 条目录，因此默认的
`GET /api/model/catalog` 保持很小，只有要浏览目录时才带 `providers=1`。
索引由知识库直接生成，客户端**不另存一份供应商名单**——两份清单必然与它们
描述的知识库漂移。

## 维护

```bash
npm run catalog:validate   # 离线门禁：快照存在且符合契约（CI 用这个）
npm run catalog:generate   # 联网抓取并重写快照
npm run catalog:check      # 与线上比对，过期则退出码非 0（维护任务，不是构建门禁）
```

`--check` 需要网络、且会因上游新增模型而失败，那是维护信号而不是本仓库的错误，
所以**不要**把它接到构建或 CI 门禁上；门禁用 `--validate`。

`scripts/generate-model-catalog.mjs --from <file>` 可以从本地副本构建，
这是保持取证与维护离线可复现的入口。

## 与既有 preset 的关系

preset **保留**：它们提供"选完填 Key 就能用"的默认值与正确的 base URL，
是零配置路径，也有测试钉住（`tests/modelProviderPresets.test.js`）。知识库是
**在 preset 之上**多一层：刷新取到的是厂商当下真正在售的模型，且让没有 preset
的供应商变得可配置。

上游 ID 与 preset 里的 `models` 清单不一致时，**以上游为准**——preset 的清单只是
离线默认值，不是权威。

## 已知限制

- 快照是构建期生成的。没有刷新过的安装，其模型清单停留在打包那天；
  界面上会显示数据来源（随包 / models.dev）与生成日期。
- 云端供应商能否真的列出模型，仍取决于该厂商的 `/models` 端点与本应用的服务端
  探针；知识库给的是"上游认为该供应商提供什么"，不等于"你的 Key 一定能调用"。
- 定价来自上游，仅用于展示与本地估算，不参与任何权限或功能判定
  （AGENTS.md §1：上游费用与本地功能解耦）。
