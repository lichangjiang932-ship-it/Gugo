# Gugo UI 视觉与细节优化计划

> 状态：**待评审**（本次仅诊断，未改动任何代码）
> 范围：`src/**/*.jsx`（233 个组件，16,326 行）+ `src/index.css`（2,772 行）
> 版本基线：v0.11.72 / `main` / `0c2d569`

---

## 一、诊断结论：为什么"该有的都有，但看着难受"

你的直觉是对的。**这不是功能缺失，是"手工作坊"的结构性必然**。

先说结论：Gugo 的**设计令牌（design token）层是健全的**——`paper / ink / accent` 三色体系、三套主题（light / dark / white）、语义色、代码高亮调色板、甚至为了让执行日志"两种声音"而做的精细排版决策（`index.css:35-37`、`624-640` 的注释），这些都说明**有人认真做过设计**。

但令牌层之上，**没有任何一层原子组件**。全项目 **547 个 `<button>` 手写 className，散布在 165 个文件里，零个共享 `<Button>`**。后果是每一处细节都在独立漂移：

| 你感受到的"难受" | 真实原因（可量化） |
|---|---|
| **看着乱** | 按钮高度 7 种取值（h-6:35 / h-7:66 / h-8:141 / h-9:120 / h-10:30 / h-11:11 / h-12:12），圆角 5 套体系，卡片阴影 6 种配方，图标尺寸 5 档 |
| **点了没反应** | **547 个按钮中 546 个（99.8%）没有按下态**。全项目 `active:` 仅 2 处命中，其中 1 处还是变量名误报（`HistoryView.jsx:49`）。点"允许一次"按钮纹丝不动 |
| **鼠标滑过黏滞** | 动效几乎不存在：`transition` 223 处但 `duration-200` 仅 4 处、`duration-300` 仅 3 处；`transition-all` 12 处且全在无 transition 的元素上（**零效果**） |
| **层次发虚** | z-index 规范只定义 3 级，实际散落 11 种；`.chat-session-header` 只有 20 反而低于 overlay:40；`index.css:911` 不得不用 `:has()` 打 z-index 补丁（注释自认 *"or the project chip draws through that menu"*） |
| **看不清/不敢点** | 焦点体系 3 套并存：`focus-visible:ring` 65 处（合格）vs `focus:border/bg` 74 处（**鼠标点击后焦点环消失**，违反 WCAG 2.4.7）vs `outline-none` 107 处 |
| **空荡荡** | **空状态组件全项目 0 个**。227 个 jsx 里 `empty` 关键词仅 1 处。`ChatRightPanels.jsx:48` 关闭态直接 `return null` |
| **字号乱** | `text-[10px]` 76 处 + `text-[9px]` 31 处 = **107 处绕过 12px 可读下限**，甚至有 1 处 `text-[10.5px]` |
| **风格没气质** | `font-display: "Cormorant Garamond"` 被用了 8 处，但**全项目 0 个 `@font-face`、0 个 Google Fonts 链接**——所有人都在看系统兜底的 Georgia。设计意图完全没落地 |

**一句话诊断：你的项目有 excellent 的色彩令牌，但没有任何"组件宪法"来强制执行它。令牌是死的，组件是散的。**

---

## 二、必须先修的 3 个真 Bug（非审美问题）

### Bug 1｜强调色按钮的对比度在浅色主题下不达标 ⚠️ 最高优先级

`.btn-primary` 用 `bg-accent`（`#16A34A` 绿），而 `--color-accent-contrast-rgb: 0 0 0`（`index.css:111`，即黑字）。实测对比度 **6.37:1 达标**——但真正的问题是**同一个绿 `#16A34A` 被当正文色用了 119 次**（`text-accent`），实测在 `#F7F8FA` 上仅 **3.10:1**，**低于 WCAG AA 正文 4.5:1 门槛**。项目里已有更深的 `text-accent-ink`（`#166534`，6.71:1，83 处），但两者混用。

同类问题：`text-cyan` 6 处，`#2E8FA3` = **3.55:1**，同样不达标。

> 暗色主题下全部达标（accent 5.38:1、ink-fade 6.91:1），**所以这是浅色主题专属的对比度缺口**。

### Bug 2｜字体完全未加载 —— 设计意图 100% 落空

```
grep -rn "fonts.googleapis|@font-face|@import url" src/ index.html  →  0 结果
```

`tailwind.config.js:58` 声明 `display: ['"Cormorant Garamond"', 'Georgia', 'serif']`，`hand: Caveat`、`print: Architects Daughter` 同理。**这些字体一次都没被下载过**，8 处 `font-display` 标题全部渲染为 Georgia。中文界面里 Georgia 只作用于拉丁字母，造成**中英混排字重/风格割裂**。

### Bug 3｜`bg-accent-soft/80` 双重透明度叠加

