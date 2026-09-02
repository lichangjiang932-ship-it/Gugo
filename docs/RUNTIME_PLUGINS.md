# Runtime Plugin Contributions

Gugo 的进程内 runtime plugin 通过 `server/plugins/runtimePluginRegistry.js` 注册可撤销的工具、完整 Agent Loop、Agent Loop 事件、只读 Agent Events、prompt context、服务、策略和模型 provider。runtime 与构建期可信 UI plugin 共用 `shared/pluginManifest.js` 的不可变 manifest envelope。

> 安全边界：`registerPlugin()` 是宿主进程内可信代码 API。磁盘 `transformer` 插件由 `runtimePluginControlService.js` 包装，并继续在 `pluginSandbox.js` 中执行；它不能获得 registry context，也不能注入 React/renderer JavaScript。

> 宿主边界：Turn 持久化虽然已经是可整体替换的 `turnPersistenceAdapter`，但它不是 runtime-plugin contribution。宿主必须在恢复 runtime plugin 之前选择一个完整、版本匹配的 adapter；plugin 不能只替换 Session、Event Log 或 transaction 的其中一段，也不能在 TurnEngine 活跃时热切换。当前 runtime plugin contribution 表因此不包含 `storage:*`。这仍是“完全插件化”目标的过渡状态，而不是已完成的用户可分发存储插件体系。

生产服务、Vite 开发宿主和 CLI Headless 现在都通过 `server/adapters/builtinSqliteTurnPersistenceBootstrap.js` 进入 Turn persistence 的 trusted bootstrap。该发行版入口把可信模块的路径校验和完整 adapter contract 校验委托给 `server/core/turnPersistenceBootstrap.js`，但独占内置 SQLite fallback 的惰性加载与 provenance 签发；生产 composition root 不得直接调用通用 selector，也不得直接导入 SQLite adapter。配置自定义 persistence 时，未被选择的 SQLite 模块树不会加载；调用方传入的 fallback 或 factory 也不能覆盖发行版默认。生产服务与 Vite 只读取宿主进程环境或部署根 `.env` 中的 `GUGO_TURN_PERSISTENCE_MODULE` 与可选 `GUGO_TURN_PERSISTENCE_TRUST_ROOT`，并尊重 `GUGO_LOAD_DOTENV=0`；CLI 可能从不可信项目目录启动，因此只接受进程环境中的选择，当前目录 `.env` 不能令 CLI 加载宿主代码。选择器在普通 plugin discovery、数据库 preflight 和 runtime plugin restore 之前解析 canonical 本地文件，并完整校验 adapter contract。显式实现缺失、越出可信根、导入失败或契约不完整时启动失败，禁止静默回退 SQLite；激活后的 persistence 只能重启切换。普通 runtime plugin 状态不参与选择，因此不会形成“读取插件状态需要 persistence、选择 persistence 又需要插件状态”的启动环。

该闭环目前只替换 Turn Session/Event/checkpoint/recovery/SessionAdmin 边界；认证、Provider、插件状态、Hub、附件和其他宿主聚合仍有 SQLite 或本地文件实现。未来的可分发 persistence 包还需要签名信任链、安装事务、版本锁与回滚，不能把这个可信本地模块入口描述成 Marketplace。

## 本地分发源边界

生产服务、Vite 宿主和 CLI Headless 的普通磁盘插件发现通过同步 `DistributionPort` 组合两个离线来源：发行包内置 `plugins/` 标记为 `builtin-directory-readonly`，用户目录固定从权威运行时路径解析器派生为 `APP_DATA_DIR/plugins`，标记为 `managed-user-directory`。该端口不会联网、下载或执行安装脚本；managed 来源只接收本地包存储恢复并校验后的候选。直接调用 `initPlugins({ rootDir })` 的测试与开发入口仍保持原 `local-directory-development` 语义，不会把任意开发目录冒充受保护内置源。

组合顺序与目录枚举顺序无关：候选按 plugin ID 排序，跨源依赖在合并后统一校验。用户目录若声明与内置目录相同的 plugin ID，宿主保留内置项并记录 `PLUGIN_DISTRIBUTION_ID_CONFLICT`，不会按加载时序静默覆盖；两个来源若解析到同一目录，则只扫描一次内置源并记录 `PLUGIN_DISTRIBUTION_ROOT_CONFLICT`。来源、可变性、包验证状态和 install receipt 进入宿主快照及安全 inventory 投影。

managed 来源已经具备离线本地包管理闭环。`localPluginPackageStore` 对源目录生成不可变快照和 SHA-256 整包摘要，以 store revision 做 compare-and-swap，并在跨进程独占锁内完成 staging 校验、持久事务日志、备份和 rename 提交；安装、显式替换与卸载共用这条事务路径。安装回执记录 plugin/version、摘要、文件数、总字节数和安装时间；发现、列举和变更前都会在同一锁内恢复遗留事务，回滚未提交操作、保留已提交结果并清理日志，同时重新核对回执与磁盘内容，损坏时 fail closed。包卸载要求 runtime 已停用且处于 `inactive`；此前的 runtime 卸载会先撤销贡献可见性并等待已接受的 callback 排空。包服务再以共享生命周期屏障覆盖安全门禁、磁盘事务和 discovery refresh，阻止并发重新启用；活跃依赖、Release/pin/checkpoint 引用或无法确认的状态都会阻止删除。

因此 managed 候选现在是 `mutable=false`、`verifiedPackage=true` 并携带 `installReceipt`；这里的 `verifiedPackage` 只表示磁盘内容与安装回执一致。若源目录采用 `<root>/marketplace.json + <root>/plugins/<id>` 的离线布局，安装前还会按 [Plugin Compatibility Contract v1](./PLUGIN_COMPATIBILITY_V1.md) 核对 local-only 来源、整包摘要、publisher key fingerprint 和 canonical metadata 的 Ed25519 签名，并将可重验的证据写入 v2 回执；普通开发目录继续使用 `publisherVerified=false` 的 v1 回执。相邻 Marketplace 一旦存在便是权威元数据，校验失败不会降级为 unsigned。

该 Marketplace 不联网、不下载、不接受 URL，也拒绝 `INSTALLED_BY_DEFAULT`；所有安装和升级仍需本地 owner 显式确认。签名证明内容由显示的 key identity 签发，并不等于外部 CA 对人读 publisher 名称的背书。内置项的 `mutable=false` 也只表示宿主优先级与分发意图，仍是 `verifiedPackage=false`、`installReceipt=null`。磁盘 discovery candidate、公开 package receipt、Plugin Definition 和 stored Release restore 现在共用 `pluginDistributionContract.js` 的有界快照与信任身份；只有确实缺少 `distribution` 字段的旧 Release 可走 legacy 兼容，显式 `null`、来源/trust flag、receipt schema、publisher ID 或 key 改变都会 fail closed。远程发现/更新、证书吊销与透明度仍是 v1 的明确非目标，因此该离线能力不能描述成完整生态商店。

持久化 adapter 的 checkpoint/boundary 命令还必须验证宿主签发的执行租约 proof（owner ID + 单调 fencing token）。该 proof 只在 TurnEngine 获取 lease 时捕获，不向 runtime plugin context 暴露；plugin service、event listener 或工具不能伪造它来提交 Turn 终态。

