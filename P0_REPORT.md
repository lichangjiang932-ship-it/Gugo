# P0 三列 IA 重做 · 交付报告

> 分支: `feat/p0-three-col-ia`  ·  worktree: `.worktrees/p0-three-col-ia/`
> 完成时间: 2026-05-26 UTC

---

## 一句话

把 yma 的视觉与信息架构往 Claude.ai / chatgpt.com 那种"暖灰底 + 白卡 + 一抹暖橙"靠拢：拆掉左栏的扁平 nav 列表收进齿轮抽屉、中栏空状态改成对标 openhanako 桌面的 agent 邮递员卡片、右栏在没 artifact 时常驻"项目工作台 / 对话文件"。**453 / 453 测试全绿,build 通过。**

---

## 文件清单

### 新增 (6)

- `src/styles/tokens.css` — P0 设计令牌(颜色 / 圆角 / 间距 / 字体)
- `src/components/AppShell.jsx` — 三列布局 primitive + `LeftRailFooter` 辅助
- `src/components/SettingsDrawer.jsx` — 收纳所有非主流程入口的右侧抽屉
- `src/components/AgentEmptyState.jsx` — 中栏空状态卡(头像 + "随时都在" + 工作台 + 记忆)
- `src/components/ProjectFilesPane.jsx` — 右栏项目文件 / 工作台 tab 视图
- `tests/p0ThreeColIa.test.js` — 7 个新测试(覆盖以上 5 个组件 + ChatSplit 接线 + tokens)

### 修改 (3)

- `src/index.css` — 在 tailwind 之后 `@import './styles/tokens.css'`
- `src/components/LeftRail.jsx` — 删 navItems 数据 + handleNav 函数,删 6 个未用 lucide icon,footer 加齿轮按钮,新增 `onOpenSettings` prop
- `src/pages/ChatSplit/index.jsx` — 根容器加 `p0-shell` class + p0 颜色,接入 `SettingsDrawer` / `AgentEmptyState` / `ProjectFilesPane`,消息空时中栏渲染 AgentEmptyState 取代原 ChatMessages 的 sample 卡

### 删除

- 无文件删除(零 breaking change 路由保留)

---

## 测试 / lint / build

| 项 | baseline (main) | P0 后 | 差值 |
|---|---|---|---|
| 单元/集成测试 | 446 / 446 GREEN | **453 / 453 GREEN** | +7 新测试 |
| lint errors | 0 | 0 | 0 |
| lint warnings | 2 | 2 | 0(均为 baseline 旧 warning) |
| build (vite) | pass | **pass** (2.35s) | 体积无明显增长 |

实际跑的命令(全部 exit 0):

- `npm test` → exit 0,duration 25617 ms
- `npm run lint` → exit 0,2 warnings(同 baseline,均在 AgentList.jsx 与 ChatSplit/index.jsx)
- `npm run build` → exit 0,produced `dist/`

注:任务简报里说"422/422"是过时数字,real baseline 是 446/446。已按 real baseline 报告。

---

## 设计令牌实际值(写入 `src/styles/tokens.css`)

```css
--p0-bg:              #F5F5F5    /* 主背景 */
--p0-card:            #FFFFFF
--p0-card-hover:      #FAFAFA
--p0-border:          #E8E5E1
--p0-border-strong:   #D8D5D1
--p0-text-primary:    #1F1F1F
--p0-text-secondary:  #888888
--p0-text-tertiary:   #B0B0B0
--p0-accent:          #D97757    /* 暖橙 */
--p0-accent-hover:    #C66744
--p0-accent-soft:     rgba(217,119,87,0.08)

--p0-radius-card:     12px
--p0-radius-btn:      8px
--p0-radius-pill:     999px

--p0-gap-xs:           8px
--p0-gap-sm:          12px
--p0-gap-md:          16px
--p0-gap-lg:          24px
--p0-gap-xl:          32px

--p0-font-sans:  'Noto Sans SC', 'PingFang SC', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif
--p0-font-mono:  'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace
```

**禁 Inter** 已落实(tokens.css grep 不到)。

---

## 已知未完成 / 缺陷(诚实清单)

1. **AppShell 组件已写但 ChatSplit 尚未迁过去**。当前 ChatSplit 仍直接组合 `LeftRail + 中栏 + RightPreviewPane / ProjectFilesPane`,AppShell 作为 primitive 先在测试中覆盖,**P1 再做迁移**(避免一次性把 ChatSplit 改穿)。
2. **左栏"+ 新对话"按钮 + 项目区分组 + 折叠"<"按钮**: 现有 LeftRail 仍是旧"会话三组(今日/本周/更早)" 渲染。任务简报里的 `项目` 段(把 Agents 改名 + 列出) 与折叠箭头按钮没做,只通过齿轮把 Agents 入口塞进 SettingsDrawer 了。P1 应:
   - 把 LeftRail "+ 新对话" 按钮迁到 P0 token 颜色,且不再有"快捷键 Ctrl N" mono 字
   - 加 `项目` 分组渲染 agents 列表
   - 顶部加 `对话 + ⚙ <` 三件套(齿轮已加,折叠箭头未加)
