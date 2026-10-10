# Gugo UI 详细改动计划（执行版）

> 配套：`UI_VISUAL_POLISH_PLAN.md`（诊断）· `preview/after-style-preview.html`（改后样式）
> 基线：v0.11.72 / `main` / `0c2d569` / 2026-10-10
> **本文件为计划，尚未改动任何源码。**

---

## 零、先读这一节：4 个会拦住你的测试棘轮

我在制定计划时读了 `tests/`，发现项目里有**主动阻止粗暴重构的棘轮测试**。
这不是障碍，是保护——但必须知道，否则会浪费一整轮 CI。

| 测试文件:行 | 约束 | 影响 |
|---|---|---|
| `tests/chatSurfaceLayout.test.js:41` | 断言 `chat-composer-action-button inline-flex h-8 w-8` **精确出现 2 次** | **`ComposerActions.jsx` 永久豁免**，换成 `<Button>` 必挂 |
| `tests/chatSurfaceLayout.test.js:40` | `assert.doesNotMatch(actions, /hover:bg-ink-ghost/)` | codemod 自动加 hover 前缀会直接撞测试 |
| `tests/codeDebt.test.js:15` | `TINY_TEXT_CEILING = 132`，断言用 `<=` **不是 `===`** | tiny text 递减**永远安全**，不需改常量（当前实测 114） |
| `tests/i18nHardcoded.test.js:9` | BASELINE 是**逐文件精确值**，新文件必须为 0 | `src/components/ui/*` 内禁止任何中英硬编码 |
| `tests/uiComponentLayer.test.js:11` | `.btn-primary/.btn-ghost/.input/.card/.modal-base` 必须存在 | **不能删旧 class**，新组件只能"消费"它们 |

**执行顺序铁律**：`npm run i18n:check && npm run i18n:keys` 放在**每批之前**跑，不是之后。

---

## 一、阶段 0：地基（1 天，零回归）

### 1.1 扩展 tailwind 语义层

**文件**：`tailwind.config.js`（唯一改动文件，单独提 commit）

在 `theme.extend` 中新增：

| 类别 | 新增 token | 值 | 替代目标 |
|---|---|---|---|
| height | `control-sm/md/lg` | 32/36/40px | 现有 7 种按钮高度 |
| fontSize | `micro` | 12px | 收编 `text-[9px]`/`[10px]` |
| boxShadow | `card/raised/menu/overlay` | 4 级语义 | 现有 6 种阴影配方 |
| transitionDuration | `fast/base/slow` | 120/180/240ms | 4 处散落的 `duration-200` |
| borderColor | `subtle/default/strong` | 3 级 | 分割线双轨制 |

> **注意**：`zIndex` **不要动**。`tests/uiComponentLayer.test.js:21-23` 硬断言 `overlay:'40'` / `modal:'50'` / `toast:'60'`。
> 层级收编（第 3 阶段）只改 CSS 里的裸值，**保留 tailwind 里的这三档不动**。

### 1.2 index.css 增补（**单独 commit，不与组件混在一起**）

**文件**：`src/index.css`，改 `@layer components`（325-359 行）与 `:root`（110-119 行）

新增：
```css
:root {
  --dur-fast: 120ms;  --dur-base: 180ms;  --dur-slow: 240ms;
  --ease-ui: cubic-bezier(0.2, 0, 0.2, 1);
  --border-subtle: rgb(var(--color-ink-rgb) / 0.075);
  --border-default: rgb(var(--color-ink-rgb) / 0.13);
  --border-strong: rgb(var(--color-ink-rgb) / 0.22);
}
```

**核心改动 — 给两个按钮类加按下态（最高 ROI）**：
```css
.btn-primary, .btn-ghost {
  @apply ... transition-[background-color,border-color,color,transform,box-shadow]
         duration-[180ms] ease-[cubic-bezier(0.2,0,0.2,1)] active:scale-[0.975];
}
```

