# Runtime Plugin Contributions

Gugo 的进程内 runtime plugin 通过 `server/plugins/runtimePluginRegistry.js` 注册可撤销的工具、Agent Loop 事件、服务和模型 provider。runtime 与构建期可信 UI plugin 共用 `shared/pluginManifest.js` 的不可变 manifest envelope。

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
    'service:example-cache',
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
| `context.services.provide(name)` | `service:<name>` |
| `context.models.providers.register(kind)` | `model-provider:<normalized-kind>` |

声明精确匹配且不支持通配符。插件可按配置只启用声明集合的一部分；但任何未声明注册都会在产生宿主可见副作用前失败，错误为：

```text
code: PLUGIN_CONTRIBUTION_UNDECLARED
retryable: false
```

setup 失败仍走原有原子回滚：已注册的 tool/event/service/provider 和自定义 disposer 逆序撤销，plugin record 被移除。卸载时先撤销可见贡献，再等待 in-flight callback 排空；活跃依赖存在时不能卸载被依赖 plugin。

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
