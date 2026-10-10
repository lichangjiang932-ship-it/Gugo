# 并列式 Diff 审查面板：设计（待实现）

目标：把右上角「文件改动」从**覆盖式浮层 + 内联展开**，改成 Claude Code 桌面版那种
**与对话并列、可拖拽、可逐行评论、可回传给 Agent** 的完整审查闭环。

---

## 一、现状（事实，含路径）

| 能力 | 现状 |
|---|---|
| 改动清单 | `src/pages/ChatSplit/chatSplitView/SessionChangesPanel.jsx`：浮层卡片，点文件**内联展开** diff（非并列），无行号、无评论 |
| 数据源（会话内编辑） | `src/lib/sessionChanges.js`：按工具调用汇总每个文件的增删行数（`countRecordedEditLines`）、编辑明细（`edits[].removed/added`） |
| 数据源（Git） | `server/adapters/gitWorkbench.js` + `gitWorkbenchRevisionChanges.js`；面板 `src/pages/ChatSplit/rightWorkbench/WorkbenchGit.jsx`；已存在接口 `/api/workbench/git/status`、`/api/workbench/git/diff`（按文件取 diff 文本） |
| 右侧容器 | `RightWorkbench.jsx` + `WorkbenchToolbar.jsx`（8 图标工具条）+ `RightWorkbenchContent.jsx`（tab 指派）+ `RightPreviewPane.jsx`；宽度状态 `rightWorkbenchLayout.js`（可拖拽、可持久化） |
| 桌面文件操作 | `desktop/fileActions.js` IPC `open` / `reveal`；`src/lib/desktopFileClient.js` |

**缺口**：① 并列而非覆盖 ② 文件树分组 ③ 行号 + 并排 + 红绿铺底 + 语法高亮 + 双侧滚动同步
④ 行级评论 ⑤ 结构化回传 Agent ⑥ 「Review code」自审 ⑦ 对比目标切换（All / Uncommitted / vs main）
⑧ 按需加载 + 自动刷新。

---

## 二、组件树划分

```
DiffReviewLayout                 // 并列容器：左对话 / 右 Diff，宽度可拖拽、可关闭
├─ DiffReviewResizer             // 竖直拖拽条（复用 rightWorkbenchLayout 的 clamp/持久化）
└─ DiffReviewPanel               // 右侧面板（占据固定宽度，不覆盖对话）
   ├─ DiffToolbar                // 顶部：面包屑 + 图标区
   │  ├─ DiffBreadcrumb          //   main › working tree ▾ （下拉：All / Uncommitted / vs <branch>）
   │  ├─ DiffRefreshButton       //   刷新（重新拉 status/diff）
   │  ├─ DiffSearchButton        //   在 diff 文本中搜索（高亮命中）
   │  ├─ DiffOpenExternalButton  //   在新窗口打开（复用 desktopFileClient.open / 浏览器打开）
   │  ├─ DiffReviewCodeButton    //   “Review code” → 让 Agent 自审本次 diff
   │  └─ DiffCloseButton         //   × 关闭，回到只有对话
   ├─ DiffBody                   // 左右分栏
   │  ├─ FileTreePane            //   文件树：按目录分组（docs/ evals/ server/…）
   │  │  └─ FileTreeRow          //     文件名 + `+12 −3`（绿/红） + 状态（M/A/D/R）
   │  └─ DiffViewerPane          //   当前文件的差异
   │     ├─ DiffFileHeader       //     路径 + 计数 + 视图切换（并排 / 统一）
   │     ├─ SideBySideDiff       //     行对：{旧行号, 旧文本, 新行号, 新文本, kind}
   │     │  ├─ DiffRow           //       kind: context | added | removed | filler
   │     │  └─ InlineCommentSlot //       行下方评论槽（Add / 已存在）
   │     └─ DiffEmptyState       //     未选文件 / 无改动 / 加载失败
   └─ FeedbackComposer           // 底部：已收集评论 N 条 + 输入框 + “发送反馈给 Agent”
```

