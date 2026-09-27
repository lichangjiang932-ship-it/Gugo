# 侧边栏与浏览器：现状差距与 Chromium 化方案

2026-09-18。对照 ZCode / Codex / WorkBuddy 类产品的侧栏与内置浏览器。

## 一、诊断

### 浏览器（问题最大）
当前 `WorkbenchBrowser` 是 **iframe**。真实站点几乎都会拒绝：
- `X-Frame-Options: DENY/SAMEORIGIN` 与 CSP `frame-ancestors` —— 拒绝时**不触发任何
  DOM 事件**（`onErrorCapture` 不会响），用户只看到空白，看起来像产品坏了。
- 无会话登录（第三方 cookie 受限）、无 DevTools/查看源码、无法处理登录跳转与弹窗。
- 沙箱 iframe 与真实浏览器（下载、权限弹窗、剪贴板）行为差距过大。

这正是 ZCode / Codex / WorkBuddy 都用**宿主级 Chromium 内嵌**的原因：桌面端直接放一个
真浏览器视图（Electron `WebContentsView`），web 端才降级 iframe。

### 侧边栏（已修复的部分）
路由（任务 / 记忆 / 技能 / 历史 / 设置）一直存在，但**入口藏在账户菜单里**，侧栏看起来
只有会话列表 —— 与参考产品的"主导航常驻侧栏"差距就在这里。

## 二、本次已改

| 项 | 内容 |
|---|---|
| 侧栏主导航 | 新增 `src/components/leftRail/RailNav.jsx`：任务 / 历史 / 记忆 / 技能 / 设置 五个目的地常驻侧栏顶部；当前路由高亮（`aria-current="page"`）；折叠态（60px）同样可用；窄屏下点击后自动收起移动端侧栏 |
| 浏览器 | 内置浏览器补**刷新**按钮与失败提示保留、"在浏览器打开"常驻（iframe 被拒时的唯一可靠出口） |

## 三、Chromium 化实施合同（下一步，桌面端）

主进程（Electron）：
1. `desktop/browserView.js`：`createBrowserView({ partition: 'persist:gugo-browser' })`，
   `WebContentsView`（非 `BrowserView` 旧 API），`setBounds` 与工作台面板停靠区同步。
2. IPC（经 `desktop/preload.cjs` 暴露为 `gugoDesktop.browser.*`）：
   `navigate(url)` / `reload()` / `back()` / `forward()` / `stop()` /
   事件 `onUpdated({url,title,canGoBack,loading,favicon})` / `destroy()`。
3. 停靠同步：渲染端用 `ResizeObserver` 上报停靠矩形（x/y/width/height），主进程
   `setBounds`；切 tab、最小化、收起面板时 `destroy()`（不留孤儿视图）。
4. 安全：独立 `partition`（与 app 会话隔离）、`nodeIntegration: false`、
   `setWindowOpenHandler` → 系统浏览器外开、下载走用户确认、禁权限弹窗自动同意。

渲染端 `WorkbenchBrowser.jsx`：
- 启动时能力探测 `window.gugoDesktop?.browser` 存在 → 用宿主视图（真 Chromium）；
  否则维持现有 iframe + 外开降级（现状可用，不会更差）。
- URL 栏 / 前进后退 / 刷新 / 标题+favicon / 外开按钮共用一套 UI，只是后端不同。

### 为什么不是 Electron 旧 BrowserView / webview 标签
`webview` 标签被默认关闭且安全性差；`BrowserView` 已废弃；`WebContentsView` 是当前受支持
的停靠方案（ZCode/Codex 同类做法）。

## 四、侧栏后续（可选，按需）
- 会话列表分区（置顶 / 项目 / 最近）已是 `SessionList` 现状，无需重建。
- 待办/运行中任务角标挂在 RailNav 的"任务"入口上（复用 job 状态）。

## 五、已完成（2026-09-23）

**侧栏保持"只有对话"**：左侧只有 品牌 / 折叠按钮 / 新建对话 / 搜索 / 会话列表 / 账户区。
用户两次明确否决后已回退两样东西，**不要再加回来**：

1. **工作区标签页**（对话/文件/浏览器/终端）——侧栏属于会话，工作区属于右侧工作台。
2. **页面主导航那一行图标**（任务/历史/记忆/技能库/设置，即 `RailNav`）——用户要求"去掉这一行"。

因此 `src/components/LeftRail.jsx` 与存档提交逐字节一致。目的地改为各自的其他入口：
`/history` 有快捷键与命令面板，`/tasks` 来自斜杠命令，`/settings` `/skills` 在账户菜单，
`/memory` **原本只由那一行可达**，所以补进了账户菜单（`AccountArea.jsx`），否则该页会变成只能手输 URL。

工作区能力全部落在**右侧工作台**，其标签页不变（文件 / 侧边聊天 / 浏览器 / 终端 / 变更 / 计划）：

| 项 | 内容 |
|---|---|
| 宿主浏览器 | `desktop/browserHost.js` + `desktop/browserViewPolicy.js`：`WebContentsView`（非废弃的 `BrowserView`、非 `<webview>`），独立 `persist:gugo-browser` 分区，权限请求**一律拒绝**，`nodeIntegration:false` / `sandbox:true` / `webviewTag:false`。渲染端只上报停靠矩形与目标 URL，全部校验在主进程（每个 IPC 通道都验发送方）；新窗口一律拒绝并交给系统浏览器（只放行 http/https）。 |
| 共用一个浏览器 | `src/components/EmbeddedBrowser.jsx` + `src/components/useEmbeddedBrowser.js`：宿主可用时用宿主视图，否则退回 iframe，并在页头**写明当前后端**——iframe 被站点拒绝时不触发任何事件，不说明就会被当成产品坏了。 |
| 终端 | 右侧终端走 Agent 同一套 shell 通道，ANSI 转义序列在显示前剥离（`src/lib/terminalText.js`），否则 `ESC[33m` 会原样出现在输出里。**是命令控制台而非 PTY**：没有伪终端，全屏程序与交互式密码提示不可用——面板如实显示退出码，不假装成功。 |
| 已验证 / 未验证 | 主进程逻辑用假视图端到端单测（`tests/desktopBrowserHost.test.js`：未授权发送方、URL 白名单、矩形裁剪、隐藏/销毁、状态回报、权限全拒）；**本机没有 Electron 二进制，宿主视图未做真机运行验证**，只能在打包环境确认。 |