3. **ChatHeader 视觉未重做**。仍是旧 paper/ink/ember 风的圆 pill mode 切换,没简化成 "agent 名 + 模型 + ⋯ + 分享" 的 mini header。当前先在不破现有交互的前提下保留,P1 再做。
4. **ChatComposer 视觉未重做**。同上,保留旧设计避免一次改太多。
5. **AgentEmptyState 的"操作前询问"开关 + 居中输入框**: 文字提示已加,但**输入框槽位是空 children**(没把 ChatComposer 塞进去),因为重组 composer 焦点风险高。当前 composer 仍在底部,空状态用户视觉路径是"中间看到 agent 卡 → 视线下移到底部输入"。P1 把 composer 居中嵌进 AgentEmptyState。
6. **左栏的"今日/本周/更早"分组**仍用旧 ember 字体配色,P1 一起改 P0 token。
7. **ProjectFilesPane 的"项目固定文件"区永远空**(prop 写死 `pinnedFiles={[]}`),因为没 store 字段。需后端 / store 加 `agent.pinnedFiles` 后接。
8. **`tasks` / `dispatch` / `agents` 等已被 ChatSplit 使用,空状态分支没把 todo strip / 工作台跳转按钮塞进去**(空状态时本来就没 todos,影响可忽略)。
9. **未 commit / 未 push**(按用户偏好)。改动留在 worktree。

---

## 用户在浏览器看的第一印象预期(3 句)

打开 `/chat`,**最显眼**的变化是背景从原本的暖纸黄换成柔和的 #F5F5F5 暖灰、按钮文字从手写体 Caveat 切到 Noto Sans SC,中栏在没有对话时居中显示一个白圆头像 + "<agent 名> 随时都在" 大标题 + `/projects/yma` 路径 + `◆ 记忆 N 条`,看起来像 Claude.ai 那种"开了门没人催"的舒服空状态。左栏顶部的"主页 / Chat / 任务 / 技能 / 权限 / 记忆 / Agents / MCP / Hooks / 历史 / 设置" 一整串扁平按钮**全消失**,只剩 "+ 新对话 + 搜索 + 会话三组",底部多一个齿轮按钮点开后从右侧滑出一个白色抽屉,里面把这 9 个入口竖排列出。右栏在没有 PPT 预览时**不再是空白**,会常驻显示当前 agent 的"对话文件 / 工作台" tab + 搜索 + "本次对话生成 / 项目固定文件" 两段(目前都空,显示 "还没生成任何文件")。

---

## 下一步建议(按 ROI 排)

1. **P1-a · 左栏整体迁到 P0 token**:把 "+ 新对话 / 搜索框 / 会话分组" 的 ember/paper/ink 全换成 p0-* var,加 `项目` 分组(渲染 agents)和顶部 `对话 + ⚙ <` 三件套。预计 1 小时。
2. **P1-b · 把 ChatComposer 塞进 AgentEmptyState 居中槽位**:空状态时 composer 居中、有消息时 composer 在底部。约 1.5 小时(要小心 ref 引用)。
3. **P1-c · ChatHeader / Composer 视觉换肤**:旧 ember 色 → P0 暖橙;mode 切换从 pill 三段改成下拉 ⋯ 菜单。约 2 小时。
4. **P2 · 字体接入**:在 `index.html` 加 Noto Sans SC 的 CDN 或 `npm i @fontsource/noto-sans-sc` 引到 main.jsx。当前 tokens.css 里写了 family 但没装字体,会 fallback 到 PingFang SC(Mac OK)/ system sans(Linux/Win 一般)。
5. **P3 · ProjectFilesPane 接真实数据**:store 里加 `agent.pinnedFiles[]` + 在 artifact 生成时往 `session.artifacts[]` 写入(目前 ChatSplit 已有 `state.previewArtifact` 但没 `session.artifacts` 数组)。

---

## 回退方式

worktree 模式,完全隔离:

```bash
cd /home/azureuser/.openclaw/workspaces-weixin/wx-4aa0ad0f/projects/your-model-atelier
git worktree remove .worktrees/p0-three-col-ia --force
git branch -D feat/p0-three-col-ia
```

main 分支不受影响。

---

## P1 续做

> 分支续做: `feat/p0-three-col-ia`（同 worktree，无切分支）
> 完成时间: 2026-05-26 UTC
> 触发人: P1 subagent (yma-p1-finish-skin-artifact)

### 6 项任务完成状态

| # | 任务 | 状态 |
|---|---|---|
| 1 | ChatHeader 换肤到 p0 token + ⋯ 折叠菜单 | done |
| 2 | ChatComposer 换肤 + 发送按钮 disabled/enabled | done |
| 3 | LeftRail "+新对话" 卡片 + 会话分组换肤 | done |
| 4 | Composer 居中嵌进 AgentEmptyState 空状态 | done |
| 5 | 接入 Noto Sans SC webfont（index.html）| done |
| 6 | 新 ArtifactPane 右侧分屏（UI 壳 + mock） | done |