## Manifest

```js
await registerPlugin({
  id: 'example-runtime',
  name: 'Example runtime plugin',
  version: '1.0.0',
  apiVersion: '1.1.0',
  hostVersion: '>=0.11.0 <1.0.0',
  requires: ['example-runtime-base'],
  dependencyVersions: {
    'example-runtime-base': '^2.0.0',
  },
  contributes: [
    'tool:example_echo',
    'event:request',
    'agent-event:turn.completed',
    'prompt:example-project-context',
    'service:example-cache',
    'service:task-review-guard',
    'service:task-plan-guard',
    'service:context-compaction-strategy',
    'service:subagent-provider',
    'model-provider:example-native',
    'loop:plugin.example-runtime.loop',
    'policy:plugin.example-runtime.policy',
    'http-capability:builtin.example-api',
  ],
}, (context) => {
  // 这里只能注册 contributes 中已声明的目标。
})
```

共享 manifest 只接受自身 data property：必填的 `id/name/version` 和可选的 `requires/contributes` 都在注册时通过 descriptor 捕获。getter 不执行，prototype 字段不被继承；两个数组必须是稠密的 own string data property 数组。宿主生成冻结快照，后续修改原 manifest 或数组不影响已安装 plugin；非法定义以 `PLUGIN_MANIFEST_DEFINITION_INVALID`、`retryable=false` 失败。

`apiVersion`、`hostVersion` 和 `dependencyVersions` 是执行门禁，不是库存标签。当前 plugin API 为 `1.1.0`；声明的 API 必须与宿主处于同一稳定 major 且不得高于宿主实现，`hostVersion` 与依赖范围使用 manifest 接受的 semver 子集（精确版本、`^`、`~`、比较器交集或 `*`）。磁盘 plugin 在加入 inventory 前检查宿主/API，并在完整扫描后按依赖版本做级联淘汰；进程内 runtime plugin 在任何 setup 代码执行前检查 active dependency 的不可变 manifest version，并在 setup 完成、转为 active 前再次检查。失败分别返回 `PLUGIN_API_VERSION_INCOMPATIBLE`、`PLUGIN_HOST_VERSION_INCOMPATIBLE`、`PLUGIN_DEPENDENCY_UNAVAILABLE` 或 `PLUGIN_DEPENDENCY_VERSION_INCOMPATIBLE`，均为 `retryable=false`。尚未声明这些字段的旧 manifest 继续按 legacy 规则加载；这只是迁移兼容，不代表其具有版本兼容承诺。

`contributes` 是权限上界，不是说明文字：

| Context API | 必须声明 |
| --- | --- |
| `context.tools.register({ name })` | `tool:<name>` |
| `context.events.on(event)` | `event:<event>` |
| `context.agentEvents.subscribe(eventType, listener)` | `agent-event:<eventType>` |
| `context.prompts.register({ id, render })` | `prompt:<id>` |
| `context.services.provide(name)` | `service:<name>` |
| `context.models.providers.register(kind)` | `model-provider:<normalized-kind>` |
| `context.loops.register({ id })` | `loop:<id>` |
| `context.policies.register(adapter, { id })` | `policy:<id>` |
| `context.http.register({ id })` | `http-capability:<id>` |

声明精确匹配且不支持通配符。插件可按配置只启用声明集合的一部分；但任何未声明注册都会在产生宿主可见副作用前失败，错误为：

```text
code: PLUGIN_CONTRIBUTION_UNDECLARED
retryable: false
```

### 只读 Agent Events（API 1.1）

`context.agentEvents.subscribe(eventType, listener, { contractVersion: 1 })` 消费 `shared/turnEvents.js` 的权威 `TURN_EVENT_TYPES`，用于观测已经持久化的 Turn 生命周期。它与 `context.events.on()` 完全独立：后者是 Agent Loop 内部 hook，部分事件允许受限改写请求；Agent Events 永远只读，listener 返回值被忽略，不能改变模型请求、工具调用、checkpoint 或终态。

每个事件类型都必须以 `agent-event:<eventType>` 精确声明，不支持 `*`。listener 接收一个分离、深冻结的 `turn.event` v1 transport envelope；其中不包含 `userId`、数据库对象、`AbortSignal` 或宿主 service 引用。单个 listener 抛错时 fail-open，并写入脱敏的 `plugin.agent_event_failed` audit；同一 consumer 的事件按发布顺序串行执行，一个插件不能污染其他 listener 的快照。

交付边界是“持久化成功之后”：内置 SQLite 从事务提交点发布，回滚不会泄露事件，幂等重写也不会重复通知；emitter 只在 adapter 返回权威 stored event 或与整个 write-behind batch 一一对应的权威回执后补发。自定义 v6 adapter 缺少可校验的逐项 batch 回执时会安全降级为不补发，而不会把请求快照冒充成已提交事实。

当前契约只是 **best-effort、进程内、提交后 live observer**，不是 reliable queue、exactly-once stream 或跨重启订阅。进程内有界 event identity 去重只用于抑制 Store 与 emitter 双入口，不承诺缓存淘汰后或进程重启后不重复；跨进程写入、进程崩溃窗口和历史事件均可能不可见。v1 API 也不暴露权威 replay/cursor，因此插件不能声称可从该接口恢复状态。可靠 v2 需要独立于 retention-pruned `turn_events` 的宿主 outbox、全局单调 cursor、稳定 subscription ID、持久 ACK、retry/backoff、DLQ 及 truncation watermark。卸载或热重载会先移除订阅可见性，再排空卸载前已经接受的 callback。

`context.tools.register()` 的 `name/spec/exec` 与 `context.prompts.register()` 的 `id/render` 必须是定义对象自己的 data property。宿主在注册时通过 descriptor 一次捕获所需值；getter 不执行，prototype property 被拒绝，注册后的 callback/schema/id swap 不改变已安装 contribution。非法定义以 `PLUGIN_CONTRIBUTION_DEFINITION_INVALID`、`retryable=false` 在可见副作用前失败。

setup 失败仍走原有原子回滚：已注册的 tool/event/prompt/service/provider 和自定义 disposer 逆序撤销，plugin record 被移除。卸载时先撤销可见贡献，再等待 in-flight callback 排空；活跃依赖存在时不能卸载被依赖 plugin。正常卸载和 setup rollback 的 disposer 都运行在显式 lifecycle cleanup scope；cleanup 不能等待卸载自身或等待整个 registry shutdown，否则分别以 `PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK` / `PLUGIN_CALLBACK_SHUTDOWN_DEADLOCK`、`retryable=false` 立即失败，避免 uninstall/install-settled 自等待死锁。其他调用方发起的重复卸载仍复用同一个 uninstall promise。

setup 本身运行在显式 installation scope：setup 不能等待卸载自身或等待 registry shutdown，否则分别以 `PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK` / `PLUGIN_CALLBACK_SHUTDOWN_DEADLOCK` 立即失败。setup Promise/thenable completion 和返回 effect 的注册时 descriptor traversal 也位于该 scope；setup 抛出值只投影 own data-property 的有界 `message/code` 到新的 `retryable=false` Error，默认 code 为 `PLUGIN_SETUP_FAILED`，不泄露原始 identity、accessor、cause 或 stack。

