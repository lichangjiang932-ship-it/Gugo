# Agent 体验硬化：发送、任务同步、终端、上下文与交互（2026-10-17）

基线 `648fd1b`，基于当前未提交工作树。保留暖纸主布局和右上角“侧边栏／本次改动／预览／任务清单”的名称、图标、顺序、位置。没有调用真实 Provider、没有读取真实密钥或修改用户 5175 会话，没有提交、推送、打包或发版。

## 用户决定

- 发送/纸飞机按钮改为**深色实心 + 上箭头**。
- 执行任务时，“任务清单”顶部入口与对话内进度**两者都要**同步。
- 终端的主要痛点是**命令/目录上下文**，不是换皮。
- 修改自定义 Provider ID 时**不清空** API Key、Base URL、显示名、协议和模型候选；只有明确的 catalog/模式目标切换才重置。

## 实现

1. **发送、Stop 与可见反馈**
   - `ComposerActions` 的主按钮改为 32px 深色实心 `ArrowUp`；空输入、目录审批打开、附件上传中/失败时禁用，并通过 `aria-label/title` 说明原因。运行中只输入附件时主按钮说明“只能发送文字引导”，独立 Stop 仍可用。
   - `ChatComposer` 统一计算 `sendBlockedReason/sendDisabled`，`ChatSplitView` 透传 `directoryApprovalOpen`。
   - `chatSendActions` 不再静默 return：目录审批、仅附件引导、上传中/失败同时写入对话顶部状态和 toast。
2. **任务清单实时同步**
   - 新增 `src/lib/sessionTodos.js`：规范化 `{content,status,activeForm}` 与 legacy `{text,done}`，上限 50，提供签名、transcript 派生与解析。
   - `turnEventDispatch` 在成功的 `manage_todos` 后派发 `SET_TODOS`（失败不覆盖，成功空列表清空）；reducer 规范并签名去重，避免流式重复刷新。
   - 顶部计数、`PlanCard`、工作台计划与 `ChatRightPanels` 使用同一份解析结果；`usePlanCardState` 的记忆按 session 隔离。
   - 新增对话内 `ConversationTodoList`：显示完成/进行中/待办、进度和当前项，随消息滚动，不浮动、不吸底；回合结束且全部完成后自动收起。
3. **终端：目录、生命周期和基本可用性**
   - 新增 renderer 侧 `desktopTerminalSessions.js`：按项目 key 管理 shell，模块级单一 host 订阅、有界 replay buffer；面板卸载只 detach，不 kill。
   - 主进程 `terminalHost` 返回实际起始目录；renderer reload、`render-process-gone`、主 frame 导航统一清 shell，避免孤儿。
   - 面板显示起始目录，支持在当前项目 New、同目录 Restart、两步确认 End、重开 replay、激活聚焦、退出后禁用输入。
   - 复制/粘贴：Windows `Ctrl+Shift+C/V`，macOS `Cmd+C/V`；普通 `Ctrl+C` 保留 SIGINT；右键菜单含复制/粘贴/全选/清屏。粘贴优先 `navigator.clipboard`，失败回退桌面剪贴板 IPC。
   - Windows/Linux 移除默认应用菜单，避免菜单加速键吞掉 `Ctrl+C/Ctrl+R`；文件已加入 desktop 打包 glob 和 ASAR 闭包。
   - Web 终端增加“命令控制台、非交互式”的明确说明。
4. **上下文窗口真实化**
   - 新增 `server/llm/bundledModelCatalog.js`：从随包 `shared/modelCatalogSnapshot.json` 解析窗口；先 provider+model，再全局唯一一致 id；冲突不猜。
   - `modelRuntimeProfiles` 优先级为显式设置 > models.dev > 官方能力目录 > 随包目录；`endpointProfile` 将 `bundled_catalog` 标为 estimated，官方目录仍保持精确。
   - 客户端 `contextMeter` 同时保留 `contextWindowKnown/contextWindowEstimated/contextWindowSource/windowSource`；已知估算窗口显示百分比，只有完全无法解析时才 unknown；服务端观测始终优先。
   - ContextRing 为 18px 连续圆环：精确/估算都用连续弧，未知只保留连续浅色圆环（不再使用点状虚线）；不显示可见的 `≈` 角标。`ContextUsagePanel` 与 `ChatStatusCard` 复用同一 meter，消除“14% 与未知并存”。
   - 按用户后续反馈，浮层只保留“上下文已用 + 百分比 / 已用与窗口 / 进度条 / 系统提示词·工具·对话消息”三行；不再渲染“详情”、估算说明、窗口来源、最近请求、缓存或累计诊断。
   - 自定义 Provider 的 UUID 不是目录 id 时，按模型 id 回退解析随包目录；`mimo-v2.6-flash` 有测试锁定为 1,048,576，而不是 128K 默认值。