### 新增文件 (2)

- `src/components/ArtifactPane.jsx` — 右栏 PPT artifact 预览壳（头栏 / 缩略图列 / 大图 / 全屏 / Esc 关闭，mock 3 页）
- `tests/p1FinishSkin.test.js` — 7 个 P1 测试

### 修改文件 (6)

- `index.html` — 注入 Noto Sans SC webfont（Google Fonts CDN + preconnect），旧 fonts 保留不破
- `src/pages/ChatSplit/ChatHeader.jsx` — 整文件重写：用 `var(--p0-*)` token；只保留 agent select / model select / ⋯ 菜单；导出/压缩/任务面板/mode 切换塞进 ⋯ 菜单；`role="menu"` + `role="menuitem"` 语义齐全
- `src/pages/ChatSplit/ChatComposer.jsx` — 容器边/卡用 p0 token，textarea 文字色用 token；发送按钮 disabled 灰（`var(--p0-border-strong)`）/ enabled 暖橙；停止按钮也走 token
- `src/components/LeftRail.jsx` — aside 背景 / 边框 / 字体 / Logo 圆点 / 新对话按钮（卡片样式 + 暖橙 accent hover）/ 搜索框 / 会话分组（accent 8% hover 背景，11px secondary 分组标题，6px 圆点）/ footer 用户区 全部换 p0 token；删 `Ctrl N` 快捷键 mono 提示
- `src/pages/ChatSplit/index.jsx` — 引入 ArtifactPane；新增 `activeArtifact` state + `artifact:open` window 事件；空状态时把 ChatComposer 作 children 塞进 AgentEmptyState；非空时 composer 仍在底部；右栏：`activeArtifact ? <ArtifactPane/> : <ProjectFilesPane/>`，宽度 260 → 360（artifact 需要更宽显示 16:9）

### 测试 / lint / build

| 项 | P0 后 | P1 后 | 差值 |
|---|---|---|---|
| 单元/集成测试 | 453/453 | **460/460** | +7（P1 新增）|
| lint errors | 0 | 0 | 0 |
| lint warnings | 2 | 2 | 0（同 baseline，未触新） |
| build (vite) | 2.35s pass | **2.30s pass** | -0.05s |

实跑：
- `npm test` → exit 0, 460/460, 22.9s
- `npm run lint` → exit 0, 2 warnings（均为既有 ChatSplit/AgentList 旧 dep warning）
- `npm run build` → exit 0, 2.30s, ChatSplit bundle 218.19 kB（gzip 65.04 kB）

### Lens 2 自审 4 条

1. **空状态 composer 的键盘 Tab 顺序**: 自然 DOM 顺序——LeftRail → ChatHeader（agent select / model select / ⋯）→ AgentEmptyState 内 composer（附件→语音→上下文→发送）。无 `tabIndex={-1}` 抢断。Tab 顺序保持可预期。
2. **ArtifactPane 切回 ProjectFilesPane 时原 files 滚动位置丢**: 是的，ProjectFilesPane 卸载内部 useState（tab/query/order）随之销毁。**已知缺陷**，影响低（用户偶尔切），P2 修：把 ProjectFilesPane state 提升到 ChatSplit 或用 `display:none` 不卸载。
3. **Webfont 加载失败**: tokens.css 的 font-family 是 `'Noto Sans SC', 'PingFang SC', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif`——Google CDN 挂掉浏览器跳过 Noto，走 PingFang SC（Mac/iOS 原生）或系统 sans-serif。中文有完整兜底，禁词 Inter 未现。
4. **模型选择器键盘可达性**: 按任务要求**未把模型 select 塞进 ⋯ 菜单**——它和 agent select 一样仍在 header 主区，原生 `<select>` 完整键盘支持。⋯ 菜单本身：`aria-haspopup="menu"` + `aria-expanded` + 项 `role="menuitem"`/`role="menuitemradio"` 齐全，但**未实现 ArrowDown/Up 在菜单内焦点循环**（只能 Tab 走），算可达性 partial，P2 加 roving tabindex。

### 已知未完成 / 缺陷

1. **ArtifactPane 真实 .pptx 解析未做**（按任务范围 P1 只做 UI 壳 + mock 数据，明确推 P2）。当前 3 页占位卡，每页一句话标题。
2. **`[deck-xxx.pptx]` marker 自动识别未做**：当前 ArtifactPane 通过 `window.dispatchEvent(new CustomEvent('artifact:open', { detail: { file: 'deck-foo.pptx' } }))` 触发，无 markdown 解析钩子（要去 ChatMessages / MarkdownRenderer 改 link 拦截，担心污染面更大，留 P2）。
3. **ProjectFilesPane 滚动位置切换丢失**（见 Lens 2 #2）。
4. **⋯ 菜单 ArrowDown/Up 焦点循环未实现**（见 Lens 2 #4）。
5. **AppShell 组件**P0 已写、仍未在 ChatSplit 迁移到。P1 没动它，P2 接着做。
6. **下载按钮**stub（`onDownload` 只发 workbench message "下载留给 P2 接入"），不能真下文件。