setup 返回或 `context.lifecycle.onDispose()` 接收的 effect 数组必须由 own `length` 与稠密 own data-property 元素组成；宿主不读取数组 iterator、getter、prototype 或稀疏项。Set 集合仅通过内建 `Set.prototype.values.call(value)` 同时完成 brand 校验和遍历，不使用 `instanceof`，不调用实例覆写的 `Symbol.iterator`；Proxy Set 不会触发 `get/getPrototypeOf` trap，也不会被当作集合接受。集合上限为 32 层、8192 个遍历节点和 4096 个 disposer；循环、超限及非法数组均以 `PLUGIN_DISPOSER_DEFINITION_INVALID`、`retryable=false` 在注册 disposer 前拒绝。每批 effect 会先完整解析并验证全部 disposer，再一次性写入 cleanup 链；即使 plugin 捕获批次错误并继续 setup，也不会残留已验证前缀。提交后捕获的 disposer own method 不受原数组、Set 或 callback 后续替换影响。

对象型 disposer 只接受 own data-property function `dispose` 或 `uninstall`，并在注册时捕获方法；getter、prototype callback 和清理期 method swap 不会成为可执行 cleanup。tool/event/prompt/service/provider 等可见 contribution 的 disposer 会先全部同步启动以立即撤销可见性，再由一个可合并的 cleanup accounting scope 等待异步 completion；安装取消、rollback 和正常卸载复用同一个 revocation Promise。tracker 会标记已由 visible revocation 完整消费的 disposer，后续 `disposeAll()` 不再调用或等待同一 result，因此自定义 cleanup thenable 的 `then()` 与失败聚合都只发生一次。跨 microtask 的自卸载或 shutdown 仍触发 lifecycle deadlock guard，而不会与外层卸载 Promise 成环。disposer 抛出值在 cleanup scope 结束前仅通过 own data-property 投影有界 `message/code`，转换为新的 `retryable=false` Error；可见 contribution 的同步或异步撤销错误也在写入 `revocationErrors` 时使用同一投影。原始 identity、accessor、cause、stack 和其他属性不进入 audit 或 `AggregateError`，非法 code 统一为 `PLUGIN_DISPOSER_FAILED`。

registry constructor 的 `config/registerTool/registerModelProvider/registerRuntimeCapability/isRuntimeCapabilityInUse/isRuntimeCapabilitySlotActive/audit` 只从 options 自身的 data property 捕获；getter 不执行，prototype adapter 被忽略，创建后的 method swap 不改变已安装宿主 adapter。非法 constructor adapter 以 `PLUGIN_HOST_ADAPTER_INVALID`、`retryable=false` 在 plugin 安装前拒绝。

`context.config` 是 registry 创建时生成的深冻结 plain-data 快照，上限为 32 层、8192 节点和 1 MiB UTF-8 文本；不会保留宿主配置引用，accessor、function、特殊 prototype、cycle 和超限值以 `PLUGIN_CONTEXT_CONFIG_INVALID` 拒绝。`context.audit.emit(event, details)` 的 event 必须是最多 128 字符的受限标识，details 是最多 16 层、4096 节点和 256 KiB 的深冻结 detached plain data；非法事件/数据分别以 `PLUGIN_AUDIT_EVENT_INVALID` / `PLUGIN_AUDIT_DATA_INVALID` 拒绝，且不会到达宿主 audit sink。audit envelope 自身也被冻结，sink 异常继续保持 observability fail-open。

所有 runtime plugin plain-data 边界以及 tool schema 中的数组，都从同一批 own descriptors 读取 `length` 和稠密元素；不会通过 `array.length` 普通属性访问执行 Proxy `get`，也不会在 descriptor 快照后再次读取原数组。原数组后续 mutation 不影响 config、参数、结果、stream state、audit 或已注册 schema 快照。

## Agent Loop replacement

可信进程内 plugin 可用 `context.loops.register(adapter, options)` 替换完整 Agent Loop。adapter 必须以 own data property 暴露当前 `contractVersion`、稳定 `id` 和 `run(context)`；manifest 必须精确声明 `loop:<adapter.id>`。当前只允许显式替换 `builtin.agent-loop`，并要求正安全整数 `priority`。`version/revision` 来自显式 options 或 plugin manifest/config revision，`owner` 固定为 plugin ID，`releaseDigest` 只来自 manifest `integrity`。可选 `healthCheck` 在 capability snapshot 解析时执行；失败会阻止 runtime ready，不能静默回退内置 Loop。

应用服务器在同一次启动中先完成 plugin discovery 和持久化 runtime plugin restore，再解析 capability snapshot，最后才把选中的 Loop 交给 lifecycle controller。恢复节点在 lifecycle 中消费这次预恢复结果，不会二次安装。停机顺序固定为 Turn/Job/恢复消费者先停止，随后释放 Loop，最后卸载 runtime plugins。已激活的 plugin Loop 禁止配置热重载或卸载，返回 `PLUGIN_LOOP_CAPABILITY_IN_USE`；停止宿主 Loop 后卸载会原子恢复内置 binding。setup、健康检查或 capability 注册失败均撤销 plugin record 和注册副作用。

第三方 Loop 不获得宿主私有执行权限。`run()` 只接收 detached、冻结的输入数据和独立事件总线；模型调用、工具执行、approval、checkpoint、steering、side-effect ledger、进度/终态 callback 均被移除或 fail closed。其返回值只能贡献有界文本，宿主会丢弃 artifact ID、delivery receipt、paused/interrupted、iteration 和其他终态声明。因此 Loop 替换不能绕过权威 tool pipeline、持久化边界或伪造本地文件回执；在宿主提供可审计 broker 契约前，外部 Loop 也不能直接发起模型或有副作用工具调用。

## Loop event boundaries

runtime registry 绑定每个 Agent Loop 时只捕获 event bus 自身的 `on/off` function data property；getter、prototype callback 和绑定后的 method swap 均不能改变连接目标，非法 bus 以 `PLUGIN_LOOP_EVENT_BUS_INVALID`、`retryable=false` 拒绝。`on(event, listener)` 若在附着 listener 后抛错或返回非函数 disposer，宿主会立即使用同一 registration snapshot 的 `off(event, listener)` 做补偿清理；补偿失败与原错误只在内部聚合。`off()` 与 event disposer 必须同步完成；native Promise rejection 只通过内建 `Promise.prototype.then` 消化，自定义 thenable 不执行 `then()`，Proxy completion 在 descriptor 访问前 fail closed，统一以 `PLUGIN_LOOP_EVENT_CLEANUP_ASYNC_UNSUPPORTED`、`retryable=false` 进入 cleanup error boundary。一个 event contribution 附着到多个 loop binding 时使用穷尽 rollback：后续 binding 注册失败后，即使较早 binding 的 disposer 抛错，其余已附着 listener 仍全部移除，contribution record 也在错误返回前撤销；attach 与 rollback 错误继续经过 setup error boundary。绑定 API 不再接收或保留 `job/step` context；插件所需的最小 metadata 只能由各事件投影显式提供。

`context.events.on(event, listener)` 只能订阅固定的 Agent Loop event catalog，且必须逐项声明 `event:<event>`。event 按宿主权威分为三类：

