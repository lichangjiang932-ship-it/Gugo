# 真实实例文件链接回归修复（2026-10-17）

用户报告：在原有项目的真实模型输出中，文件路径仍然没有超链接。按用户要求改用原有 `http://localhost:5175/#/chat` 实例和已配置模型 `mimo-v2.6-flash` 直接复现与验收；不使用隔离 Web 环境。保留主布局、四入口、原模型配置与聊天记录；未提交、推送、打包或发版。

## 复现与根因

在用户已有会话「帮我生成一份关于今天刚刚发布的gpt6astra的简单介绍」中，助手首条完成消息写着 `保存在 docs/GPT-6-Astra-Introduction.md`，页面只渲染为普通行内代码，没有链接；该消息实际带有可信的 `verifiedLocalFiles` 收据和本地文件路径。

根因不是缺少候选选择或收据，而是渲染判定不一致：

- `artifactHasInlineReference` 把正文中出现的裸文件名视为“已经内联引用”，因此隐藏了消息下方的交付链接卡片。
- 实际 Markdown 渲染只处理裸文件名、Windows 绝对路径和已注册的 artifact URL；行内代码中的 **仓库相对路径**（`docs/...`）既不是绝对路径，也不等于裸文件名，所以收据存在却不会被链接。
- 模型显式写的 `[docs/...](docs/...)` 相对链接也只是普通 `<a href="docs/...">`，不会打开工作台中的真实文件。

## 修复

- 新增相对路径解析：只把与**本轮已验证收据的绝对路径**后缀匹配的仓库相对路径解析为文件；`..`、跨多份同名后缀、未验证路径一律不链接。
- 行内代码、普通文本和显式相对 Markdown 链接统一使用该解析。显式链接仅在可见文本与 href 是同一相对路径时才重写，避免“文字是 A、打开却是 B”。
- 保留既有受保护 URL、未验证绝对路径和同名文件歧义策略；不新增文件入口，不读取正文以外的用户数据。
- 关闭工作台预览后聊天仍保持 `inert` 的相邻缺陷一并修复：预览覆盖层与工作台模态焦点陷阱重复管理同一 `inert`，两个恢复顺序互相覆盖。现在覆盖层内的预览只由模态焦点陷阱负责背景隔离；独立预览仍保留自身行为（由既有布局测试覆盖）。

### 第二处真实根因：模型写了被本地文件取代的快照 URL

用户再次反馈“还是没有超链接”后，检查其真实 HTML 会话发现：模型把可见文案写成了指向 `/api/artifacts/...html` 的 Markdown 链接，而该 managed 快照在本轮已被同名 `verifiedLocalFiles` 收据取代，交付选择解析后不再包含这个快照。结果受保护 URL 被有意渲染成不可点击的 `blocked-artifact-link`，消息底部虽然有一张可用文件卡片，但用户看到的“打开《...》”文字不是链接。

修复：

- 本地文件收据自身携带的 `relatedArtifactIds` 会进入可点击引用（此前只从工具调用突变推断）。
- 只有当引用带有明确持久关联，且 URL 的 artifact 文件名与引用别名一致时，`/api/artifacts/...` 链接才解析为该本地文件；没有关联的受保护 URL 仍然阻止点击。
- 内联链接解析后，底部重复卡片按既有规则隐藏；可见文案保持模型原文。

## 验证

**真实 5175 实例（经用户明确要求）**

- 打开用户原有「GPT-6 Astra」会话：首条完成消息中的 `docs/GPT-6-Astra-Introduction.md` 变为可点击链接（`/api/local-files/verified/...`），点击后工作台读取并显示文件真实内容；原聊天记录和文件未修改。
- 使用已配置模型 `mimo-v2.6-flash` 新建一个真实小任务：创建 `docs/link-check-2026-10-17.md`，内容“链接测试通过。”。本轮 3 个工具、30.8 秒，回复生成后路径显示为可点击链接；点击打开工作台并显示真实文件内容。
- 该测试文件在验收后已删除，目录保持干净；测试会话保留在用户历史中供其自行删除。
- 关闭预览后再次检查：工作台对话框关闭、聊天 `inert` 移除、输入框可聚焦。修复前同一流程可稳定复现聊天被 `inert` 锁死。
- 第二次反馈后复查用户真实 HTML 会话（`e339c6a8...`）：原文“打开《Claude Opus 5.5｜模型信息与核验指南》”已从 `blocked-artifact-link` 变为可点击内联链接（computed `text-decoration-line: underline`），底部重复卡片隐藏；点击进入工作台并请求真实 HTML 字节（HTTP 200）。截图见 [html-inline-link-real-5175.jpg](html-inline-link-real-5175.jpg)。
- 真实模型请求：1 个聊天回合；未读取或输出真实密钥/数据库会话内容。截图见 [link-check-real-5175.jpg](link-check-real-5175.jpg)。

**定向测试（OS-only 白名单、临时 HOME/DB、NODE_ENV=test、GUGO_LOAD_DOTENV=0）**

- `tests/artifactReferenceLinks.test.jsx` 47/47 通过；新增行内代码相对路径、显式相对链接与同名相对后缀歧义用例。
- `tests/unit/PreviewPaneLayout.test.jsx` 8/8 通过；新增“工作台覆盖层内关闭聚焦预览后聊天不再 inert”。
- 合并 `artifactReferenceLinks`、`PreviewPaneLayout`、`RightPaneOverlay`、`MarkdownSourceLinks`、`MarkdownRendererTheme`、`chatIoExperience` 共 6 文件/88 项通过，exit0，日志根 `gugo-link-overlay-neighbors-TbWH04`。
- 相关文件的 ESLint `--max-warnings 0` 通过。

## 未验证 / 边界

- 其他历史会话中较早消息的路径没有可用的本轮收据，本轮不跨回合推断文件，避免把任意相对路径链接到未验证文件。
- 真实 Provider 分页、Provider 切换并发、Electron 安装包、OS 沙箱、长期性能未验证。
- 本轮不再执行隔离 Web 冻结全量；用户明确要求直接在原有实例测试。先前被中止的冻结运行记录标注为 interrupted，不当作 PASS。