5. **联网搜索可调用性**
   - 将 `web_search` 放入初始可发现工具集，模型不再需要先调用 `search_tools` 或命中非常窄的“联网搜索”短语才能看到搜索工具；`fetch_url` 仍在明确的查网页意图下加入，搜索结果本身可继续抓取。
   - 搜索配置仍由“设置 → 联网搜索”独立控制；未配置/关闭时返回既有明确错误，不伪造搜索结果或绕过用户设置。
6. **交互与任务中心**
   - 嵌入右侧的 preview 不再因宽度窄变成 focus overlay/inert 聊天；Escape 只在 overlay/maximized 或焦点在预览内时关闭，并尊重 IME、`defaultPrevented`、外层 dialog/popover。
   - 目录授权卡取消全局 Escape 与 autoFocus；输入框 Enter/Escape 加 IME/修饰键守卫。Composer 斜杠菜单、PlanCard、Changes/Diff 评论同步加 IME 守卫。
   - 会话标题不再渲染左侧聊天气泡图标；项目会话仍显示项目字形。右上角四入口收进 2px 间距的同一组，颜色由浅灰改为 `text-ink`、描边略加粗，保留名称、图标、顺序、位置与主布局。
   - 任务中心选择新任务时立即清空旧详情；迟到响应按当前 selected id 丢弃。Job SSE 的 401/403 进入 `unauthorized` 终态，不再指数退避重试。
   - `ChatSplit` 的权限/模型设置动作与任务解析拆到小 hook，保持容器低于 300 行结构门禁。

## 验证

- **定向**：发送/组合键/输入法/目录授权/preview 嵌入、任务同步、终端 host/manager/panel、上下文三态、catalog/endpoint 优先级、任务选择/SSE 均有行为测试；新增 `sessionTodos`、`contextWindowTruth`、`bundledModelCatalog`、`desktopTerminalSessions`、`DirectoryApprovalModal`、`ConversationTodoList` 等测试文件。
- **真实 PTY 冒烟**：使用真实 `node-pty` + `cmd.exe` 启动 shell，写入 `echo GUGO_PTY_OK` 并收到输出，返回实际起始目录后 kill；退出 0。
- **门禁**：`lint`、`typecheck`（18 个负例）、`debt:check`、`audit:functions`、`i18n:check`、`i18n:keys`、`deps:check`、`licenses`、`catalog:validate`、`desktop:check`、生产构建、离线 71 项和 `git diff --check` 通过。
- **隔离 Web**：`gugo-isolated-verification` 在 5179 端口构建/预览（独立临时 HOME/缓存，无后端/模型配置）。浏览器确认空输入时发送按钮禁用且 `aria-label` 为原因、输入后变深色实心；上下文圆环为连续圆而非点状虚线；浮层默认只显示“上下文已用 / 已用 / 三行明细 / 详情”，无模型时显示“有效窗口未知”且不伪造百分比；会话标题左侧无多余图标，右上四入口同组、颜色更深、间距更紧。没有操作 5175 用户实例。
- **联网搜索**：初始工具选择测试覆盖普通“查一下今天科技新闻”也包含 `web_search`；`chatToolSelection`、`serverTurnFlow`、`webSearchService`、`webSearchRoutes` 及相关工具集成测试全部通过。搜索执行仍要求用户在设置中配置并启用，未配置时按既有错误返回。
- **全量冻结**：串行运行（避免两个 preview-server 端口测试在并发下偶发超时），**1201 文件 PASS / 退出 0 / 约 2827 秒**；4284 个源码/配置/资源文件前后 SHA-256 完全一致（`aggregateBefore == aggregateAfter`）。并行运行时该两个端口测试曾偶发失败，单独复跑已通过，记录保留在 `freeze-result.json` 的 note 中；本结果不复用此前任何旧 PASS。

## 明确未做 / 边界

- 没有真实 Provider 或真实模型配置；上下文 1,050,000 的浏览器态来自单元/集成测试和随包目录，不在隔离预览中伪造模型。
- 没有启动真实 Electron 窗口做 PTY 交互；已用真实 `node-pty` 冒烟、Electron host/panel 单测和 `desktop:check` 验证，原生安装包/OS 沙箱仍未验收。
- 终端多 tab、跨路由完整 scrollback、TUI 状态恢复仍不在本批；项目切换时旧项目的 shell 会保留但需要切回该项目才能看到。
- `/task` 长步骤仍只在 step 边界产生事件，本批不伪造更细的实时进度。
- 既有 DEBT（链接索引、搜索 O(N)、写后验收、live 交付、桌面发布/网络边界）继续开放，不因本批关闭。
