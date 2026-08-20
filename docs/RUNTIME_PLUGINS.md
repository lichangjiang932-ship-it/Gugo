# Runtime Plugin Contributions

Gugo 的进程内 runtime plugin 通过 `server/plugins/runtimePluginRegistry.js` 注册可撤销的工具、Agent Loop 事件、prompt context、服务和模型 provider。runtime 与构建期可信 UI plugin 共用 `shared/pluginManifest.js` 的不可变 manifest envelope。

> 安全边界：`registerPlugin()` 是宿主进程内可信代码 API。磁盘 `transformer` 插件由 `runtimePluginControlService.js` 包装，并继续在 `pluginSandbox.js` 中执行；它不能获得 registry context，也不能注入 React/renderer JavaScript。

## Manifest

```js
await registerPlugin({
  id: 'example-runtime',
  name: 'Example runtime plugin',
  version: '1.0.0',
  requires: [],
  contributes: [
    'tool:example_echo',
    'event:request',
    'prompt:example-project-context',
    'service:example-cache',
    'service:task-review-guard',
    'service:task-plan-guard',
    'model-provider:example-native',
  ],
}, (context) => {
  // 这里只能注册 contributes 中已声明的目标。
})
```

`contributes` 是权限上界，不是说明文字：

| Context API | 必须声明 |
| --- | --- |
| `context.tools.register({ name })` | `tool:<name>` |
| `context.events.on(event)` | `event:<event>` |
| `context.prompts.register({ id, render })` | `prompt:<id>` |
| `context.services.provide(name)` | `service:<name>` |
| `context.models.providers.register(kind)` | `model-provider:<normalized-kind>` |

声明精确匹配且不支持通配符。插件可按配置只启用声明集合的一部分；但任何未声明注册都会在产生宿主可见副作用前失败，错误为：

```text
code: PLUGIN_CONTRIBUTION_UNDECLARED
retryable: false
```

setup 失败仍走原有原子回滚：已注册的 tool/event/prompt/service/provider 和自定义 disposer 逆序撤销，plugin record 被移除。卸载时先撤销可见贡献，再等待 in-flight callback 排空；活跃依赖存在时不能卸载被依赖 plugin。

## Loop event boundaries

`context.events.on(event, listener)` 只能订阅固定的 Agent Loop event catalog，且必须逐项声明 `event:<event>`。event 按宿主权威分为三类：

- `request` 可按 waterfall 改写一次物理模型请求；`request-error` 只能为首次失败声明一次 `{ kind: 'retry', request }`。它们是显式模型调用控制面，不授予 tool、prompt contribution 或终态权威；
- `pre-tool` 是受限的 args-only waterfall seam：宿主在隔离副本上调用 listener，最终只采纳返回对象的 `args`。tool name、call id/type、checkpoint status/approval/execution args、dynamic registration identity、idempotency key 及其他宿主字段始终恢复为原始值；
- `pre-step`、`post-tool`、`compaction`、`turn-stopping` 是 observer-only seam。它们只收到深冻结结构化克隆，返回值和原地修改均被忽略；单个 observer 异常 fail-open，后续 observer 仍按注册顺序执行。

`pre-step` 不能替换 messages 或 tool specs；需要 prompt 或 tool 能力时必须分别使用精确声明的 `prompt:<id>` 或 `tool:<name>`。`pre-tool` 替换后的 `args` 仍依次经过 tool schema、动态注册身份、只读/工作区/产物策略、当前权限模式、durable approval、side-effect checkpoint 和执行前最终验证，不能自动批准、切换工具或绕过恢复语义。进程 hook 的私有结果由宿主 symbol 单独传递，不开放为 plugin 可持久化字段。

所有 runtime event context 都是冻结的 metadata-only 对象，只包含 `userId/sessionId/jobId/stepId/iteration/phase` 及适用时的 `executed/attempt`；不传真实 job、step、AbortSignal、model request/error 或宿主 service 引用。observer 不能改写真实终态、压缩结果、审计或 checkpoint，也不会重放已提交副作用。

## Runtime tool invocation

