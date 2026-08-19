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