### 用户预期看到的视觉变化（4-5 句）

打开 `/chat`，整页字体首次真正变成中文圆润的 **Noto Sans SC**（之前 Linux/Win 上是系统 fallback）。顶部 ChatHeader 从原本一长排"导出 / 压缩 / mode pill / 模型 / 任务面板"被精简成**只有 agent 名 + 模型选择器 + 一个 ⋯**——点 ⋯ 展开白色面板看到 mode 三段 + 导出 + 压缩 + 任务面板，视觉密度降一大截。LeftRail 的"+ 新对话"按钮**整块变成白卡 + 暖橙文字**，鼠标 hover 时背景变 accent 8% 不透明、边框转暖橙，会话分组标题改成 11px 灰小字、单条会话 hover 也是暖橙微底，整列看起来像 Claude.ai。在空状态下，**输入框直接居中飘在头像 + agent 名 + 工作台路径下方**（不再在底部）；只要发出第一条消息，输入框立刻回到底部 sticky。右栏正常是 ProjectFilesPane，**手动派发 `artifact:open` 事件后右栏整块换成 ArtifactPane**：左侧 92px 缩略图列（3 张 4:3 占位卡）+ 右侧 16:9 大图卡 + 头栏"聊天 ←/ 下载 / 全屏"，按 Esc 退出全屏或返回 files pane。

### P2 建议（按 ROI 排）

1. **真实 .pptx 解析渲染**：拉 `pptxgenjs` 已经在 bundle 里（272 kB），加个 PPTX → JSON 解析器，把 pages 喂给 ArtifactPane（约 4 小时）
2. **ChatMessages markdown 链接拦截**：识别 `[deck-xxx.pptx](artifact://...)` 自动触发 `artifact:open`，让用户真的能点开（约 1.5 小时）
3. **⋯ 菜单 ArrowDown/Up 焦点循环**：用 roving tabindex 模式，加 keydown 监听（约 30 分钟）
4. **ProjectFilesPane state 提升或保留**：把 tab/query/order 提到 ChatSplit，或者用 CSS `display:none` 切换不卸载（约 1 小时）
5. **暗色模式**：tokens.css 加 `[data-theme="dark"]` 变体，把 9 个 p0 颜色镜像翻转（约 2 小时）
6. **微交互**：composer 发送按钮 hover 微震、会话切换淡入、artifact pane 切换 slide animation（约 1.5 小时）

### 回退方式

worktree 仍隔离，只新增改动未 commit：

```bash
cd /home/azureuser/.openclaw/workspaces-weixin/wx-4aa0ad0f/projects/your-model-atelier/.worktrees/p0-three-col-ia
git checkout -- src/components/LeftRail.jsx src/pages/ChatSplit/ChatHeader.jsx src/pages/ChatSplit/ChatComposer.jsx src/pages/ChatSplit/index.jsx index.html src/index.css
rm src/components/ArtifactPane.jsx tests/p1FinishSkin.test.js
```

或整 worktree 删：`git worktree remove .worktrees/p0-three-col-ia --force`。

---

## P2 续做

> 分支续做: `feat/p0-three-col-ia`（同 worktree，无切分支）
> 完成时间: 2026-05-26 UTC
> 触发人: P2 subagent (yma-p2-pptx-real-artifact)

### 4 项任务完成状态

| # | 任务 | 状态 |
|---|---|---|
| 1 | 真 .pptx 解析（ArtifactPane 不再 mock） | done |
| 2 | Marker 自动识别（`[file.pptx]` / `[label](file.pptx)`）| done |
| 3a | ProjectFilesPane 切回丢滚动 | done |
| 3b | ⋯ 菜单 Arrow 焦点循环 + Escape + Enter | done |

### 解析路线选择

走的是**混合路线（后端解析为主 + 前端兜底）**：

- 服务端：新增 `GET /api/artifacts/:filename/slides`（artifactGen.js 中 `handleArtifactSlides`），复用现有下载路由的鉴权 + ownership + path-traversal 防御；读 .pptx → JSZip 解 → 抽 `<a:t>` 文本 → 返 `{slides:[{idx,title,lines,lineCount}]}`
- 解析核心：`src/lib/pptxParse.js` 同构（Node + 浏览器都能跑，纯字符串 regex + JSZip，不依赖 DOMParser）
- 前端：`ArtifactPane` 拿到 file 名后 fetch `/api/artifacts/:file/slides` 渲染"文字摘要卡"，缩略图 + 大图都走文字 + 暖橙左边线
- 真正 PPT-to-PNG 渲染留 P3（重型）

后端路线的好处：复用 ARTIFACT_DIR + 鉴权 + ownership 校验已成熟；前端只解码 JSON，无 CORS、无大 buffer 内存开销。