- `request` 可按 waterfall 改写一次物理模型请求的数据字段；`request-error` 只能为首次失败声明一次 `{ kind: 'retry', request }`。宿主先剥离并在返回后恢复 `signal`、stream callback 等非数据能力，plugin 不能读取、替换或删除它们；`request-error.error` 仅投影冻结的 `name/message/code/statusCode/retryable` metadata，不传原始 Error、cause 或 stack。它们是显式模型调用控制面，不授予 tool、prompt contribution 或终态权威；
- `pre-tool` 是受限的 args-only waterfall seam：宿主在隔离副本上调用 listener，最终只采纳返回对象的 `args`。tool name、call id/type、checkpoint status/approval/execution args、dynamic registration identity、idempotency key 及其他宿主字段始终恢复为原始值；
- `pre-step`、`post-tool`、`compaction`、`turn-stopping` 是 observer-only seam。它们只收到深冻结结构化克隆，返回值和原地修改均被忽略；单个 observer 异常 fail-open，后续 observer 仍按注册顺序执行。

`pre-step` 不能替换 messages 或 tool specs；需要 prompt 或 tool 能力时必须分别使用精确声明的 `prompt:<id>` 或 `tool:<name>`。`pre-tool` 替换后的 `args` 仍依次经过 tool schema、动态注册身份、只读/工作区/产物策略、当前权限模式、durable approval、side-effect checkpoint 和执行前最终验证，不能自动批准、切换工具或绕过恢复语义。进程 hook 的私有结果由宿主 symbol 单独传递，不开放为 plugin 可持久化字段。

所有 runtime event context 都是冻结的 metadata-only 对象，只包含 `userId/sessionId/jobId/stepId/iteration/phase` 及适用时的 `executed/attempt`；不传真实 job、step、AbortSignal、model request/error 或宿主 service 引用。observer 不能改写真实终态、压缩结果、审计或 checkpoint，也不会重放已提交副作用。

每个 runtime plugin listener 都接收独立、深冻结、有界的数据投影；control-event 返回值在同一个 lifecycle callback accounting scope 内复制为 detached plain data，上限为 32 层、32768 节点和 16 MiB。observer 返回值直接丢弃，不进入宿主对象图。返回 Proxy 时产生的遍历仍受 callback drain 保护；抛出值只生成新的、有界、`retryable=false` Error，不传原始 identity、accessor、cause 或 stack。非法输入/结果分别以 `PLUGIN_EVENT_ARGUMENT_INVALID` / `PLUGIN_EVENT_RESULT_INVALID` 拒绝，其他 listener failure 默认为 `PLUGIN_EVENT_LISTENER_FAILED`。

## Runtime tool invocation

`context.tools.register({ name, spec, exec })` 的 `exec(args, scope)` 只接收深冻结的 plain-data args 和冻结的 metadata-only scope。scope 固定包含 `name/userId/jobId/stepId/skillId/toolCallId/idempotencyKey/origin/source/signal`；tool name、`origin=plugin` 和 source plugin ID 由宿主写入。`executionContext` 及其 `job/step` metadata 容器只通过安全 own data-property 读取；Proxy 容器在任何 descriptor 访问前 fail-safe 忽略，无法检查的字段降为 `null`，不会在 plugin callback accounting 前执行 trap 或泄漏 raw error。真实 `job`、`step`、budget、approval context、checkpoint、registration identity、权限对象和宿主 service 均不跨入 plugin callback。

`signal` 是唯一显式的非数据能力，但不是宿主原始 AbortSignal：wrapper 为每次调用创建独立 signal，只在该 callback 存续期间转发 abort，并在 callback 返回后解除宿主 listener。宿主 signal 仅通过 `AbortSignal` / `EventTarget` intrinsic getter 与 listener 方法读取，不调用实例覆写的 `aborted/addEventListener/removeEventListener`；Proxy signal 在任何 intrinsic 访问前 fail-safe 忽略，不能观察内部 symbol 访问或执行 trap。插件保留的 wrapper signal 不会观察 callback 结束后的宿主状态。args 与 result 上限均为 32 层、32768 节点和 8 MiB UTF-8 文本；拒绝 accessor、function、symbol、bigint、特殊 prototype、cycle 和非有限数字，稳定错误分别为 `PLUGIN_TOOL_ARGUMENT_INVALID`、`PLUGIN_TOOL_RESULT_INVALID`，且 `retryable=false`。

plugin `exec`、result snapshot 和 thrown-value sanitization 全部位于同一个 lifecycle callback accounting scope；返回 Proxy 时产生的宿主遍历也不能逃到 callback drain 之后执行。抛出值只投影自己的有界字符串 `message/code`，跨边界生成新的 Error；原始 identity、accessor、cause、stack 和其他属性均不传递，getter 不会被读取。非法或缺失 code 归一为 `PLUGIN_TOOL_EXECUTION_FAILED`，所有 plugin execution error 固定 `retryable=false`；取消只由宿主原始 signal 判定，插件不能通过错误对象触发自动重试。

这些限制不改变宿主权威：schema 验证、dynamic registration identity、durable approval、idempotency、side-effect checkpoint、审计和结果包装仍由宿主执行。卸载仍先撤销工具可见性并等待已开始 callback；stale executor 继续以 `PLUGIN_TOOL_UNAVAILABLE` 拒绝。普通非 runtime-plugin dynamic tool 不经过该 wrapper，维持已有专用 adapter 契约。

## Trusted prompt context

可信进程内 plugin 可通过 `context.prompts.register({ id, render })` 提供只追加的 chat-turn system context。`id` 必须匹配 `[a-z0-9][a-z0-9._-]{0,63}`，且 manifest 必须精确声明 `prompt:<id>`。不同 plugin 不能占用同一 prompt id；输出按注册顺序确定性渲染，卸载后立即不可见。

`render(scope)` 必须同步返回字符串或 `null`。scope 是冻结的白名单对象，仅包含 `userId`、`sessionId`、`agentId` 和最多 32 个已解析 `skillIds`；宿主只从 render 输入自身的 data property 读取这些字段，字符串不做对象 coercion，`skillIds` 必须是稠密的 own string data-property 数组。顶层 input 或 `skillIds` Proxy 在任何 descriptor 访问前 fail closed；getter、prototype/sparse 项或非法类型同样以 `PLUGIN_PROMPT_SCOPE_INVALID`、`retryable=false` 在 renderer 前拒绝。scope 不会提供原始 query、transcript、tool trace、workspace instructions 或 canary prompt。plugin 不能选择 message role、插入位置或替换宿主块。宿主将有效输出固定放在 memory 后、workspace instructions/canary overlay 前，并仅把 `pluginId:promptId` provenance 写入 assistant model context，不持久化 prompt 正文。

宿主限制最多 16 个有效块、每块 16 KiB、总计 64 KiB。thenable 检查、文本归一化、单块字节校验和 thrown-value sanitization 均在同一个同步 callback accounting scope 内完成；自定义 thenable 只检查 own `then` descriptor，不调用或交给 `Promise.resolve()` assimilate，native Promise 仅通过内建 `Promise.prototype.then` 安装 rejection handler。返回 Proxy 不能在 callback drain 后触发反射或继续运行 thenable 代码。抛出值仅通过 own data-property 读取有界 `message/code`，再生成新的 `retryable=false` Error，不传原始 identity、getter、cause、stack 或其他属性。异步返回、非文本、超限或 render 异常均只省略对应块并产生脱敏 `plugin.prompt_failed` audit；不会阻断 turn，也不会截断后继续执行。该 API 只属于随宿主启动的可信进程内代码。磁盘 transformer 没有 registry context，因此不能注入 prompt、React/renderer JavaScript 或取得上述 scope。