**为什么这样切**：
- `DiffReviewLayout` 只负责"并列 + 宽度"，与 `RightWorkbench` 同级复用同一套宽度工具，避免两套布局逻辑；
- 视图层不解析 diff：`SideBySideDiff` 只消费结构化行对，解析放在 `src/lib/`（可单测、可被 WorkbenchGit 复用）；
- `InlineComment` 是行槽而非浮层，评论与行号绑定，滚动/折叠不丢锚点。

---

## 三、状态管理设计

**不放全局 store**（只有这一个面板用）：面板内用 `useReducer` + 一个 hook 暴露动作，宽度与上次视图写 `chatUiPreferences`。

```js
// 状态形状
{
  target: { mode: 'session' | 'uncommitted' | 'all' | 'branch', branch: '' },  // 对比目标
  files: [{ path, displayPath, dir, status, additions, deletions, loaded }],   // 树数据（懒加载 diff）
  selected: '',                       // 当前文件 path
  diffs: { [path]: { status: 'idle'|'loading'|'ready'|'error', rows: [], raw: '', error: '' } },
  view: 'side-by-side' | 'unified',
  comments: [{ id, path, side: 'old'|'new', line, text, createdAt }],          // 行级评论
  draft: { path, side, line, text } | null,
  sending: false, sentAt: 0, error: ''
}
```

关键规则：
1. **懒加载**：`files` 只带计数（来自 `sessionChanges.js` 或 `git status`），`diffs[path]` 在选中时才拉；切换文件不丢已加载结果（缓存）。
2. **刷新**：监听既有"回合结束/文件被改"的信号（与 `RightWorkbench` 相同的刷新触发），对 `files` 重新取计数，并**只重取当前选中文件**的 diff；旧 diff 保留到新结果到达（避免闪烁）。
3. **评论锚定**：`{path, side, line}` 为锚点；刷新后若该行已不存在，评论标记为 `stale` 并在 UI 提示（不静默丢弃）。
4. **发送反馈**：结构化 payload（见第五节），发送成功后清空 `comments` 并记录 `sentAt` 供"已发送 N 条"回执。
5. **持久化**：仅两件事——面板宽度、上次 `view`/`target.mode`；评论不落盘（属于本次审查）。

---

## 四、数据与接口

| 需要 | 来源 | 说明 |
|---|---|---|
| 文件清单 + 增删计数（会话内） | `src/lib/sessionChanges.js` | 已有，不改 |
| 文件清单 + 状态（Git） | `/api/workbench/git/status` | 已有 |
| 单文件 diff 文本 | `/api/workbench/git/diff`（按文件） | 已有；`session` 模式用编辑明细构造 |
| 分支对比 | 复用 `gitWorkbenchRevisionChanges.js` | `vs <branch>` 时以 `<branch>...working tree` 为范围 |
| 打开/定位文件 | `desktop/fileActions.js` | 桌面壳可用；web 端退化为"复制路径" |

**解析层（新增，纯函数、可单测）**：`src/lib/diffRows.js`
```js
parseUnifiedDiff(raw)            // unified diff 文本 → 按文件切分 + hunk
toSideBySide(rows)               // hunk 行 → {旧行号,旧文本,新行号,新文本,kind}（-/+ 配对，缺侧填 filler）
countRows(rows)                  // {additions, deletions}
```
并排列对规则：hunk 内连续 `-` 段与紧随 `+` 段按序配对，行数不等时短侧补 `filler`（占位，保持两侧行号对齐）。

---

## 五、交互与反馈闭环

- **行级评论**：点行尾 `+` → `InlineCommentSlot` 变输入框；`Esc` 取消、`Cmd/Ctrl+Enter` 保存；已评论行左侧有标记，悬停显示内容，可编辑/删除。
- **发送反馈给 Agent**（底部按钮，禁用条件：无评论或正在发送）：
  ```json
  { "type": "diff_review_feedback",
    "target": { "mode": "uncommitted", "branch": "" },
    "comments": [{ "path": "server/a.js", "side": "new", "line": 42, "text": "这里没有处理空数组" }] }
  ```
  作为**一条普通用户消息**进入当前会话（走既有发送链路，不新增旁路），正文由前端渲染为可读清单 + 内嵌 JSON 块，Agent 据此修改代码。