> **这一处改动让 547 个按钮同时获得手感，是整个计划投入产出比最高的一行。**
> 只动 `transform`（GPU 加速），符合 `prefers-reduced-motion` 现有约定。

**验证**：`node --test tests/uiComponentLayer.test.js tests/uiNoPlaceholders.test.js`

---

## 二、阶段 1：原子组件（1.5 天，纯新增）

新建目录 `src/components/ui/`，5 个文件 + `index.js`。

### 2.1 `<Button>`

| prop | 取值 | 默认 |
|---|---|---|
| `variant` | `primary / secondary / ghost / danger / ink` | `secondary` |
| `size` | `sm(32) / md(36) / lg(40)` | `md`（与现 `.btn-primary` h-9 一致，零视觉变更） |
| `loading` | bool | false（自动 `aria-busy` + spinner） |
| `icon` / `iconRight` | node | —（按 size 自动约束 svg 尺寸） |
| `block` | bool | false |
| `type` | string | **`'button'`**（修 PermSwitch 缺 `type` 的 bug） |

关键：`className` 走**追加不覆盖**；`...rest` 必须透传（`data-testid` / `data-tool-id` 是测试唯一定位手段）。

### 2.2 `<Toggle>` — 统一 44×24（md）/ 36×20（sm）

替换 5 处实现，**顺带修 2 个 bug**：
- `PermSwitch` 缺 `type="button"` → form 内点击会误提交
- `aria-pressed` → `role="switch"` + `aria-checked`（语义正确）

保留旧名为一行转发，避免 6 处调用点同批改动：
```js
export { default as Toggle } from '../../ui/Toggle.jsx'
```
删除 `src/components/integrations/IntegrationToggle.jsx`（3 处调用改 import）。

> ⚠️ `PermSwitch` 的 framer-motion `layout` 弹簧（stiffness 500）换 CSS transition 后动画曲线会变，**需人工对比确认**。

### 2.3 `<Field>` — 用 `cloneElement` 注入

替换 `src/components/modelProviders/ProviderEditor.jsx:13` 的
`[&_input]: [&_select]: [&_textarea]:` 任意变体万能绕过（**该表整表无焦点环**）。

新增 `hint` prop —— 当前 12 个文件里的灰色小字全是裸 `<p className="text-xs text-ink-fade">`。

### 2.4 `<Card>` — padding 4 变体 + shadow 4 级

### 2.5 `<EmptyState>` — 当前项目完全缺失

新增 `src/i18n/domains/emptyState.js`（**必须，否则 i18nHardcoded 零容忍基线直接失败**）。

**验证**：`node --test tests/uiComponentLayer.test.js && npm run i18n:check && npm run i18n:keys`

---

## 三、阶段 2：迁移（8 批，约 5 天）

### 批次表

| # | 主题 | 文件数 | 风险 | 关键验证 |
|---|---|---|---|---|
| 1 | **Toggle 归一** | 11 | 高 | `tests/unit/SettingsToolsPanel.test.jsx`（按 `data-tool-id`/`aria-label` 定位，**不校验 class，安全**） |
| 2 | **Provider 表单**（Field） | 9 | 中 | `tests/unit/*Provider*` + `npm run i18n:keys` |
| 3 | Settings 主面板 | 6 | 低 | `npm run i18n:check` |
| 4 | Settings 进化/恢复 | 11 | 低 | `tests/evolution*` |
| 5 | 接入/权限 | 11 | 中 | `tests/unit/Access*.test.jsx`(4) + `accessConnectionSafety` |
| 6 | **EmptyState 落地** | 13 | 中 | **新写** `tests/unit/EmptyState.test.jsx` |
| 7 | LeftRail / Account | 6 | 高 | `tests/unit/ChatMessageDeepLink.test.jsx`、`chatSurfaceLayout.test.js:148` |
| 8 | ChatSplit 三批 | 54 | **最高** | 见下方专项 |