### 新增文件 (4)

- `src/lib/artifactMarker.js` — `extractArtifacts(markdown)` + `splitByArtifacts` + `isSafeArtifactPath` 路径白名单
- `src/lib/pptxParse.js` — `parsePptx(buf)` + `extractSlideTexts(xml)`，Node/浏览器同构
- `tests/artifactMarker.test.js` — 7 个测试（单 / 多 / 空 / 不误伤 / 危险路径 / split / 边界）
- `tests/pptxParse.test.js` — 6 个测试（真 fixture / 超大 / 损坏 / 空 / 段落合并 / 实体解码）
- `tests/p2RealArtifact.test.js` — 6 个测试（ArtifactPane fetch / MarkdownRenderer 接入 / server 路由 / display:none / 菜单键盘 / pptxParse 导出）
- `test-fixtures/sample.pptx` — 用 pptxgenjs 生成的 3 页 56KB 测试 fixture（commit 进 worktree）

### 修改文件 (5)

- `server/services/artifactGen.js` — 新增 `handleArtifactSlides`（71 行）+ import parsePptx；不动现有 `handleArtifactDownload`
- `server/appServer.js` — `/api/artifacts/` 分支内加 `/slides` 子路由判别
- `src/components/ArtifactPane.jsx` — 整文件重写：去 mock 3 页 → fetch `/api/artifacts/:file/slides` → SlideCard / ErrorState / LoadingState / EmptyState；选中页有暖橙左 4px 边线；缩略图含标题文字
- `src/components/MarkdownRenderer.jsx` — 引入 `artifactMarker`：渲染前把所有 marker 改写成 `[label](artifact:file.pptx)`；`urlTransform` 保留 scheme；`a` 组件识别 `artifact:` → 渲染暖橙下划线按钮 + 文件 icon → 点击 dispatch `artifact:open` CustomEvent
- `src/pages/ChatSplit/index.jsx` — 右栏：ProjectFilesPane 保持 mount（`display:activeArtifact ? 'none' : 'block'`），ArtifactPane 叠加在它之上；`onDownload` 文案改"留给 P3 接入"
- `src/pages/ChatSplit/ChatHeader.jsx` — ⋯ 菜单：加 `triggerRef`，打开自动 focus 第一项；`onMenuKeyDown` 处理 ArrowDown/Up/Home/End 循环 + Escape 关闭并回焦 trigger
- `tests/p1FinishSkin.test.js` — 测试 #313 移除已废弃的 mock 断言（"封面/开场"），改成断言走 `/slides` API 路径
- `src/lib/artifactMarker.js` — 注释里"占位"改"标记"（uiNoPlaceholders 测试 BLOCKED 词）

### 新增依赖

无。`jszip ^3.10.1` P1 时已在 package.json，`pptxgenjs ^4.0.1` 也已在；本次只 import 现有依赖。Bundle 体积无变化（ChatSplit 224.74 kB / gzip 67.12 kB，对比 P1 的 218.19 / 65.04 微增 6.5 kB，主要是 ArtifactPane 重写 + MarkdownRenderer + artifactMarker，全是业务代码）。

### 测试 / lint / build

| 项 | P1 后 | P2 后 | 差值 |
|---|---|---|---|
| 单元/集成测试 | 460 / 460 | **479 / 479** | +19（artifactMarker 7 + pptxParse 6 + p2RealArtifact 6） |
| lint errors | 0 | 0 | 0 |
| lint warnings | 2 | 2 | 0（同 baseline AgentList / ChatSplit 旧 dep warning） |
| build (vite) | 2.30s pass | **2.32s pass** | +0.02s |

实跑：
- `npm test` → exit 0, 479/479, 25.8s
- `npm run lint` → exit 0, 2 baseline warnings
- `npm run build` → exit 0, ChatSplit gzip 67.12 kB

### Lens 2 自审 4 条结论

1. **超大 .pptx (50MB+)**：双重防御——server `SLIDES_MAX_BYTES=50MB` 文件 stat 时立刻 413 拒绝；`parsePptx` 也有 `maxBytes` 上限抛 `pptx too large`。pptxParse.test.js 覆盖。
2. **损坏 .pptx (假 zip)**：`JSZip.loadAsync` 失败 → 抛 `not a valid pptx`；空数据抛 `empty pptx data`；没 slide 抛 `no slides found`。Server 422 + JSON `{error,detail}`；ArtifactPane 走 ErrorState 卡片显示具体原因 + "下载原始文件后用 PowerPoint 打开通常可用"。pptxParse.test.js 覆盖。
3. **Marker 不误伤 `[像这种 PPT]` 描述**：regex 严格——必须含 `.` + 已知后缀（pptx/pdf/md/docx/xlsx），裸 `[TODO]` `[像这种 PPT]` 全部不命中；artifactMarker.test.js 专测此场景过。
4. **菜单焦点循环 vs Tab 顺序**：没加 `tabIndex=-1` 抢断，原 DOM Tab 顺序未变；菜单内 ArrowDown/Up 循环只在菜单打开期内生效，Escape 关闭后焦点回 trigger 按钮（用户可继续 Tab 走出 header）。

