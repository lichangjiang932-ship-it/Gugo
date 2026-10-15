# 右侧工作台阅读细节调整

日期：2026-10-14。用户提供三张截图，并明确“右侧工作台样式没什么问题，主要优化细节”。本轮保留现有主布局、配色、面板宽度策略和操作能力，不重做工作台，不替换编辑器，也不修改所展示文件的内容。

## 1. 指定控件精简

图一对应 `DiffToolbar.jsx`：移除常驻“改动／文件／全部改动”及比较下拉箭头，这组控件只保留 ≡ 文件列表入口。原有更多、展开和关闭等图标保持。

查看内容和比较范围移入 ≡ 展开的文件面板，通过新 `DiffReadingControls.jsx` 提供。保留工作区、全部改动、分支和会话对比能力，不以删除后台功能来简化外观。

抽屉可 Esc 关闭并恢复入口焦点；中文组合输入的 Escape 不误关闭。相关内容/分支切换有真实组件回归，不只判断源码字符串。

## 2. 文件名与路径

新增小型 `FileNameLabel.jsx`，只让文件名主干截断，扩展名独立保留。支持 `.test.js`、`.spec.tsx`、`.d.ts` 等复合后缀；完整文件名仍用于可访问名称和 tooltip，不改变传给打开/复制操作的真实值。

应用到预览标签、文件操作菜单、路径末段、工作台文件行与文件抽屉。使用正常字形，不把标签做成斜体。路径父目录让出空间，当前文件更容易识别。

文件操作 chip 现在显示完整文件名（含后缀）；旧的无后缀断言更新为新契约。打开文件、显示所在文件夹、复制路径的能力检测和鉴权没有改动。

## 3. Markdown 阅读

`previewReading.css` 仅作用于文件阅读容器，不改变聊天消息或 HTML/Office/PPT 等作品内容。

- 正文默认 14 CSS px，行高 24.5px；主标题约 23.1px、600 字重。
- 调整标题、段落和引用留白；减轻行内代码灰底和字重。
- 引用不额外生成引号，不为文字插入展示用字符。
- 表格底色、边框更轻；窄面板在表格自己的容器内横向滚动，不把所有列压窄。
- 适度限制宽屏阅读行长，窄屏维持原有滚动布局；字号使用相对单位，继续尊重应用字号设置。

这些是阅读器样式，不重排或重写 Markdown 文件本身。实际字体与用户截图还会受系统 DPI/应用字号影响，截图像素不当作 CSS 字号。

## 4. 源码与改动

`SourceView` 默认保留逻辑行，长行横向滚动；13 CSS px，行高约 21.45px，正常等宽字形。保留所有原始空白、CRLF 和字符串，源码仍按文本转义，不解释其中 HTML。

Diff 的默认自动换行关闭，既有“更多 → 自动换行”可重新开启。工作台当前文件阅读也不再强制自动换行，保留其既有字色与差异标识。未新增手动编辑、保存、额外写入权限或重型代码编辑依赖。

## 5. 涉及文件

- `src/components/FileNameLabel.jsx`
- `src/pages/ChatSplit/rightWorkbench/diffReview/{DiffToolbar,DiffReviewPanel,DiffReadingControls,FileListOverlay}.jsx`
- `src/pages/ChatSplit/rightWorkbench/WorkbenchFiles.jsx`
- `src/pages/ChatSplit/preview/{ArtifactRenderers,DirectFilePreview,PreviewChrome,FileIdentity,FileActions}.jsx`
- `src/pages/ChatSplit/preview/previewReading.css`
- `src/i18n/domains/diffReview.js`
- 对应组件测试和既有文件名显示期望

不包含服务端、模型行为、安全闸门、数据库 schema 或真实用户数据改动。工作树原有大量修改保持，未 reset、commit、push 或打包发版。

## 6. 验证

### 定向

- 修改前基线：6 文件、42 项通过。
- 新增 5 项界面行为用例先失败，再逐项修复；覆盖工具栏简化、抽屉选项/IME/焦点、扩展名、长路径、源码原文和 Markdown 作用域。
- 最终相关定向：9 文件、78 项通过。
- 补充阅读/链接/主题等回归：5 文件、21 项通过。
- 确定性离线评测：71 项通过，未调用真实 Provider。
- lint、类型、debt、i18n、字典键、复杂度及隔离生产构建有通过记录。
- 从头完整全量：1158 个测试文件 PASS，退出码 0，完整运行 1271.067 秒；不是失败批次拼接。

原有“工具栏必须有 breadcrumb”的交互夹具改为抽屉内原生 select；仍逐项切换所有比较目标，未删除断言或扩大门槛。3 个旧文件名期望改为包含扩展名，其他文件操作/权限断言保持。

### 浏览器

独立临时数据库和 Edge profile，只挂载实际项目 React 组件、主题和样式，使用合成 Markdown、源码与只读接口响应。没有调用真实模型、读取真实配置或写入用户文件。

通过白/暗主题 × 860/360px × Markdown/源码的 8 组检查：

- 常驻文字切换器不存在，≡ 展开后仍能访问设置。
- Esc 关闭文件抽屉并返回入口焦点。
- 文件后缀均可见、字形为 normal，完整可访问名称保留。
- 源码 white-space 为 pre，长行 scrollWidth 大于视口，原文字节字符串一致。
- 360px 下宽表格约 544px，在自己的 320px 容器内横向滚动。
- Markdown 正文和源码的计算字号/行高分别为 14/24.5px 和 13/21.45px。

截图与测量：`docs/review-evidence/2026-10-14-workbench/`。

浏览器脚本曾因自身模板转义、依赖模块 default 导出及选择器引号错误失败，均按具体错误修正；不把这些脚本错误归因成生产功能缺陷。

测试最初直接比较 DOM 对象与 null，失败诊断展开 React/DOM 图造成 OOM；改为等价的布尔存在性断言后，得到正常可定位的预期失败。没有提高内存门槛或删测试。

## 7. 复验

```bash
node scripts/run-tests.js tests/unit/WorkbenchDetails.test.jsx tests/unit/DiffReviewPanelMount.test.jsx tests/unit/PreviewChipToolbar.test.jsx tests/unit/FileWorkbenchActions.test.jsx tests/unit/DirectFilePreview.test.jsx
npm run lint
npm run typecheck
npm run debt:check
npm run i18n:keys
npm run build
```

临时验收目录：`C:/Users/21161/AppData/Local/Temp/gugo-pane-details-tcvYrH`。自有 Web 服务、假模型和调试浏览器均已关闭。生产构建输出也在该目录，没有覆盖用户现有 dist 或安装包。