`ChatComposer.jsx:164` 的拖拽遮罩写 `bg-accent-soft/80`，而 `--color-accent-soft` **本身已是 `rgba(22,163,74,0.18)`**（`index.css:25`）。Tailwind 的 `/80` 叠上去 → 实际不透明度远低于设计预期，遮罩几乎看不见。**全项目 10 处**同类型错误。

---

## 三、优化计划（分 5 阶段，按 ROI 排序）

> 原则：**先建宪法，再改细节**。跳过 P0 直接改样式，只会制造新的不一致。

### P0 — 立宪（约 1 天，纯新增，无回归风险）

**目标：把"令牌"变成"组件"，让一致性从此自动发生。**

1. **新建 `src/components/ui/`**，产出 4 个原子组件（**先只做 4 个，不贪多**）：
   - `<Button variant="primary|secondary|ghost|danger" size="sm|md|lg">` — 消灭 7 种高度
   - `<Toggle checked onChange>` — 消灭 **4 套重复开关实现**（轨道尺寸 40×20 / 44×24 / 38×22，5 个文件各写一遍，`SettingsToolsPanel.jsx:57` 纯粹是 `IntegrationToggle` 的复制品）
   - `<Field label error hint>` — 消灭 label 间距 3 种、`ProviderEditor.jsx:13` 的无焦点环表单
   - `<Card>` / `<SectionHeading>` — 消灭卡片标题 5 种字号、padding 4 种
2. **扩展 tailwind.config.js 语义层**：`height.control/sm/md`、`text.meta` 等，补 `boxShadow` 的 4 级语义（overlay/menu/card/float），新增 `focus ring` 统一配方。
3. **给旧类名留兼容层**，不删任何现有代码——`rounded-md`→`rounded-control` 这类改动走 codemod 批量做，**分批 PR，每批 ≤30 文件**。

> **关键决策**：不追求一次性替换 547 个按钮。先在新页面用新组件，存量页面按 PR 逐步迁移。一次性大爆炸式重构必然引发 165 个文件的回归。

### P1 — 交互手感（约 2 天，**这是"点了没反应"的解药**）

4. **统一按下态**：给 `.btn-primary/.btn-ghost` 加 `active:scale-[0.98] active:brightness-95`（只动 transform + opacity，GPU 加速，≤200ms）。这是**投入产出比最高的一条**——一个类改动让 547 个按钮同时"活过来"。
5. **补齐动效令牌**：`--dur-fast:120ms / --dur-base:180ms / --dur-slow:240ms`，配套 `ease-out`。当前 4 处 `duration-200` 直接改为消费令牌。
6. **清除 12 处无效 `transition-all`**（挂在无 transition 属性的元素上，纯代码噪音）。
7. **统一焦点环**：107 处 `outline-none` 逐个补 `focus-visible:ring-2 focus-visible:ring-focus/45 focus-visible:ring-offset-2`。`ProviderEditor.jsx:13` 那个用 `[&_input]:` 任意变体绕过组件的表单是重灾区，**它整表无焦点环**。
8. **修 Bug 1**：`text-accent` → `text-accent-ink`（119 处，浅色主题对比度 3.10:1 → 6.71:1）；`text-cyan` 6 处同样处理。

### P2 — 视觉秩序（约 3 天）

9. **z-index 收编**：把散落的 11 种收敛到配置的 5 级（`base/scrim/sticky/overlay/modal/toast`）。**必须先修 `index.css:911` 的 `:has()` 补丁**——那是层级失控的症状，修好根因才能删掉它。
10. **分割线统一为单一来源**：现状是双轨制——左栏 `border-ink/[0.055]`（`LeftRail.jsx:116`）vs 右栏 `border-ink/10`（`RightWorkbench.jsx:156`），同屏两条缝强度差 1.8 倍，这就是"一边糊一边清"的直接原因。新增 `--border-subtle / --border-default / --border-strong` 三级令牌。
11. **清理失效令牌**：`--color-ink-fade` 与 `--color-ink-ghost` 在浅色主题下**同值 `#6B7280`**（`index.css:13-14`），语义已失效——`ink-fade/30` 叠出来只有 21% 不透明度。必须合并或重新拉开明度。
12. **间距归基线**：消灭 `0.45rem / 0.55rem / 0.35rem / 0.28rem / 0.12rem` 等非 4/8 倍数（`index.css` 内 9+8+9+6+10+6+5 处），以及 `LeftRail.css:40` 的离群 `gap: 18px`。
13. **字号归位**：`text-[9px]` / `text-[10px]` 107 处 → 统一到 `text-meta`(12px)，差异化用**字重/透明度/字距**而非缩小字号。
14. **消除卡片套卡片**：`ChoicePicker.jsx:47` 内层 `shadow-sm` + 外层容器 `shadow-sm` 投影叠加。

### P3 — 加载真字体与确立气质（约 1.5 天，**最提升"高级感"**）