**ChatComposerActions.jsx（批 8 内）→ 永久豁免**，保留裸 `<button>` + 语义 class。
`MessageRow` / `uiVisual.test.js` 源码正则锁定的文件，放在最后做（基建稳定后返工成本最低）。

### 每批固定流程
```bash
npm run lint && npm run i18n:check && npm run i18n:keys \
  && npm run debt:check && npm test -- <该批相关测试>
```

### codemod 策略

**工具**：自写 Node 脚本（`acorn` 已在依赖里，无需新增）。不上 jscodeshift——99% 替换发生在 `className` 字符串字面量里，AST 收益低于成本。**仅在需改 JSX 结构（`<button>` → `<Button>`）时用 jscodeshift。**

| 规则 | 工具 | 备注 |
|---|---|---|
| R1 `text-[9px]/[10px]/[11px]` → `text-meta` | sed，全局 | **可立即单独跑**，是 a11y 提升。当前 114 → 上限 132 |
| R2 `rounded-md` → `rounded-control` | sed，**限批 2-7** | ⚠️ **不能全局跑**，见下 |
| R3 button 补 `active:` | sed，批 3-7 | ⚠️ hover 色形态多样，需按色系映射表 |
| R4 `<button>` + btn-* → `<Button variant=>` | jscodeshift | 保留 `data-testid`/`ref`/`onClick` |
| R5 `[&_input:]` 任意变体 → Field | **人工** | 需重排 label/control 语义 |

**4 类不能 codemod，必须人工**：
1. **`h-8` → `size="sm"`**：全仓 `h-8` 有 141 处，但多数是头像容器、badge、图标底座。只有 JSX 标签是 `button` 时才可换，且仍需人看上下文。
2. **`rounded-md` → `rounded-control`**：6px→10px 差 4px，在 `py-0.5` 的 badge（高约 16px）上会把圆角撑成胶囊，在 `SessionList` 行内按钮会改变视觉密度。sed 做不到"控件 vs 非控件"语义判断。
3. **Toggle 5 处归一**：props 名不统一（`enabled/onClick` vs `on/onToggle`），且 `SettingsToolsPanel` 是 `.map()` 内联 button，`PermSwitch` 是 framer-motion。
4. **`active:` 前缀**：`chatSurfaceLayout.test.js:40` 明确断言 ComposerActions **不得**出现 `hover:bg-ink-ghost`，自动加前缀会撞测试。

---

## 四、阶段 3：视觉秩序（3 天）

| # | 改动 | 文件:行 | 验证 |
|---|---|---|---|
| 1 | **z-index 收编至 5 级** | `index.css` 裸值 `z-index:2/4/5/20`（`:455,:885,:896,:911`） | **先修 `:has()` 补丁根因**（`:907-912`），再删补丁 |
| 2 | **分割线三级令牌** | 左 `LeftRail.jsx:116` `border-ink/[0.055]` → `--border-subtle`；右 `RightWorkbench.jsx:156` `border-ink/10` → 同源 | 视觉回归截图 |
| 3 | **合并失效 token** | `index.css:13-14` `--color-ink-fade` 与 `--color-ink-ghost` 浅色下**同值 #6B7280** | 对比度脚本 |
| 4 | **修 3 个真 Bug** | ①`text-accent` 119 处 → `text-accent-ink`（3.10:1→6.71:1）②字体 0 加载 ③`ChatComposer.jsx:164` `bg-accent-soft/80` 双 alpha（全项目 10 处） | WCAG 脚本入 CI |
| 5 | 间距归基线 | `index.css` 内 `0.45/0.55/0.35/0.28/0.12rem` 50+ 处；`LeftRail.css:40` 离群 `gap:18px` | 视觉回归 |
| 6 | 消除卡片套卡片 | `ChoicePicker.jsx:47` 内层 `shadow-sm` + 外层容器 `shadow-sm` | 视觉回归 |
| 7 | **修功能 bug** | `ArtifactPreview.jsx:36` `max-h-[420px] overflow-hidden` **静默截断内容** | `tests/artifactPreview.test.js` |