## Model provider lifecycle

`context.models.providers.register(kind, adapter, options?)` 只接受真实字符串 kind 和 adapter 自身的函数数据属性：必需的 `buildRequest/parseResponse`、可选的 `extractUsage`，以及必须成组出现的 `createStreamState/consumeStreamPayload/finishStream`。完整性校验由 runtime wrapper 自身执行，不依赖可替换的 host registration adapter；getter、setter、prototype 方法、descriptor trap、缺失必需方法和不完整 stream 三件套均在任何 host registration 副作用前以 `PLUGIN_MODEL_PROVIDER_DEFINITION_INVALID`、`retryable=false` 拒绝。`ollama/lmstudio/llamacpp/vllm/anthropic/gemini/openai-compatible` 等宿主 `ENDPOINT_KINDS` 是受保护的内置 capability：普通 generic registry 不能静默覆盖；runtime plugin 只有在 manifest 精确声明 `model-provider:<kind>`、`options.replaces` 精确指向 `builtin.provider.<kind>`、`priority` 为正安全整数，且权威 runtime capability host 可用时，才能显式替换。缺少显式替换声明或优先级非法分别以 `PLUGIN_MODEL_PROVIDER_REPLACEMENT_REQUIRED`、`PLUGIN_MODEL_PROVIDER_REPLACEMENT_PRIORITY_INVALID` fail closed；卸载后恢复内置 binding。generic provider registry 的查询、存在性检查和注销对非字符串 fail closed 为 `null/false`，不会执行对象 coercion；endpoint-kind 注册同样在状态变化前拒绝非字符串。普通非 plugin adapter 的自定义字符串 kind 调用保持兼容。callback 必须同步，Promise 返回值以 `PLUGIN_MODEL_PROVIDER_ASYNC_UNSUPPORTED` 拒绝。

runtime plugin adapter 的每次 callback 都进入该 plugin 的 in-flight callback accounting，并受既有 self-unregister/shutdown deadlock guard 保护。卸载先撤销 provider kind；进入 `uninstalling` 后，request 或 stream state 中曾捕获的 adapter 快照也不能启动新的 plugin callback，而是以 `PLUGIN_MODEL_PROVIDER_UNAVAILABLE`、`retryable=false` 失败。这意味着卸载前已经构建 request、但尚未执行的 response/stream adapter 不会在 plugin cleanup 后继续运行进程内代码。普通宿主注册的非 plugin adapter 仍保留原有 request lease 行为。

runtime provider callback 的参数会复制为深冻结 plain-data snapshot，结果也必须通过同一数据边界；上限为 32 层、32768 节点和 16 MiB UTF-8 文本。accessor、function、symbol、bigint、特殊 prototype、cycle 和非有限数字均 fail closed，分别使用 `PLUGIN_MODEL_PROVIDER_ARGUMENT_INVALID` 或 `PLUGIN_MODEL_PROVIDER_RESULT_INVALID`。`createStreamState` 的返回值会被复制为 wrapper 私有的 mutable plain-data state，宿主只持有不可伪造的 opaque token。每次 stream callback 都在独立 working clone 上运行，只有 callback、event result 和新 state 全部验证成功后才原子提交；插件保留的原始对象或旧 callback state 引用不能继续修改实际 state。伪造 token 或 capability state 以 `PLUGIN_MODEL_PROVIDER_STREAM_STATE_INVALID` 拒绝；stream payload 和 event result 仍分别是冻结输入与冻结输出。

provider 的 thenable 检查、result snapshot、shape 校验和下一版 stream state 快照都在同一个同步 callback accounting scope 内完成。自定义 thenable 只检查 own `then` descriptor，拒绝时不会调用 `then()` 或通过 `Promise.resolve()` assimilate；只有真正 native Promise 使用内建 `Promise.prototype.then` 消化潜在 rejection。返回 Proxy 的反射和 thenable 代码均不能逃到 callback drain 之后。抛出值仅通过 own data-property 读取有界 `message/code`，再生成新的 `retryable=false` Error；原始 identity、getter、cause、stack 和其他属性不跨边界。非法或缺失 code 使用 `PLUGIN_MODEL_PROVIDER_EXECUTION_FAILED`，detached Error 另带宿主写入的 `pluginId/providerKind/method` provenance。

## Runtime policy adapter

可信进程内 plugin 可用同步 v1 契约替换内置审批分类器：

```js
context.policies.register({
  contractVersion: 1,
  classify({ toolName, args, options }) {
    if (toolName === 'publish_report') {
      return { decision: 'ask', risk: 'medium', reason: '发布到外部目标' }
    }
    return { decision: 'deny', risk: 'high', reason: '未识别的策略范围' }
  },
}, {
  id: 'plugin.example-runtime.policy',
  replaces: 'builtin.harness-policy',
  priority: 100,
})
```

manifest 必须精确声明 `policy:<id>`。当前最小替换面只允许显式替换 `builtin.harness-policy`，`priority` 必须是正安全整数；`id/version/revision/replaces` 通过 own data property 捕获，owner 固定为 plugin ID，Release digest 只来自 manifest `integrity`。缺少权威 runtime capability host 时注册以 `PLUGIN_POLICY_HOST_UNAVAILABLE` 失败，不会退化成仅 inventory 可见的占位贡献。setup 完成且 plugin 转为 active 后才切换策略；安装失败原子回滚，卸载恢复内置策略。

adapter 必须以 own data property 暴露 `contractVersion: 1` 和同步 `classify`。输入固定为冻结的 `{ toolName, args, options }`：args、task grants 和 remembered grants 通过有界 plain-data 快照；工具 metadata 只投影风险、并发、幂等、来源等固定字段，`getPath` 等宿主函数能力不跨边界。输出只接受 `{ decision, risk, reason, authorization? }`，其中 decision 词汇封闭为 `allow | ask | deny`，risk 封闭为 `low | medium | high`，authorization 也必须是有界 plain data。

缺失 adapter、抛错、Promise/thenable、非法输入、非法 decision/result 或超过宿主 5000ms 分类预算均统一返回 `deny` 和宿主生成的稳定 `failure.code`；插件错误正文、identity、stack、cause 和 accessor 不进入结果。同步预算只能在 callback 返回后判定并丢弃超时结果，无法抢占可信主进程代码；会阻塞 event loop 的策略必须移出进程内 plugin 信任域。

宿主通过 `acquireRuntimePolicy()` 获得同步 lease。lease 同时暴露冻结 provenance：`id/owner/version/revision/releaseDigest/generation/source`；策略替换、卸载或快照换代后，旧 lease 以 `RUNTIME_POLICY_BINDING_STALE` 拒绝，不执行旧插件 callback。审批与恢复链应持久化并复核 provenance，避免旧批准在策略漂移后继续生效。