15. **字体方案决策**（需你拍板，见第五节）：
    - 方案 A「自托管」：woff2 子集化入 `public/fonts/`，`font-display: swap`。**无外网依赖、可离线**（Gugo 是 self-hosted，离线能力是刚需）
    - 方案 B「Google Fonts CDN」：一行 `<link>`，但国内访问不稳 + 与 self-first 理念冲突
    - 方案 C「放弃衬线标题」：删掉 `font-display`，承认当前是现代无衬线工具风，把精力投在间距与层级上
16. **中英混排校对**：中文界面里 `letter-spacing: 0.004em` 全局生效（`index.css:313`）对汉字是**破坏性**的（汉字不应加字距），需改为仅对拉丁生效。
17. **`::selection` 选中文本样式**已存在（`:440`）但可深化——长文本选中时的视觉反馈是细节质感的重要来源。

### P4 — 空状态与完整性（约 2 天）

18. **建 `<EmptyState>` + 骨架屏**：227 个组件里 `empty` 关键词 1 处、`skel` 7 处。所有列表页（会话、Provider、Skill、MCP、任务、Agent、Artifact）统一空态设计。**"什么都没有"是最容易被记住也最容易被记住为差的界面状态。**
19. **修 `ArtifactPreview.jsx:36`** 的 `max-h-[420px] overflow-hidden`——**静默截断内容**，这是功能 bug 不是审美问题。
20. **加载态统一**：全局仅 4 处 `duration-200`，说明动效体系几乎没建。

---

## 四、优先级与风险矩阵

| 阶段 | 内容 | 工量 | 视觉收益 | 回归风险 |
|---|---|---|---|---|
| **P0** | 4 个原子组件 + 令牌扩展 | 1 天 | ★★★★★ | **极低**（纯新增） |
| **P1** | 按下态 + 动效 + 焦点环 + 对比度 | 2 天 | ★★★★★ | **低**（纯 CSS 类） |
| **P2** | z-index + 分割线 + 间距 + 字号 | 3 天 | ★★★★☆ | **中**（触碰布局） |
| **P3** | 字体加载 + 中英混排 | 1.5 天 | ★★★★☆ | **中**（字宽变化影响换行） |
| **P4** | 空状态 + 骨架屏 + 完整态 | 2 天 | ★★★☆☆ | 低 |

**总计约 9.5 人日**，可按 P0→P1 先行（3 天拿到最大感知改善）。

> **强烈建议**：P1 第 4 条（`active:scale`）单独先做，**一行 CSS 让 547 个按钮同时获得手感**。如果你只想改一处，就改这个。

---

## 五、需要你决策的 3 件事

| # | 决策点 | 选项 | 我的建议 |
|---|---|---|---|
| **1** | 字体路线 | A 自托管 / B CDN / C 弃用衬线 | **A**。Gugo 是 self-hosted，离线是产品底线；但需接受一次字体文件体积评估 |
| **2** | 迁移策略 | 渐进式（推荐）/ 一次性大重构 | **渐进式**。227 文件一次性替换的回归面不可控 |
| **3** | 改造范围 | 仅令牌与原子组件 / 连带重构三栏布局 | **先不动布局**。`flex-[1_1_640px]` + `clamp()` + inline-px 三套机制混用确实有隐患（1440px 视口下聊天区被压到 392px，触发 container query 880px 阈值静默隐藏时间轴），但这是**独立议题**，应单独排期，不混进视觉优化 |

---

## 六、验收标准（Definition of Done）

每个阶段完成后须满足：

- [ ] 按钮高度 ≤ 3 种（sm/md/lg）
- [ ] 全项目 `active:` 命中率 ≥ 95%（547 按钮中已覆盖）
- [ ] 焦点样式收敛为 1 套（`focus-visible:ring`）
- [ ] z-index ≤ 5 种，`index.css` 中 `:has()` z-index 补丁已删除
- [ ] 浅色主题所有正文色对比度 ≥ 4.5:1（脚本化校验，纳入 CI）
- [ ] 非 4/8 基线间距数 = 0
- [ ] `text-[9px]` / `text-[10px]` 计数 = 0
- [ ] 所有列表页具备空状态
- [ ] `src/index.css` 中 `font-family` 声明的字体确实被加载
- [ ] Playwright 截图回归：light / dark / white 三主题 × 主要 5 页面

---

## 附：本次审查的方法与局限

**已验证**：所有数字均来自 `grep`/文件读取的实测结果，对比度经 WCAG 2.2 相对亮度公式计算，非估算。

**局限**：
- 未做真机截图对比——P3 字体方案的具体观感建议你在定稿前跑一次实机
- `index.css` 2,772 行中 `@layer components` 部分尚未逐条审完，P2 阶段需补充
- 移动端（`public/mobile.html`）为独立实现，未纳入本次范围

**本次未修改任何文件。**