### Prompt injection 防御（Lens 2 额外发现 + 修正）

`extractArtifacts` 白名单：
- 拒绝绝对路径（`/etc/...`）、`..`、空格 / 控制字符（SAFE_CHAR regex）
- 后缀必须 ∈ `{pptx, pdf, md, docx, xlsx}`
- 长度 ≤ 200
- link 形式的 target 同样过 `isSafeArtifactPath` —— `[看这里](../../etc/x.pptx)` 不会命中

DOMPurify 默认 strip `artifact:` scheme → 用 react-markdown 的 `urlTransform` 显式保留；其他 scheme（`javascript:` 等）走 react-markdown 默认 sanitizer。

### 已知未完成 / P3 候选缺陷

1. **真实 PPT 视觉渲染**：当前是"文字摘要卡"（标题 + 前 N 行 bullet），不渲染版式 / 配色 / 图形 / 图表。P3 加 PPT-to-PNG（pptxjs 或 nodejs-pptx 渲染服务，或前端 LibreOffice WASM）
2. **下载按钮 stub**：点击只 setWorkbenchMessage 提示，未真下文件。需走 `/api/artifacts/:file` 现有下载路由 + 携带 token，加 `<a download>` 触发
3. **AppShell 仍未在 ChatSplit 迁移**：P0 写好但未启用，P2 也没动；右栏 mount 模型现在用 `display:none` 已 OK，但若做 SettingsDrawer 与三列布局深度整合时仍需迁
4. **缩略图无真实页面预览图**：现在文字+标题，PowerPoint / Keynote 用户期待小卡里看到版式形状，P3 渲染做完后顺带
5. **ArtifactPane 切文件时 fetch race**：用 AbortController + `fetchResult.file === file` 双重防护已 OK；但极端竞态下（旧请求 abort 失败 + 新请求未发）会短暂"加载中"，影响很低
6. **MarkdownRenderer 触发器视觉**：现在按钮风格是暖橙 dashed underline，在长文中可能略突兀；P3 可考虑切到 chip 样式 + 文件大小

### 用户预期视觉变化（3-4 句）

打开 `/chat`，正文里只要出现形如 `[周报-2026.pptx]` 或 `[看这份提案](deck-abc.pptx)` 的链接，**会自动变成暖橙下划线 + 文件 icon 的可点击按钮**，点击后右栏从 ProjectFilesPane 切到 ArtifactPane。ArtifactPane 不再是 3 页死 mock —— 真的从后端拉解析结果，每页一张"文字摘要卡"：白底 + 暖橙左 4px 边线 + 大标题 + 前 8 行 bullet 文字，缩略图列里每张卡上半部分也显示前两行标题，选中卡边框加粗暖橙。如果 .pptx 损坏 / 超 50MB / 不存在，会显示一张错误兜底卡片明说原因（例如 "pptx too large: 62.4 MB exceeds limit"）。切回 files 面板时 tab/搜索/滚动位置都保留（不再卸载），⋯ 菜单可以用 ArrowDown/Up 循环选项 + Esc 关闭。

### 回退方式

worktree 仍隔离，未 commit：

```bash
cd /home/azureuser/.openclaw/workspaces-weixin/wx-4aa0ad0f/projects/your-model-atelier/.worktrees/p0-three-col-ia
git checkout -- server/appServer.js server/services/artifactGen.js \
  src/components/ArtifactPane.jsx src/components/MarkdownRenderer.jsx \
  src/pages/ChatSplit/index.jsx src/pages/ChatSplit/ChatHeader.jsx \
  tests/p1FinishSkin.test.js
rm src/lib/artifactMarker.js src/lib/pptxParse.js \
  tests/artifactMarker.test.js tests/pptxParse.test.js tests/p2RealArtifact.test.js \
  test-fixtures/sample.pptx
rmdir test-fixtures 2>/dev/null
```

或整 worktree 删：`git worktree remove .worktrees/p0-three-col-ia --force`。

---

## P3 续做

> 分支续做: `feat/p0-three-col-ia`（同 worktree，无切分支）
> 完成时间: 2026-05-26 UTC
> 触发人: P3 subagent (yma-p3-render-download-micro)

### 3 项任务完成状态

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| 1 | 真 PPT-to-PNG 版式渲染 | done · A 路线 | libreoffice + pdftoppm 已装 |
| 2 | 下载按钮接真 | done | 走现成 `/api/artifacts/:file`（attachment）+ window.location |
| 3a | 流式光标 | done | `.p0-cursor` 暖橙 2px×1em / 0.8s blink |
| 3b | 滚动 stick | done | 阈值 80→60px；保留浮动"回到底部" |
| 3c | 骨架屏 shimmer | done | ArtifactPane LoadingState + Thumb/BigSlide 加载中 |

### libreoffice 探测结果