## HTTP capability replacement

可信进程内 plugin 可用 `context.http.register({ id, priority, replaces, apiPrefixes, handle })` 注册 API capability。manifest 必须精确声明 `http-capability:<id>`；`id/replaces` 只能使用稳定 capability ID，`priority` 必须是安全整数，`apiPrefixes` 必须是 1–64 个无重复 `/api/` 前缀。`owner` 始终由宿主写成 plugin ID，插件不能伪造。定义只读取 own data property；getter、prototype callback、稀疏数组和 descriptor trap 在宿主路由变化前以 `PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID`、`retryable=false` 拒绝。

碰撞不会按加载顺序静默取胜。替换必须显式写 `replaces`，目标必须存在，而且替换项的 `priority` 必须严格高于当前目标；否则分别以 `HTTP_CAPABILITY_DUPLICATE`、`HTTP_CAPABILITY_REPLACEMENT_TARGET_MISSING` 或 `HTTP_CAPABILITY_PRIORITY_CONFLICT` 拒绝。推荐替换项沿用目标的稳定 ID，使后续更高优先级替换仍指向同一 capability slot。注册、替换、撤销和恢复均进入 HTTP capability audit；plugin registry 另外记录 `plugin.http_capability_registered`、`plugin.http_capability_unregistered`，未激活安装被取消或失败时只记录 `plugin.http_capability_discarded`。

setup 阶段只暂存声明，兼容性复检通过后才同步提交，因此半安装 plugin 不会临时遮蔽内置路由。任一 capability 激活失败会逆序撤销本次已提交项并恢复原实现。卸载先撤销全部 HTTP capability、恢复被替换项，再等待已经进入 `handle` 的 callback 排空；新请求不会进入正在卸载的 plugin，旧请求仍可完成。生产启动在恢复 runtime plugin 前绑定 app server capability registry，进程关闭则先 drain HTTP 请求再卸载 plugin。

`handle` 的有效调用计入 plugin in-flight callback；抛出值只复制 own data-property 的有界 `message/code`，生成带宿主 `pluginId/capabilityId` provenance 的新 `retryable=false` Error，不传原始 identity、getter、cause、stack 或自定义状态。该接口仍会传入原始 Node `req/res`，因此只属于与宿主同信任域的进程内 runtime plugin；磁盘 transformer 没有 registry context，不能注册或替换 HTTP capability。这一切片使路由/控制面具备显式可审计替换，但不代表用户安装代码已获得主进程执行权限。

## Lifecycle-safe service invocation and policy guards

宿主通过 `invokePluginService(name, method, args)` 调用 active service，而不是跨生命周期长期持有 service callback。plugin consumer 同样只能调用 `context.services.invoke(name, method, args)`；`context.services.get()` 和宿主 raw service getter 不再存在。跨 plugin 调用前，consumer manifest 必须在 `requires` 中声明实际提供该 service 的 plugin ID，否则以 `PLUGIN_SERVICE_DEPENDENCY_UNDECLARED` 拒绝；consumer 卸载后，先前捕获的 context 以 `PLUGIN_SERVICE_CONSUMER_INACTIVE` 拒绝新调用。

service method 必须是 service 对象自己的 function data property，不能通过 prototype 或 getter 注入 callback。宿主在 `provide()` 时一次性捕获最多 256 个 own property 中的函数 descriptor；后续 method swap、accessor 或 Proxy descriptor trap 不会改变已注册 callback。无法安全反射的定义在产生可见 service 前以 `PLUGIN_SERVICE_DEFINITION_INVALID`、`retryable=false` 拒绝。

调用参数列表本身必须是真实数组；对象、iterator 或其他非数组输入不会静默降级为空参数，也不会执行 coercion/iterator callback，而是在 provider callback 前以 `PLUGIN_SERVICE_ARGUMENT_INVALID` 拒绝。参数与返回值在边界处复制为深冻结 plain-data snapshot，仅允许有限数字、字符串、布尔值、null/undefined、稠密数组和 plain object；拒绝函数、symbol、bigint、accessor、特殊 prototype、cycle、非有限数字、深度超过 32、节点超过 8192 或数据超过 1 MiB。非法参数/结果分别返回 `PLUGIN_SERVICE_ARGUMENT_INVALID` / `PLUGIN_SERVICE_RESULT_INVALID`，因此 service 不能通过返回值泄露 callback、宿主对象或其他进程内能力。

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

### Context compaction strategy

`service:context-compaction-strategy` 是上下文压缩的受限策略槽。可信进程内 plugin 提供 `{ select(statistics) }`，返回 `{ action: 'default'|'compact', keepMessages? }`：

- `statistics` 只包含冻结的 context window、token 估算、消息总数与角色计数、工具数量、宿主阈值、默认/最大尾部数量；不包含消息正文、工具 schema、user/session ID、模型 callback、数据库或其他宿主能力；
- `compact` 可要求宿主提前压缩，`keepMessages` 只能取 `1..maxKeepMessages`，因此只能比内置策略更积极；插件不能取消 `force`、消息上限或 token 阈值已经要求的压缩；
- `default` 接受内置决定且不能附带 `keepMessages`；其他 action、越界值、异常或 5 秒超时均回退内置策略，不阻断当前模型调用；
- 返回值只影响压缩时机与保留尾部数量，不能开启语义摘要、触发额外模型调用、改写消息、改变 archive 持久化或绕过工具调用链校验；
- 每次调用都经 lifecycle-aware service invocation；卸载先撤销可见性，后续模型调用立即恢复内置策略，不长期持有 plugin callback。

该 seam 只属于可信进程内 runtime plugin；磁盘 transformer 不能获得 service registry context。

### Subagent provider

`service:subagent-provider` 是子代理执行的受限替换槽。可信进程内 plugin 提供 `{ run(scope) }`，只能返回 `{ decision: 'decline' }`，或 `{ decision: 'handled', status: 'completed'|'paused'|'interrupted'|'failed', text?, reason? }`：

- `scope` 是冻结、有界的 plain data，只含 `runId/resume/type/prompt/description/depth/model/team`。其中 model 只投影名称、Provider ID 与配置 revision；team 只投影 ID、名称、模式、角色、规模和成员序号；
- provider 不会收到 user ID、父 session/message ID、数据库、工具或 schema、审批状态、AbortSignal、callback、密钥/env、agent ID、skill ID 或 skill 正文，因而不能从该 seam 获取任何宿主能力；
- `runId` 同时是 durable run ID 与 provider 幂等键。`interrupted` 恢复继续使用同一个 ID，并传 `resume: true`；provider 必须按该键对账，不能把恢复当作新的外部操作；
- 只有 service 缺席或 provider 明确返回 `decline` 时才进入内置子代理 loop。active provider 抛错、返回非法/非终态结果或 5 秒内结果未知时，会以稳定错误码持久化为 `failed`，绝不静默在本地重跑；
- provider 返回 `handled` 后，宿主只持久化上述终态及不超过边界的 text/reason，不再调用本地模型。未知副作用的显式恢复仍固定经过内置 ledger 验证，provider 不能覆盖 `needs_verification`；
- 每次调用前先把 `invoking` 写入 durable trace，完成后再写最终决策。公开 run 的 `provider` provenance 以及 trace 中的 provider 项只包含 `pluginId/service/decision/error`，不保存插件错误正文或任意返回扩展字段；
- 调用每次都经过 lifecycle-aware `invokePluginService`，不持有 callback。卸载后新 run 立即恢复内置实现；已经完成的 durable run 按既有终态直接返回，不重复调用 provider。

