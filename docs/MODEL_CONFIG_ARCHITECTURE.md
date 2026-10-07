# 模型配置改造：架构设计（待确认）

目标：把「模型配置」改成 deepseek-harness 那种 **目录选择 → 填 Key → 保存即用**，同时把底层
做成「一切皆适配器 + 统一容器 + 配置驱动」。本文只描述设计与迁移，不含实现。

---

## 一、现状对照（事实，含文件路径）

| 维度 | 现状 | 目标 |
|---|---|---|
| 适配器注册表 | 已有 `server/adapters/modelProviderRegistry.js`（`registerModelProviderAdapter` / `getModelProviderAdapter` / `listModelProviderAdapterKinds` / reconciler 契约） | 保留并升级为 `ctx.llm` 容器（同一份注册表，多一层门面） |
| 协议实现 | `server/adapters/nativeModelProviders.js` + `nativeModelProviderRequests.js`（openai-compatible 为主，含少量 anthropic 缓存头处理） | 显式协议表：`openai-completions` / `openai-responses` / `anthropic-messages` |
| 配置真源 | **SQLite `model_providers` 表**（`id,user_id,provider_key,label,base_url,secret_json,headers_json,models_json,default_model,enabled,is_default`，迁移 legacyV14ToV30 + v33/v45/v70 扩展） | `~/.gugo/settings.yaml`（真源）+ `.credentials.yaml`（密钥）；DB 只留派生/用户态缓存 |
| 环境变量配置 | `server/adapters/modelProviderConfig.js`（`getModelProviders/loadModelConfig/resolveModelConfigForModel/resolveModelFailoverConfigs`，读 env） | 保留为**最高优先级覆盖**（env > credentials > settings） |
| 密钥脱敏 | 已有 `server/services/modelProviderConfig.js`（`REDACTED_VALUE='••••••'`）+ `modelProviderDiagnosticService.redactProviderDiagnostic` | 复用，扩展为统一 `redactSecrets()` 并覆盖日志/错误/诊断 |
| 模型目录 | `server/adapters/modelRuntimeCatalog.js`（`getVisibleModels/getModelContextWindow/getModelStatus/pickAllowedModel`，env+配置文件推导） | 运行时目录：catalog 预设 ∪ `/v1/models` 探测 ∪ 手填 ∪ models.dev 元数据（带缓存） |
| 模型配置 UI | `src/pages/SettingsView.jsx` + `settingsView/SettingsDialogNavigation.jsx`（表单式：手填 baseURL/模型/默认），列表态即你截图「图一左」的旧样子 | 「图一~图五」的目录式流程：Provider 卡片列表 → 添加面板（第三方目录 / 自定义 API 两 tab）→ 探测/增删模型 → 保存即生效 |
| models.dev | 无 | 元数据补充 + 本地缓存（默认 24h，可配） |

**结论**：注册表、脱敏、运行时目录三块已有地基；缺的是 ①YAML 三层配置 ②协议表补齐 ③目录预设 ④
models.dev ⑤UI 流程重做。

---

## 二、架构总则（落地版）

```
                  ┌─────────────────────────── Web UI（设置 > 模型） ───────────────────────────┐
                  │  Provider 卡片列表 │ 添加面板（第三方目录 / 自定义 API）│ 模型目录编辑器      │
                  └───────────────┬─────────────────────────────────────────────┬────────────┘
                                  │ HTTP (server/routes/llmRoutes.js)            │
                  ┌───────────────▼─────────────────────────────────────────────▼────────────┐
                  │                            ctx.llm（统一服务容器）                        │
                  │  registerAdapter · resolveAdapter · listModels · listProviders · probe    │
                  └───┬───────────────┬───────────────┬───────────────┬───────────────┬────────┘
                      │               │               │               │               │
              ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
              │ settingsStore│ │credentials- │ │providerCat- │ │ modelsDev-  │ │  adapters/  │
              │ (settings.   │ │Store(.cred- │ │alog(内置预设│ │Cache(24h)   │ │ openai-comp │
              │  yaml 读写)  │ │ entials.yaml│ │ + 本地模型) │ │             │ │ openai-resp │
              └──────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │ anthropic-m │
                                       ↑ env 覆盖（最高优先级）                 └─────────────┘
```