- **Review code**（工具栏）：发送一条固定语义的消息（"请审查本次 diff：编译错误、逻辑缺陷、安全问题"）并附上 `target`，让 Agent 自审；**不自动循环**（与 Preview 一致：工具/入口在，是否用由 Agent 判断）。
- **自动刷新**：Agent 再次改文件后，`files` 计数与当前文件 diff 自动更新；若用户正在写评论，暂停刷新并在顶部提示"有新改动，点击刷新"（避免打断输入）。
- **滚动同步**：`SideBySideDiff` 两侧共用一个滚动容器（或 `onScroll` 双向同步，带递归锁）；换行折行开关影响行高，需同步重算。
- **可访问性**：`role="tree"`/`treeitem`（文件树）、`role="row"` + `aria-label="旧 12 / 新 14"`（行）、拖拽条带 `role="separator"` + 方向键调整（复用现有 workbench 拖拽实现）。

---

## 六、分阶段实施与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 | `diffRows.js`（解析 + 并排配对 + 计数）+ 单测（含行数不等、无换行结尾、多 hunk） | 单测全过；`lint`/`build` 绿 |
| 2 | `DiffReviewLayout` + 面板骨架（工具栏/关闭/拖拽宽度/持久化） | 对话与面板**并列**截图；拖拽后宽度记忆 |
| 3 | `FileTreePane`（目录分组 + 红绿计数）+ 懒加载单文件 | 点文件才拉 diff（网络日志可见只有 1 个请求） |
| 4 | `SideBySideDiff`（行号、红绿铺底、上下文行、语法高亮、滚动同步） | 并排截图：左旧右新行号、+/- 铺底、同步滚动 |
| 5 | `InlineComment` + `FeedbackComposer` + 发送反馈链路 | 加 2 条评论 → 发送 → 会话里出现结构化消息 → Agent 按评论改码 |
| 6 | 面包屑对比目标（All / Uncommitted / vs branch）+ Review code + 自动刷新 | 三种目标切换截图；Agent 改文件后面板自动更新 |

**明确不做**（避免范围蔓延）：不做冲突解决/提交/推送（提交仍归终端与 Git 工作台）、不做多文件并排、不做二进制/图片 diff（沿用预览面板）。

---

## 七、右侧其它细节：对照 Claude Code 的改进清单

| 位置 | Claude Code | 我们现状 | 建议 |
|---|---|---|---|
| 右上角按钮 | Diff / Review / 打开 / 在文件夹中显示 / 关闭，图标语义直白 | 8 图标工具条（含已禁用项） | 保留现有图标**不新增**，把"被禁用"的三个（选择元素、刷新、外开）在非预览 tab 上改为**隐藏**而非灰显，减少噪音 |
| 打开文件 | 编辑器内打开 + 列表内高亮当前文件 | `desktop:file-action` 有 open/reveal；web 端只能复制路径 | 已在预览菜单提供"打开/所在文件夹"；补齐**当前文件高亮**与"复制路径"回执 |
| 侧边浏览器 | 真 Chromium 视图 + 元素选择 + 控制台 | 桌面端有 host 视图；web 端 iframe（多数站点拒绝） | 已把"被拒"做成提示 + 一键外开；后续把 `previewPageFacts` 的选择结果接进 Agent |
| 改动视图 | 并列 diff + 行评论 | 覆盖浮层 + 内联展开 | 即本文档 |
| 空状态 | 明确告诉我"没有改动/未选择文件" | 已可读 | 沿用，补"点击文件查看差异"的引导 |

---

## 八、风险

1. **数据一致性**：`session` 模式的行号来自工具调用记录，与磁盘真实文件可能已漂移 → 行号只作展示，评论回传时**同时带上文件路径与代码片段**，让 Agent 能定位。
2. **大文件**：单文件 diff 超过阈值（如 5000 行）时分块渲染（虚拟列表），否则先只渲染 hunk 头 + 折叠。
3. **语法高亮成本**：优先复用现有 Markdown/代码渲染的 highlight 能力，若不支持则先做"仅红绿铺底 + 等宽字体"，高亮作为可选增强。