`context.tools.register({ name, spec, exec })` 的 `exec(args, scope)` 只接收深冻结的 plain-data args 和冻结的 metadata-only scope。scope 固定包含 `name/userId/jobId/stepId/skillId/toolCallId/idempotencyKey/origin/source/signal`；tool name、`origin=plugin` 和 source plugin ID 由宿主写入。真实 `job`、`step`、budget、approval context、checkpoint、registration identity、权限对象和宿主 service 均不跨入 plugin callback。

`signal` 是唯一显式的非数据能力，但不是宿主原始 AbortSignal：wrapper 为每次调用创建独立 signal，只在该 callback 存续期间转发 abort，并在 callback 返回后解除宿主 listener。插件保留的 signal 不会观察后续宿主状态。args 与 result 上限均为 32 层、32768 节点和 8 MiB UTF-8 文本；拒绝 accessor、function、symbol、bigint、特殊 prototype、cycle 和非有限数字，稳定错误分别为 `PLUGIN_TOOL_ARGUMENT_INVALID`、`PLUGIN_TOOL_RESULT_INVALID`，且 `retryable=false`。

plugin `exec`、result snapshot 和 thrown-value sanitization 全部位于同一个 lifecycle callback accounting scope；返回 Proxy 时产生的宿主遍历也不能逃到 callback drain 之后执行。抛出值只投影自己的有界字符串 `message/code`，跨边界生成新的 Error；原始 identity、accessor、cause、stack 和其他属性均不传递，getter 不会被读取。非法或缺失 code 归一为 `PLUGIN_TOOL_EXECUTION_FAILED`，所有 plugin execution error 固定 `retryable=false`；取消只由宿主原始 signal 判定，插件不能通过错误对象触发自动重试。

这些限制不改变宿主权威：schema 验证、dynamic registration identity、durable approval、idempotency、side-effect checkpoint、审计和结果包装仍由宿主执行。卸载仍先撤销工具可见性并等待已开始 callback；stale executor 继续以 `PLUGIN_TOOL_UNAVAILABLE` 拒绝。普通非 runtime-plugin dynamic tool 不经过该 wrapper，维持已有专用 adapter 契约。

## Trusted prompt context

可信进程内 plugin 可通过 `context.prompts.register({ id, render })` 提供只追加的 chat-turn system context。`id` 必须匹配 `[a-z0-9][a-z0-9._-]{0,63}`，且 manifest 必须精确声明 `prompt:<id>`。不同 plugin 不能占用同一 prompt id；输出按注册顺序确定性渲染，卸载后立即不可见。

`render(scope)` 必须同步返回字符串或 `null`。scope 是冻结的白名单对象，仅包含 `userId`、`sessionId`、`agentId` 和最多 32 个已解析 `skillIds`；不会提供原始 query、transcript、tool trace、workspace instructions 或 canary prompt。plugin 不能选择 message role、插入位置或替换宿主块。宿主将有效输出固定放在 memory 后、workspace instructions/canary overlay 前，并仅把 `pluginId:promptId` provenance 写入 assistant model context，不持久化 prompt 正文。

宿主限制最多 16 个有效块、每块 16 KiB、总计 64 KiB。异步返回、非文本、超限或 render 异常均只省略对应块并产生脱敏 `plugin.prompt_failed` audit；不会阻断 turn，也不会截断后继续执行。该 API 只属于随宿主启动的可信进程内代码。磁盘 transformer 没有 registry context，因此不能注入 prompt、React/renderer JavaScript 或取得上述 scope。

## Model provider lifecycle

`context.models.providers.register(kind, adapter)` 只接受 adapter 自身的函数数据属性：必需的 `buildRequest/parseResponse`、可选的 `extractUsage`，以及必须成组出现的 `createStreamState/consumeStreamPayload/finishStream`。getter、setter 和 prototype 方法在注册时拒绝且不会被读取；callback 必须同步，Promise 返回值以 `PLUGIN_MODEL_PROVIDER_ASYNC_UNSUPPORTED` 拒绝。

runtime plugin adapter 的每次 callback 都进入该 plugin 的 in-flight callback accounting，并受既有 self-unregister/shutdown deadlock guard 保护。卸载先撤销 provider kind；进入 `uninstalling` 后，request 或 stream state 中曾捕获的 adapter 快照也不能启动新的 plugin callback，而是以 `PLUGIN_MODEL_PROVIDER_UNAVAILABLE`、`retryable=false` 失败。这意味着卸载前已经构建 request、但尚未执行的 response/stream adapter 不会在 plugin cleanup 后继续运行进程内代码。普通宿主注册的非 plugin adapter 仍保留原有 request lease 行为。