- **一切皆适配器**：核心只认 `LlmAdapter` 接口；任何供应商差异（协议、鉴权头、图片/tool 翻译）都在适配器内。
- **配置驱动**：新增供应商 = settings.yaml 声明一行 + 已有适配器；核心零改动。
- **单一真源**：YAML 是唯一手写源，DB/内存目录都是派生视图（可随时从 YAML 重建）。

## 三、三层配置（数据模型）

### 3.1 `~/.gugo/settings.yaml`（真源；`GUGO_HOME` 可覆盖目录）

```yaml
version: 1
agent-default-model:
  provider: bailian-tpp
  model: qwen3.8-max

llm:
  providers:
    bailian-tpp:
      displayName: 百炼
      api: openai-completions          # openai-completions | openai-responses | anthropic-messages
      baseURL: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
      apiKeyEnv: BAILIAN_API_KEY       # 只存变量名
      headers: {}                      # 非敏感附加头
      models:                          # 目录（可空 → 用适配器默认/探测）
        - id: qwen3.8-max
          displayName: qwen3.8 Max
          contextWindow: 128000
          maxTokens: 8192
          supportsTools: true
          supportsVision: false
        - id: qwen3.8-flash
    local-lmstudio:                    # 本地模型也走同一形状
      displayName: LM Studio
      api: openai-completions
      baseURL: http://127.0.0.1:1234/v1
      apiKeyEnv: ''                    # 本地可空
      autoProbe: true                  # 打开面板时探测 /v1/models

modelsDev:
  enabled: true
  cacheTtlHours: 24
  url: https://models.dev/api.json
```

### 3.2 `~/.gugo/.credentials.yaml`（密钥；0600）

```yaml
version: 1
providers:
  bailian-tpp:
    apiKey: sk-xxxx                 # 明文只在此文件；UI 永不回显
    savedAt: 2026-10-07T12:00:00Z
  magpie: { apiKey: ... }
```

读取优先级：**`apiKeyEnv` 指向的环境变量 > .credentials.yaml > 无**（env 优先，符合你第五条）。

### 3.3 运行时模型目录（派生，非持久）

```
directory(provider) = presetCatalog(provider)        # 内置预设（含 contextWindow/maxTokens/能力位）
                    ∪ probedModels(provider)         # GET {baseURL}/models 探测结果（带时间戳缓存）
                    ∪ settings.models[]              # 手填/勾选保留
                    ∪ modelsDevMeta(modelId)         # 名称/上下文/能力位补充（缓存 24h）
  → 去重（同 id 以「手填 > 探测 > 预设」为准）→ 供 UI 选择器与 `pickAllowedModel` 使用
```

## 四、目录结构（新增/改动）

```
shared/
  llmConfigSchema.js              # YAML schema（zod）+ 校验错误（与现有 zod 边界风格一致）
  modelProviderCatalog.js         # 内置供应商预设（图一的 12 家 + 本地 4 个 + 更多）
server/llm/
  container.js                    # ctx.llm：registerAdapter/resolveAdapter/listModels/listProviders/probe
  settingsStore.js                # settings.yaml 读写（原子写、schema 校验、GUGO_HOME）
  credentialsStore.js             # .credentials.yaml 读写（0600、脱敏描述符、不落日志）
  providerDirectory.js            # 3.3 的合并/去重/缓存（含 /v1/models 探测）
  modelsDevCache.js               # models.dev 拉取 + 24h 缓存（离线安全）
  adapters/
    openaiCompletions.js          # 协议适配器
    openaiResponses.js
    anthropicMessages.js
  index.js                        # 启动时注册内置适配器 + 从 settings.yaml 注册 routes
server/routes/llmRoutes.js        # /api/llm/providers (CRUD) · /probe · /models · /default-model · /credentials
src/pages/settingsModels/         # 图一~图五的 UI
  ProviderCatalogGrid.jsx         # 图一：目录格子 + 本地模型快速配置
  ProviderList.jsx                # 图二：卡片列表（绿点=已配置/已连通）+ 添加/编辑/删除
  AddProviderPanel.jsx            # 图三/四：第三方目录 tab（提供商下拉 + Key + 自定义设置 + 保存）
  CustomProviderForm.jsx          # 图五：自定义模型 API（Provider ID/显示名/地址/协议/Key）
  ModelDirectoryEditor.jsx        # 模型目录：获取可用模型 / 添加 / 删除 / 勾选
  useLlmConfig.js                 # 与 /api/llm/* 交互 + 乐观更新（热生效）
```