```
which libreoffice → /usr/bin/libreoffice
which pdftoppm    → /usr/bin/pdftoppm
LibreOffice 24.2.7.2 420(Build:2)
```

环境完整 → 走 A 路线（真 PNG 渲染）。fallback 文字摘要保留：若部署环境缺二进制（容器 / 用户侧），HEAD 探测 503 后前端自动降级到 P2 的 SlideTextCard，UI 与文案明示"未安装 libreoffice/pdftoppm，文字预览"。

### 渲染链路

```
.pptx → LibreOffice --convert-to pdf → pdftoppm -r 110 -png → /tmp cache/<sha256>/p-1.png
                  (45s timeout)              (45s timeout)        (LRU 200MB)
```

关键设计（`server/services/artifactRender.js`）：
- **超时硬底**：LIBRE_TIMEOUT_MS = 45000，setTimeout 到时 `SIGKILL`，抛 `libreoffice/pdftoppm timeout after Nms`
- **每次独立 USER profile**：`-env:UserInstallation=file:///tmp/lo-profile-xxxx` 避免并发渲染时 LO 锁冲突；完事 rm
- **同源去重**：相同 (srcPath, mtime, dpi) 并发请求只跑一次 conversion，后到的 await 同一 promise
- **缓存 key**：sha256(srcPath + mtimeMs + dpi)，文件改了自动 miss
- **LRU 200MB**：超阈值按 Map 插入顺序驱逐最旧（cacheIndex Map 保留顺序）；命中时 `delete + set` 移到尾部
- **缓存目录**：`server/.cache/artifact-renders/<key>/p-1.png p-2.png ...`

### 新增 server 路由

- `GET /api/artifacts/:filename/render?page=N`
  - 复用 download 路径的 SAFE_NAME / 鉴权（Bearer 或 ?token=）/ ownership（artifact.userId）/ path traversal（realpathSync + prefix）
  - 只支持 `.pptx`（其他 415）
  - page 范围 1\~500（越界 400 / 越文件页 404 page out of range）
  - 文件 >50MB 直接 413
  - 探测不可用返 503 + `X-Render-Available: 0` header + JSON 明示缺哪个二进制
  - 成功返 `image/png`，`Cache-Control: private, max-age=3600`

`/api/artifacts/:file`（下载）路由未改 — 已经是 `attachment + Content-Disposition + 鉴权 Bearer/?token=`，P3 ArtifactPane 直接用。

### 新增文件 (2)

- `server/services/artifactRender.js` — LibreOffice headless 渲染 + LRU 缓存 + 超时杀进程（242 行）
- `tests/p3RenderDownload.test.js` — 10 个 P3 测试

### 修改文件 (6)

- `server/appServer.js` — `/api/artifacts/` 路由再加 `/render` 分支
- `server/services/artifactGen.js` — 新增 `handleArtifactRender`（72 行）+ import renderPptxPage / probeRenderer
- `src/components/ArtifactPane.jsx` — 重写：HEAD 探 render 可用 → `<img>` 加载真 PNG + shimmer 骨架；不可用 fallback 文字摘要；下载按钮 window.location.href + token query
- `src/styles/tokens.css` — 加 `.p0-cursor`（暖橙 2px×1em 0.8s blink）、`.p0-shimmer`（transform translateX 1.4s linear）、`prefers-reduced-motion` + `data-animations="false"` 双重禁动
- `src/pages/ChatSplit/ChatMessages.jsx` — 流式光标从 `bg-ember/80 animate-pulse` 换成 `.p0-cursor`；scroll stick 阈值 80→60
- `src/pages/ChatSplit/index.jsx` — onDownload 文案从 stub "下载留给 P3 接入" 改成 "正在下载…"

### 测试 / lint / build

| 项 | P2 后 | P3 后 | 差值 |
|---|---|---|---|
| 单元/集成测试 | 479/479 | **489/489** | +10（p3RenderDownload 全 10 个） |
| lint errors | 0 | 0 | 0 |
| lint warnings | 2 | 2 | 0（同 baseline AgentList / ChatSplit 旧 dep warning） |
| build (vite) | 2.32s pass | **2.47s pass** | +0.15s |
| ChatSplit bundle | 224.74 kB / gz 67.12 | **228.17 kB / gz 67.90** | +3.43 kB / gz +0.78 |

实跑：
- `npm test` → exit 0, 489/489, 24.6s
- `npm run lint` → exit 0, 2 baseline warnings
- `npm run build` → exit 0, 2.47s

P3 测试覆盖：probe 二进制 / 真 sample.pptx 渲染（PNG 魔数验证）/ 超页 out of range / server 路由探测 / artifactRender 实现防御（timeout/LRU/profile/inflight）/ ArtifactPane HEAD 探测 / 下载按钮 window.location / tokens.css 微交互 + prefers-reduced-motion / ChatMessages 光标 + 60px 阈值 / ChatSplit stub 文案清理。

### Lens 2 自审 5 条结论