runtime provider callback 的参数会复制为深冻结 plain-data snapshot，结果也必须通过同一数据边界；上限为 32 层、32768 节点和 16 MiB UTF-8 文本。accessor、function、symbol、bigint、特殊 prototype、cycle 和非有限数字均 fail closed，分别使用 `PLUGIN_MODEL_PROVIDER_ARGUMENT_INVALID` 或 `PLUGIN_MODEL_PROVIDER_RESULT_INVALID`。`createStreamState` 的返回值会被复制为 wrapper 私有的 mutable plain-data state，宿主只持有不可伪造的 opaque token。每次 stream callback 都在独立 working clone 上运行，只有 callback、event result 和新 state 全部验证成功后才原子提交；插件保留的原始对象或旧 callback state 引用不能继续修改实际 state。伪造 token 或 capability state 以 `PLUGIN_MODEL_PROVIDER_STREAM_STATE_INVALID` 拒绝；stream payload 和 event result 仍分别是冻结输入与冻结输出。

## Lifecycle-safe service invocation and policy guards

宿主通过 `invokePluginService(name, method, args)` 调用 active service，而不是跨生命周期长期持有 service callback。plugin consumer 同样只能调用 `context.services.invoke(name, method, args)`；`context.services.get()` 和宿主 raw service getter 不再存在。跨 plugin 调用前，consumer manifest 必须在 `requires` 中声明实际提供该 service 的 plugin ID，否则以 `PLUGIN_SERVICE_DEPENDENCY_UNDECLARED` 拒绝；consumer 卸载后，先前捕获的 context 以 `PLUGIN_SERVICE_CONSUMER_INACTIVE` 拒绝新调用。

service method 必须是 service 对象自己的 function data property，不能通过 prototype 或 getter 注入 callback。宿主在 `provide()` 时一次性捕获最多 256 个 own property 中的函数 descriptor；后续 method swap、accessor 或 Proxy descriptor trap 不会改变已注册 callback。无法安全反射的定义在产生可见 service 前以 `PLUGIN_SERVICE_DEFINITION_INVALID`、`retryable=false` 拒绝。

参数与返回值在边界处复制为深冻结 plain-data snapshot，仅允许有限数字、字符串、布尔值、null/undefined、稠密数组和 plain object；拒绝函数、symbol、bigint、accessor、特殊 prototype、cycle、非有限数字、深度超过 32、节点超过 8192 或数据超过 1 MiB。非法参数/结果分别返回 `PLUGIN_SERVICE_ARGUMENT_INVALID` / `PLUGIN_SERVICE_RESULT_INVALID`，因此 service 不能通过返回值泄露 callback、宿主对象或其他进程内能力。

service callback 与 result snapshot 位于同一个 provider callback accounting scope，返回 Proxy 时产生的遍历不能逃到 callback drain 之后执行。抛出值只复制自己的有界字符串 `message/code` 到新的 Error；原始 identity、accessor、cause、stack 和其他属性均不跨边界，所有 service failure 固定 `retryable=false`。有效调用计入 provider plugin 的 in-flight callback：卸载先原子撤销 service 可见性，再等待已开始调用完成；service callback 不能同步等待卸载自身，否则以既有 deadlock guard 失败。`context.services.has()` 和 `hasPluginService()` 只返回 lifecycle-aware availability，不返回 service value。

### Task review guard

`service:task-review-guard` 的可信进程内 plugin 可提供 `{ review(scope) }`，在核心 TaskEvaluator/独立 Reviewer 已返回 `pass` 后执行附加终态检查。它是严格的 veto-only seam：