## 五、接口定义（核心，先定形状）

```ts
// —— 适配器协议（server/llm/adapters/*.js 实现）——
interface LlmAdapter {
  id: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  chat(req: ChatRequest, ctx: AdapterContext): Promise<ChatResponse>
  stream(req: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatChunk>
  listModels?(config: ProviderConfig, ctx: AdapterContext): Promise<ModelInfo[]>   // 探测
}

interface ChatRequest {
  model: string
  messages: ChatMessage[]          // 统一形状：{role, content:[{type:'text'|'image'|'tool-use'|'tool-result',…}]}
  tools?: ToolSpec[]               // OpenAI function schema 为中间表示
  temperature?: number; maxTokens?: number; stream?: boolean
  cacheRetention?: 'short' | 'long'   // 映射到各协议的缓存字段/头
}
interface ChatResponse { content: AssistantPart[]; usage?: Usage; finishReason: string; raw?: unknown }
interface ChatChunk { type: 'text'|'reasoning'|'tool-call'|'usage'|'done'; … }

// —— 统一容器 ——
interface LlmContainer {
  registerAdapter(adapter: LlmAdapter): void
  resolveAdapter(api: string): LlmAdapter                 // 未注册 → 明确报错，不回退猜
  listProviders(): ProviderSummary[]                       // 供 UI 卡片列表（含 configured 绿点/模型数）
  listModels(providerId: string): Promise<ModelInfo[]>     // 目录合并结果
  probeModels(providerId: string): Promise<ModelInfo[]>    // 显式探测（写缓存）
  createOrUpdateProvider(input: ProviderInput): Promise<ProviderSummary>   // 写 settings.yaml
  setCredential(providerId: string, apiKey: string): Promise<{ descriptor: string }>  // 写 .credentials.yaml(0600)
  setDefaultModel(provider: string, model: string): Promise<void>
}

// —— 协议翻译契约（两种协议的差异集中在此，可 mock HTTP 单测）——
openai-completions: messages → {role, content:[{type:'text'}|{type:'image_url',image_url:{url}}]} ;
                    tools → {type:'function',function:{name,description,parameters}} ;
                    流 → choices[].delta.{content,tool_calls[]} ; usage 尾部（若支持）
anthropic-messages:  messages → system 抽离 + {role, content:[{type:'text'}|{type:'image',source:{type:'base64'|'url',…}}]} ;
                    tools → {name,description,input_schema} ; tool_result → user content block ;
                    流 → content_block_delta{text_delta|input_json_delta} ; cache_control 与 beta 头成对出现
```

## 六、UI 流程映射（图 → 组件 → 接口）

| 图 | 交互 | 组件 | 接口 |
|---|---|---|---|
| 图一 | 打开「模型」先看到**供应商目录格子**（12 家 + 模型数）+ 本地模型快速配置（Ollama/LM Studio/llama.cpp/vLLM/自定义接口）+ 模型知识库 | `ProviderCatalogGrid` | `listProviders()`（含 configured 标记） |
| 图二 | 已配置的 Provider 卡片（名称、`自定义`徽标、绿点=可用、编辑/删除），底部虚线「+ 添加模型提供商」 | `ProviderList` | `listProviders()` / `removeProvider()` |
| 图三 | 添加面板：`第三方模型提供商` tab（提供商下拉 + API 密钥 + `自定义设置`可折叠 + 取消/保存） | `AddProviderPanel` | `createOrUpdateProvider()` + `setCredential()`；Key 留空=用环境认证 |
| 图四 | 展开自定义设置：API 地址、模型目录（`获取可用模型`、`正在使用适配器默认模型`、目录外 ID 仍可直接发送）、`+ 添加模型` | `ModelDirectoryEditor` | `probeModels()` / `listModels()` |
| 图五 | `自定义模型 API` tab：Provider ID（小写、派生凭据名）、显示名称、API 地址、API 协议下拉、API 密钥、模型目录、`创建提供商` | `CustomProviderForm` | 同上（协议下拉来自 `listAdapterProtocols()`） |