> 第 4 项的字体方案待你拍板（自托管 woff2 / CDN / 弃用衬线），详见诊断文档第五节。

---

## 五、阶段 4：完整性（2 天）

- `EmptyState` 落地 13 处（SessionList / ProviderList / SkillsMarket / CurrentFileChange…）
- 骨架屏：全局仅 7 处 `skel`，动效体系几乎没建
- 所有列表页 loading / error / empty 三态齐全

---

## 六、验收标准

- [ ] 按钮高度 ≤ 3 种；`active:` 覆盖率 ≥ 95%
- [ ] 焦点样式收敛为 1 套（`focus-visible:ring`）
- [ ] z-index ≤ 5 种，`:has()` z-index 补丁已删除
- [ ] 浅色主题所有正文对比度 ≥ 4.5:1（脚本入 CI）
- [ ] 非 4/8 基线间距 = 0；`text-[9px]/[10px]` = 0
- [ ] 所有列表页具备空状态
- [ ] `index.css` 声明的字体确实被加载
- [ ] 全部棘轮测试绿：`uiComponentLayer` / `chatSurfaceLayout` / `codeDebt` / `i18nHardcoded` / `uiVisual`
- [ ] Playwright 截图回归：light/dark/white × 主要 5 页面

---

## 七、Top 8 风险

| # | 文件 | 危险点 | 验证 |
|---|---|---|---|
| 1 | `chatComposer/ComposerActions.jsx` | `chatSurfaceLayout.test.js:41` 断言精确字符串 | **永久豁免**，不迁移 |
| 2 | `chatMessages/**` + `ChatMessages.jsx` | `uiVisual.test.js` 读源码做正则断言 | 放最后做 |
| 3 | `ProviderEditor.jsx:13` | 换 `<Field>` 会**新增**焦点环（可见变化）；`cloneElement` 注入 `id` 可能与现有 label 隐式关联冲突 | 人工 Tab 走查每个字段 |
| 4 | `SettingsToolsPanel.jsx:57` | 41 个 toggle 在 `.map()` 内，`data-tool-id`+`aria-label` 是测试唯一定位；`aria-pressed`→`role="switch"` 会改选择器 | Toggle 必须 `...rest` 透传 |
| 5 | `PermissionSectionPrimitives.jsx:8` | framer-motion 弹簧换 CSS 曲线不同；且缺 `type="button"` 修复本身是行为变更 | 人工对比开启动画 |
| 6 | `tests/codeDebt.test.js:15` | R1 批量改 tiny text 会让计数骤降（用 `<=` 所以安全，但不改常量就失去棘轮意义） | 跑完写回新实测值并注释原因 |
| 7 | `src/components/ui/*` 新文件 | `i18nHardcoded` 按"新文件必须为 0"直接失败 | `i18n:check` 放每批**之前** |
| 8 | `src/index.css:325-358` | 手误删改既有 `.btn-primary/.btn-ghost/.input/.card/.modal-base` 会同时挂 `uiComponentLayer` 与 `.modal-*` z 断言 | index.css 改动**单独 commit** |

---

## 八、建议的执行顺序（含"先尝甜头"策略）

```
① 单独 PR：tiny text 归位（R1）           ← 纯 sed，零风险，立即可跑
② 单独 PR：index.css 令牌 + active 按下态  ← 547 按钮同时"活过来"
③ 阶段 0：tailwind 语义层
④ 阶段 1：5 个原子组件
⑤ 批次 1（Toggle）→ 2（Field）→ 3/4/5 → 6（EmptyState）
⑥ 阶段 3：视觉秩序
⑦ 批次 7/8：LeftRail / ChatSplit（风险最高，最后做）
```

①② 两步合计约半天，**能拿到最大比例的感知改善**。建议先做这两步给你看效果，再决定是否推进后续 12 个批次。