该 seam 目前仍属于与宿主同信任域的进程内 runtime plugin，不代表已实现 OS 级插件隔离。

## Transformer adapter

已安装的 `transformer` 数据插件启用后只获得一个宿主生成的工具名：

```text
tool:plugin_<normalized-plugin-id>
```

宿主 manifest 精确声明该工具；实际 transformer 源码仍由 worker sandbox 执行，输入上限、源码上限、能力白名单、本地 owner 限制和多用户 fail-closed 策略不变。sandbox invocation options 只接受非 Proxy 容器的 own data-property；accessor、inherited field、descriptor trap 和对象数值 coercion 在 worker 创建前以 `PLUGIN_SANDBOX_OPTIONS_INVALID`、`retryable=false` 拒绝。`runTransformer`/`validateTransformer` 模式由宿主固定，调用方不能通过 `validateOnly` 旁路执行；timeout 仅允许 1–60000 ms，worker old-generation memory 仅允许 8–256 MiB。sandbox 只从非 Proxy plugin 定义的 own data-property 读取 `source` 或 `entryPath`；accessor、prototype callback、descriptor trap 和对象 source coercion 在创建 worker 前以 `PLUGIN_SANDBOX_DEFINITION_INVALID`、`retryable=false` 拒绝。inline source 与 entry file 均在 sandbox 层强制 512 KiB UTF-8 上限；entry 必须是 regular file，并通过固定 512 KiB+1 buffer 读取以检测 stat 后增长，超限或非法文件以 `PLUGIN_SANDBOX_SOURCE_INVALID`、`retryable=false` 拒绝。capability 列表通过有界稠密 own descriptor snapshot 过滤，不调用实例覆写的 `filter`、iterator 或 Proxy trap。transformer input 在 worker 创建前复制为最多 32 层、8192 节点和 64 KiB UTF-8 文本的 plain data；getter、capability、cycle、特殊 prototype 及任意层级 Proxy 以 `PLUGIN_SANDBOX_INPUT_INVALID`、`retryable=false` 拒绝，structured clone 不再读取调用方原始对象图。transformer output 在 worker 内按同一上限与 descriptor 规则复制后才跨线程；Promise、自定义 thenable、Proxy、accessor、cycle、特殊 prototype 和超限结果返回 `PLUGIN_SANDBOX_OUTPUT_INVALID`，不会执行 `then()`、completion getter 或对象 coercion。worker thrown value 只投影 own data-property 字符串 `message` 与宿主生成的 output error code，不读取 getter、调用 `toString()` 或暴露原始 identity/stack/cause。VM context 使用无原型 global（`vm.createContext(Object.create(null))`），`globalThis.constructor` 等构造器链停留在 context realm，无法通过 `Function`/动态代码逃逸到 worker realm 读取 `process`/`process.env`/`require`；worker 的模块局部 `require` 与宿主能力对插件不可达，输出边界进一步阻止任何泄漏回传。

### Explicit permission approval

磁盘 transformer 在首次执行前必须得到本机安装 owner 的明确授权。有效权限集合由固定的 `runtime:tool`、manifest `permissions` 以及每项 sandbox capability 对应的 `sandbox:<capability>` 组成；排序和去重后与 plugin ID、版本、Release 源码 SHA-256 及权限契约版本一起生成 `approvalDigest`。任一源码、版本或权限变化都会生成新的摘要，旧授权不能静默扩权。

`enable`、`reload` 和 `run-sandbox` 若没有匹配的持久授权，会返回 HTTP 409 / `PLUGIN_PERMISSION_APPROVAL_REQUIRED`，并在 `error.details.permissionApproval` 中提供有界的 plugin ID、版本、源码摘要、权限清单和 approval digest。renderer 只在设置页内联展示这份清单；用户明确确认后，客户端才用 `X-Gugo-Plugin-Permission-Approval` 请求头重试原动作。错误摘要、不同 plugin 的摘要或陈旧摘要均不能授权。控制端点与 sandbox 端点都要求已登录、loopback 来源且会话属于 `AUTH_MODE=local` 的安装 owner；多用户模式 fail closed。

schema v101 将授权持久化到 `runtime_plugin_permission_grants`；每条 grant 同时绑定 `plugin_id` 与固定本机 installation owner（`owner_id` 外键），读取、匹配和写入只接受当前有效的固定 owner。固定 owner 不可用时，读取视为无授权，写入以 `PLUGIN_PERMISSION_OWNER_UNAVAILABLE` fail closed。v100 grant 不含 owner，升级时不能安全推断授权人；v101 会删除这些模糊 grant，不做归属猜测，相关 Release 必须由当前固定本机 owner 再次明确授权。owner/plugin 双外键通过级联删除限定授权生命周期。启动恢复、stored Release 健康检查和每次动态工具执行都会重新匹配当前 Release 的 owner、源码摘要、规范化权限集合和 approval digest；直接改 SQLite 期望状态或替换磁盘源码不能绕过门禁。已知未通过发布门禁的 active Release 会先被判为不可执行，再尝试回滚到仍健康且具有匹配授权的 previous Release；健康但未授权的 Release 不会借回滚逻辑绕过确认。

普通 `disable` 只停止 transformer 并保留精确授权，便于用户稍后重新启用同一 Release；`POST /api/plugins/runtime/:id/revoke-permissions` 会按安装级 plugin ID 删除授权，并停用该 transformer 的持久期望状态。只有当前运行实例确实由 transformer 控制面持有时才会注销该实例；同 ID 的宿主 runtime 不属于该控制面，撤权不会停止或注销它。撤销后即使 transformer 停用清理发生错误，后续 transformer 工具执行仍因缺少授权 fail closed。reload 的新 Release 指针提交失败时会恢复本进程旧工具槽；同一数据库事务回滚会让旧 Release 指针与既有 grant 原样保留，不会留下失败候选的授权。该授权层不等于 OS sandbox；worker/VM 隔离之外的进程级强隔离仍是独立安全里程碑。

### Atomic reload

本地 owner 可调用 `POST /api/plugins/runtime/:id/reload` 重载一个已激活的 transformer。enable/reload 不再修改旧源码对象，而是创建一个新的不可变 Release：Release 绑定随机 `releaseId`、`sha256-...` 源码摘要、源码快照、执行所需的 manifest/capability 快照及校验结果。Release 以 append-only 行写入 SQLite；数据库触发器同时拒绝原地 `UPDATE` 和 `DELETE`，同一 `releaseId` 也不能再次插入。权威状态只保存 `activeReleaseId` / `previousReleaseId` 指针及单调递增的 `releaseRevision`。

切流前依次执行两道门禁：

1. 在受内存和超时限制的 worker/VM 中 validate-only，确认源码可加载且 `transform` 为函数；
2. 在独立 sandbox worker 中以 JSON `null` 做一次真实健康调用，同时验证输出可安全序列化。transformer 因而必须安全处理该探针输入。