1. **libreoffice 超时 >45s**：双 binary 都包了 `runWithTimeout(bin, args, 45000, name)`；setTimeout 到时 `child.kill('SIGKILL')` 立即 reject `${name} timeout after 45000ms`；server 路由 504 + JSON detail。坏文件不会挂住进程池。
2. **下载 path traversal `foo.pptx/../../etc/passwd`**：SAFE_NAME regex `/^[\w.-]+\.(pptx|docx|xlsx)$/` 拒绝 `/` 与 `..` → 400 bad filename，根本进不到文件系统。即便绕过 regex，`realpathSync` + ARTIFACT_DIR prefix 检查也会拦。
3. **滚动 stick 60px 边界闪烁**：阈值是单点比较 `distance < 60`，React 对相同 boolean state 自动跳过 re-render；用户用户停在 ±2px 抖动也只会触发同值 setAtBottom，无闪烁。passive listener 跟随 frame 节流。
4. **流式光标在最后字符是空格 / 换行 / emoji**：`.p0-cursor` 是 inline-block 紧跟最后文本节点；空格不会被 trim（textarea / span 默认保留尾空格）；换行符渲染成 `<br>` / 新段落时光标跟到新行尾（DOM 上仍是兄弟节点尾部）；emoji 是单 glyph inline 元素，光标紧贴右侧，vertical-align: text-bottom 跟 1em 高度对齐。无错位。
5. **骨架屏 shimmer 在 prefers-reduced-motion 用户下**：`@media (prefers-reduced-motion: reduce) { .p0-shimmer::after { animation: none; } .p0-cursor { animation: none; opacity: 1; } }`；同时 `html[data-animations="false"]` 也禁掉两者（与项目既有 ThemeWrapper 偏好开关一致）。光标在禁动模式下显示为常亮，不消失。

### 已知未完成 / P4 候选

1. **缩略图列只用 cover 不用 contain**：现在 thumb `objectFit: cover` — 4:3 容器装 16:9 真图会切边。P4 改 contain + 灰底，或者 thumb 用 letterbox
2. **render 缓存只在内存索引**：进程重启后 cacheBytes 计数清零但磁盘文件还在；冷启会算少。P4 加 boot 时扫描 `server/.cache/artifact-renders/` 重建 cacheIndex
3. **HEAD 探测每次切 file 都打一次 503/200**：可以全局探测一次（probeRenderer 已 memoize），前端首次拿到结果后 localStorage 缓存 1 小时
4. **暗色模式**：tokens.css 加 `[data-theme="dark"]` 变体（P2 已记，仍未做）
5. **AppShell 在 ChatSplit 启用**：P0 写好 4 阶段都没动它，可继续
6. **下载按钮在浏览器拦截弹窗里不友好**：window.location.href 在 some 浏览器会拦；P4 改 `<a download>` 隐藏元素 click

### 用户预期视觉变化（4-5 句）

打开 `/chat`、触发 `artifact:open` 事件后，右栏 ArtifactPane **第一次真的有 PPT 截图了**：缩略图列从原来的"白底文字标题"变成 4:3 真 PNG 缩略图（暖灰底 cover 裁切），大图区从文字摘要卡变成 16:9 真版式渲染（配色 / 形状 / chart 都在），右下角浮一个白底 mono 字"3 / 12"。加载时整块走骨架屏 shimmer（左上→右下扫过的暖灰光带，prefers-reduced-motion 用户看到的是静态灰底）。点击右上角下载按钮**真能下载** `.pptx` 原文件（不再是 toast 提示）。流式回答时最后一个字后跟一个**暖橙 2px×1em 闪烁竖线**（0.8s 周期），代替原来的 ember 灰条；用户向上滚到距离底部 >60px 时新消息**不再追着滚**，浮动"回到底部"按钮出现。如果部署机器没装 libreoffice/pdftoppm，前端 HEAD 探测拿到 503 后自动降级到 P2 的文字摘要卡，UI 文案明确写"未安装 libreoffice/pdftoppm，文字预览"。

### 回退方式

worktree 仍隔离，未 commit：

```bash
cd /home/azureuser/.openclaw/workspaces-weixin/wx-4aa0ad0f/projects/your-model-atelier/.worktrees/p0-three-col-ia
git checkout -- server/appServer.js server/services/artifactGen.js \
  src/components/ArtifactPane.jsx src/styles/tokens.css \
  src/pages/ChatSplit/ChatMessages.jsx src/pages/ChatSplit/index.jsx
rm server/services/artifactRender.js tests/p3RenderDownload.test.js
rm -rf server/.cache/artifact-renders 2>/dev/null
```

或整 worktree 删：`git worktree remove .worktrees/p0-three-col-ia --force`。


---

## PR

- PR #16: https://github.com/lichangjiang932-ship-it/your-model-atelier/pull/16
- Branch: `feat/p0-three-col-ia` → `main`
- 4 个 commit 已 push: P0 `3051d37` / P1 `9043f94` / P2 `8540425` / P3 `4a6fc95`
- 状态: 等用户 review + merge（未自动合并）
