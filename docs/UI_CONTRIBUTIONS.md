# UI Contributions

Gugo 的 React 壳层通过 `src/plugins/uiContributionRegistry.js` 暴露稳定的 UI contribution seam。新增已受信任的第一方页面、导航、设置面板或工具视图时，不应继续修改 `src/App.jsx`、`SettingsView.jsx` 或聊天消息中心 switch；应注册 contribution。

> 安全边界：当前 UI contribution 是随桌面应用构建、由宿主信任的 React 模块，不会从已安装的数据插件中执行任意前端 JavaScript。`server/plugins/pluginManifest.js` 管理的数据/transformer 插件不能借此注入 renderer 代码。

## 生命周期

```jsx
import { registerTrustedUiPlugin } from './uiContributionRegistry.js'

const dispose = registerTrustedUiPlugin({
  id: 'example-plugin',
  name: 'Example plugin',
  version: '1.0.0',
  requires: [],
  contributes: ['ui:route:example-route'],
}, [
  {
    id: 'example-route',
    slot: 'route',
    path: '/example',
    component: ExamplePage,
    requiresAuth: true,
  },
])

// 插件 reload、disable 或测试清理时调用；重复调用安全。
dispose()
```

`shared/pluginManifest.js` 是 runtime plugin 与可信 UI plugin 共用的 manifest envelope：`id`、`name`、`version`、`requires`、`contributes`。这些字段只从 manifest 自身的 data property 读取；getter 不执行，prototype 字段不继承，两个数组必须由稠密的 own string data property 组成。注册得到冻结快照，后续修改原 manifest/数组不会改变已安装 plugin；非法定义以 `PLUGIN_MANIFEST_DEFINITION_INVALID`、`retryable=false` 拒绝。UI 声明使用 `ui:<slot>:<id>`，并必须与实际注册项精确一致；缺失依赖、声明漂移、ID/目标冲突时整批均不会生效。活跃依赖存在时，`unregisterUiPlugin(pluginId)` 会拒绝卸载被依赖插件。

`registerUiContributions()` 仍是宿主内部与测试使用的低级原子 registry API。新的构建期插件模块应使用 `registerTrustedUiPlugin()`，以免绕过 manifest 与依赖生命周期。两种 API 返回的 disposer 都是幂等的。

每个 contribution 只从定义对象自身的 data property 生成一次注册快照；getter、symbol key 和 prototype 字段不进入 registry，注册后的 `component/path/order` 等 method/value swap 不改变已安装 contribution。输入列表与 `toolNames` 必须是稠密的 own data-property 数组；非法定义以 `UI_CONTRIBUTION_DEFINITION_INVALID`、`retryable=false` 在可见副作用前拒绝。trusted manifest 的声明校验与实际安装复用同一批快照，避免二次遍历或 TOCTOU。

注册结果按 `order`、再按稳定 key 排序。宿主核心 route、settings section 和 workbench tab 是保留目标，扩展不能覆盖；不同插件也不能声明相同目标。`getUiPlugin()` / `listUiContributions()` 的查询标识只接受真实字符串，不执行对象 coercion callback；`listUiPlugins()` 及其生命周期快照均冻结。

## Slots

| Slot | 必填字段 | 宿主传入的主要 context |
| --- | --- | --- |
| `route` | `id`, `path`, `component` | `componentProps`；默认 `requiresAuth: true` |
| `account-menu` | `id`，以及 `component` 或 `path + label/labelKey` | 自定义组件收到 `onNavigate`, `t` |
| `settings-section` | `id`, `sectionId`, `label/labelKey`, `component` | `state`, `dispatch`, `navigate`, `lang`, `t` |
| `tool-view` | `id`, `toolNames[]`, `component` | `call`, `stepNumber`, `artifacts`, `expanded`, `onToggle`, `onOpenArtifact` |
| `workbench-tab` | `id`, `tabId`, `label/labelKey`, `component` | 消息、附件、产物和发送/预览回调 |
| `conversation-node` | `id`, `component` | `msg`、消息完成/streaming 状态、产物预览回调 |

所有宿主渲染点都经过 contribution error boundary。扩展渲染失败不会击穿整个 React 壳层；route/settings/workbench 显示宿主 fallback，tool-view 回退为默认工具卡，其余附加 slot 隔离为空。

## 第一方迁移样例

`src/plugins/firstPartyUiContributions.js` 已将 MCP 和 Reasonix route，以及 MCP account-menu 入口迁移到统一 registry。新增类似页面时只需在该模块或新的受信任插件模块中注册，不再向 `src/App.jsx` 增加静态 import/route。

## 当前限制

- UI 模块仍是构建期可信代码，不支持从磁盘热加载不受信任的 React bundle。
- 服务端 runtime plugin 与 renderer registry 已共享纯 JSON manifest envelope 和 `pluginId + contribution + disposer` 生命周期原则，但不会跨进程共享或执行 renderer 代码。
- 若未来支持第三方 UI bundle，必须先加入签名、版本兼容、权限声明、CSP/隔离执行、审计和崩溃熔断；不能直接复用数据插件入口执行代码。