预检失败返回 `PLUGIN_RELOAD_VALIDATION_FAILED`，健康检查失败返回 `PLUGIN_RELEASE_HEALTH_CHECK_FAILED`；两者都会保留当前权威 Release，失败候选的校验/健康结果仍留在本地发布记录中。通过门禁后，工具槽只原子替换为新 Release；已经开始的调用先捕获并继续使用旧 Release，后续调用使用新 Release，工具无需注销或重注册。权威指针提交同时比较调用方快照中的 `enabled`、`activeReleaseId` 和 `releaseRevision`；另一进程先完成 enable/disable/reload 时，陈旧操作返回 `PLUGIN_RELEASE_STATE_CONFLICT`（HTTP 409）。enable/reload（以及恢复时的 confirm/activate）把 Release 状态 CAS 与 grant 写入或现有 grant 复核放在同一个 SQLite 事务中；CAS 冲突会回滚候选 grant，grant 写入或复核失败也会回滚 Release 状态，陈旧操作不能留下或覆盖授权。reload 会恢复本进程旧工具槽，`lastRollback` 只记录审计信息，绝不把数据库 active 指针覆盖回旧值。其他指针落库失败返回 `PLUGIN_RELEASE_ACTIVATION_FAILED`。未激活插件返回 `PLUGIN_RUNTIME_NOT_ACTIVE`。进程内操作仍按 plugin ID 串行化，revision CAS 提供跨进程冲突门禁。

进程重启时，宿主优先读取 SQLite 中的 active Release 快照，复核源码摘要，并重新执行预检和健康检查；磁盘入口即使已被编辑，也不会绕过显式 reload 自动成为已发布代码。active Release 缺失、损坏或无法恢复时，若 previous Release 仍健康，则以同一 CAS 门禁激活 previous，并只把损坏 active ID 写入 rollback 审计。只有从旧版状态升级、尚无 Release 指针时，启动恢复才从当前磁盘入口创建首个 Release。

## Read-only inventory

`GET /api/plugins/runtime` 为 renderer 提供版本化的只读清单。端点只接受已登录、loopback 来源且属于本地安装 owner 的请求；多用户模式 fail closed。响应中的 `schemaVersion: 8` 包含 `plugins`、`effectiveConfigs`、当前有效的 `httpCapabilities` 和有界的进程内 `httpCapabilityAudit`，并设置 `Cache-Control: private, no-store`。有效 HTTP 项只投影 `id/owner/priority/replaces/apiPrefixes/sequence`；审计项只含事件、capability/owner/priority/sequence、时间与替换关系。两者均不包含 match/handler、源码或请求对象，使本地 owner 能核对实际生效的路由和本进程内的注册、替换、撤销、恢复历史。该历史重启后清空，不替代需要跨重启保留的安全审计存储。`plugins` 每项包含：

- 纯 JSON `manifest`（`id/name/version/requires/contributes`）；
- `source`、`controllable`、`active`、`runtimeState` 和 `installedAt`；
- transformer 的持久期望状态、生成工具名及脱敏后的最近错误。
- `activeRelease`、`previousRelease`、`latestRelease`、`releaseCount` 和最近一次 `lastRollback`；Release 身份只含 ID、SHA-256、创建时间和门禁结果。
- transformer 的 `permissionGrant`，只包含是否需要/是否匹配、当前请求权限与摘要及授权时间；`canRevokePermissions` 独立表示该 ID 是否仍有持久授权可撤销，因此磁盘定义删除、改类型或被同 ID 宿主 runtime 占用后仍不会丢失撤权入口；不包含源码、请求头或宿主密钥。
- transformer 的 `distribution`，只投影来源类型、是否可变、是否为已验证整包及是否存在安装回执；本地目录来源明确标为开发态，不冒充已安装包，也不暴露回执内容。

清单会合并活跃的宿主 runtime plugin、磁盘 transformer 和 SQLite 中遗留的期望状态。registry 的 `listPlugins()` / `getPlugin()` 返回 detached 的顶层浅拷贝；调用方可以改动返回对象或结果数组本身，但不会因此改写 registry 内部定义，共享的 `requires` 和 `contributes` 快照仍为冻结数据。`getPlugin/hasService/invokeService/unregisterPlugin` 等名称参数只接受真实字符串，不执行对象的 `toString` / `Symbol.toPrimitive`。清单不序列化 Release 源码或 manifest 快照，也不序列化 setup、tool executor、event listener、service value 或 model adapter；renderer 看不到 entry source、绝对路径或任意 JavaScript 加载能力。renderer 的 `listRuntimePluginInventoryApi()` 仅执行该 GET 请求。

## Plugin configuration layers

进程启动时会从 user、project 和显式 `runtime.json` 的 `pluginConfig.layers` 读取插件级配置。每层必须声明稳定 `id`、`kind`（`defaults|profile|bundle|installation`）、安全整数 `priority` 与按 plugin ID 分区的 `plugins` 对象；priority 从低到高合并，同 priority 再按 source 和 id 排序，因此结果与文件数组顺序无关。对象递归合并，数组和标量整体替换，插件只能收到自己 ID 下的配置。旧的 `createRuntimePluginRegistry({ config })` 仍作为所有插件共享的最低层 legacy defaults，保持既有 `context.config` 行为。

```json
{
  "env": {},
  "pluginConfig": {
    "layers": [
      {
        "id": "profile-local",
        "kind": "profile",
        "priority": 100,
        "plugins": {
          "example-plugin": { "endpoint": "http://127.0.0.1:9000" }
        }
      },
      {
        "id": "installation-local",
        "kind": "installation",
        "priority": 300,
        "plugins": {
          "example-plugin": { "apiKey": "local-secret" }
        }
      }
    ]
  }
}
```

每个 plugin setup 前，宿主生成深冻结 plain-data 快照并按 manifest `configSchema` 的常用结构约束（组合、type、enum/const、对象 required/properties/additionalProperties、数组 items/长度、字符串长度及数值边界）校验；失败时 setup 不执行，错误只报告路径和规则，不包含配置值。配置文件修改在下次进程启动或插件重新构造后生效。

`effectiveConfigs` 只列出当前进程内已注册 runtime plugin，包含合并后的配置、参与层及最终 JSON Pointer provenance。敏感 key（API key、token、secret、password、credential、authorization/cookie 等）、schema 中 `writeOnly`/`x-secret`/`x-sensitive`/敏感 format 标记的字段，以及 URL 用户凭据和敏感 query 参数会替换为固定 `[REDACTED]`；原始 secret 仍只在服务端 `context.config` 中可见。

单插件详情 `GET /api/plugins/:id` 会返回最多 50 KiB 的入口源码预览，因此使用与 runtime 控制面相同的授权：请求必须来自 loopback，并且会话必须属于 `AUTH_MODE=local` 的安装 owner；multi-user 模式即使用户已登录也返回 `LOCAL_OWNER_ONLY`，错误响应不包含 `entryPreview`。

上述保护假设应用进程独占可信的本地数据目录。能够绕过应用直接修改 SQLite 文件或替换宿主代码的本机主体不在此威胁模型中；Release 目前也没有外部签名、透明日志或硬件/远端信任根。本轮只保证应用 API、服务层和数据库触发器路径中的不可变性与并发一致性。