- 核心 verdict 为 `fixable|blocked|needs_user` 时不调用 guard，plugin 无法升级为 pass；
- 核心 pass 时，guard 只能返回 `pass|fixable|blocked|needs_user`；非 pass 会进入既有 repair/blocked/waiting 状态；
- scope 是冻结、有界的 objective、acceptance criteria、worker model、worker verification、evidence、artifact IDs 和 base acceptance；不包含完整 Job、消息、transcript、tool trace 或任意宿主 service；
- guard 返回的新 evidence 和 reviewer metadata 会被忽略；宿主保留核心证据及独立 Reviewer provenance，只接受有界 summary/issues；
- active guard 抛错、缺少 `review` 或返回非法 verdict 时 fail closed 为 `blocked`；未提供该 service 时行为与原来完全一致；
- 最终 acceptance 仅持久化白名单 `guard.pluginId/service/mode/decision/error`。磁盘 transformer 没有 service registry context，不能成为 review guard。

### Task plan guard

`service:task-plan-guard` 在模型生成计划或已登录用户通过结构化计划 API 创建 Job 时执行。plugin 同样提供 `{ review(scope) }`，但只能返回 `{ decision: 'pass'|'require_approval' }`：

- `require_approval` 只启用宿主既有的 durable plan approval；plugin 不能改写/追加步骤、改 prompt、授予工具、自动批准或取消调用方已要求的批准；
- scope 是冻结、有界的 title、objective、task type、planning source、model name、当前批准要求，以及最多 50 个经过白名单投影的步骤；不包含 userId、任意 step input、exploration notes、消息、transcript、tool trace、grants 或 service 引用；
- active guard 缺少 `review`、抛错或返回非法 decision 时 fail closed 为 `require_approval`，错误正文不持久化；guard 缺席保持既有自动执行行为；
- `created` 与 `plan_proposed` event、plan step input 只保存 `pluginId`、固定 service、`mode=approval_only`、`decision` 和稳定 error code；创建后卸载 plugin 不会撤销已经持久化的批准要求；
- `plan_proposed` 等待批准时，retry、step retry、manual completion 均以 `JOB_PLAN_APPROVAL_REQUIRED` 拒绝；计划尚未成功提出时仍允许重试失败的 plan 步骤，但任何非 plan 步骤和 manual completion 在 `plan_approved` 前都不能旁路门禁。

两个 guard 都只属于可信进程内 runtime plugin。磁盘 transformer 没有 service registry context，不能注册或调用这些 policy seam。

## Transformer adapter

已安装的 `transformer` 数据插件启用后只获得一个宿主生成的工具名：

```text
tool:plugin_<normalized-plugin-id>
```

宿主 manifest 精确声明该工具；实际 transformer 源码仍由 worker sandbox 执行，输入上限、源码上限、能力白名单、本地 owner 限制和多用户 fail-closed 策略不变。

### Atomic reload

本地 owner 可调用 `POST /api/plugins/runtime/:id/reload` 重载一个已激活的 transformer。宿主先读取受限大小的源码，并在同样受内存和超时限制的 worker/VM 中完成 validate-only 预检；预检只加载源码并确认 `transform` 为函数，不调用 `transform(input)`。

预检成功后只原子替换工具闭包持有的源码引用，不注销或重注册工具。已经开始的调用继续使用启动时捕获的旧源码，后续调用使用新源码。读取或预检失败返回 `PLUGIN_RELOAD_VALIDATION_FAILED`（或对应 entry 错误），旧工具与旧源码继续可用；未激活插件返回 `PLUGIN_RUNTIME_NOT_ACTIVE`。enable、disable、reload 和启动恢复仍按 plugin ID 串行化。

## Read-only inventory

`GET /api/plugins/runtime` 为 renderer 提供版本化的只读清单。端点只接受已登录、loopback 来源且属于本地安装 owner 的请求；多用户模式 fail closed。响应中的 `schemaVersion: 1` 每项包含：

- 纯 JSON `manifest`（`id/name/version/requires/contributes`）；
- `source`、`controllable`、`active`、`runtimeState` 和 `installedAt`；
- transformer 的持久期望状态、生成工具名及脱敏后的最近错误。

清单会合并活跃的宿主 runtime plugin、磁盘 transformer 和 SQLite 中遗留的期望状态。它不序列化 setup、tool executor、event listener、service value 或 model adapter，也不会向 renderer 暴露 entry source、绝对路径或任意 JavaScript 加载能力。renderer 的 `listRuntimePluginInventoryApi()` 仅执行该 GET 请求。