保存后**热生效**：`settingsStore` 写盘 → `ctx.llm` 重载路由 → 下一次请求即用（不重启）。

## 七、安全

1. settings.yaml **禁止明文密钥**（导入时校验并拒绝含 `apiKey:` 的项）。
2. Key 读取优先级 env > credentials；`.credentials.yaml` 写盘 `0600`（Windows 用 ACL 尽力而为并记录）。
3. UI 只回显 `sk-••••abcd` 描述符；`GET /api/llm/providers` 永不返回明文。
4. 日志/错误/诊断统一走 `redactSecrets()`（复用现有 `REDACTED_VALUE` + `redactProviderDiagnostic`），并加单测断言「日志中不含 Key」。
5. `/v1/models` 探测只允许 **localStorage 里已配置的 baseURL**；外部地址不探测、不代发请求。

## 八、迁移与兼容（不破坏现有 1080 个测试）

- 启动时一次性导入：`model_providers` 表 → settings.yaml（首次写入 `settings.yaml`，迁移标记入库）；表保留只读一个版本期，随后归档。
- 现有 env 供应商（`MODEL_*`）继续可用且**优先级最高**：`getModelProviders()` 保留，`ctx.llm` 合并两者。
- 现有调用链保持不变：`resolveModelConfigForModel()` 仍被 loop 使用，内部改为「env → ctx.llm 路由」。
- CLI/桌面端不感知变化；`gugo doctor --headless` 增加「配置来源」诊断段（yaml/env/credentials）。

## 九、分阶段路线图（每阶段独立可验证）

| 阶段 | 内容 | 验证门 |
|---|---|---|
| 1 | `shared/llmConfigSchema.js` + `server/llm/settingsStore.js`（YAML 读写、GUGO_HOME、原子写、校验） | 单测：读写往返、坏文件报错、GUGO_HOME 覆盖；lint/typecheck/build |
| 2 | `ctx.llm` 容器 + `openaiCompletions` 适配器，打通最小链路（mock HTTP） | 单测：注册/解析/未知协议报错 + 请求翻译 + 流解析；离线 eval 不回归 |
| 3 | `credentialsStore`（0600 + 描述符 + env 优先）+ 脱敏单测 | 单测：密钥不落 yaml、不落日志、描述符格式 |
| 4 | UI：`ProviderList` → `AddProviderPanel` → 目录预设 + 默认模型（图一~图四） | 组件测试 + 手工验收（截图对照） |
| 5 | `anthropicMessages` 适配器（图片/tool_use/cache 头）+ `probeModels`（图五 + 获取可用模型） | 翻译单测（mock HTTP）+ 探测解析单测 |
| 6 | models.dev 缓存（24h、离线安全）+ 目录合并/去重 | 单测：缓存命中/过期/离线回退；全量套件 0 失败 |

## 十、验收清单

- [ ] settings.yaml 无明文密钥；`.credentials.yaml` 权限 0600；UI 只显示脱敏值。
- [ ] 从目录选供应商 → 填 Key → 保存 → **模型选择器立刻出现其模型**（不重启）。
- [ ] 自定义 Provider ID/地址/协议可保存；`获取可用模型` 能列出并**勾选保留/删除**；目录外 ID 仍可直接发送。
- [ ] 两种协议（openai-completions / anthropic-messages）请求/响应（含图片、tool use）有单测。
- [ ] `npm run lint`、`typecheck`、`build` 零 warning；全量测试通过（当前基线 1080 文件 / 9240 断言）。
- [ ] 迁移后旧 DB 供应商与 env 供应商行为不变（回归测试）。
