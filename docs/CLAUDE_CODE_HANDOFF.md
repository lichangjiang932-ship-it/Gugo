# Claude Code 桌面版交接计划

这是一份交接状态和接续工作流程，不是自动开始下一轮开发或打包的授权。

## 1. 打开正确的本地项目

打开文件夹：

```text
D:\destok\your-model-atelier(1)\Gugo-task-verification-hardening
```

PowerShell：

```powershell
Set-Location -LiteralPath 'D:\destok\your-model-atelier(1)\Gugo-task-verification-hardening'
git status --short --branch
git log -3 --oneline
```

不要在 `D:/usr/local`、参考仓库 `D:/open-claude-ui` 或其他 Gugo clone 上修改。不要删除重复 clone。

### 本次 Git 状态

- 前序可靠性/验收治理已提交并曾推送：`71b01e4e3545efe077a37d74fae9684de35bcf6e`。
- 本次 UI 与模型配置的完整实现快照已本地提交：**`39b20c31e868bd3adf272fb12a70172448b3304e`**，`feat: refine desktop UI and model configuration flows`。
- 实现提交包括此前尚未提交的 UI 三批和模型修复，293 文件；不是只提交最后几个模型文件。保持已整体验收的依赖闭包，没有硬拆成未经单独验证的中间提交。
- 本交接文档和根 `CLAUDE.md` 的指引作为后续独立 docs 提交；查看 `git log` 获取其实际提交号。
- **本次没有 push、PR、merge、发布或打包。** 不假定本机 `origin/main` 就是远端最新状态；本轮没有为了交接访问远端。
- 若 Claude Code 桌面版自动创建分支/工作树，应从包含上述本地实现提交的分支起步。不要直接以尚未同步本轮改动的远端 clone 作为起点，否则看不到新功能。
- 旧报告/verification.json 中的“未提交”字段记录验收当时状态，不要批量重写历史。当前提交状态以本节和 Git 实际记录为准。

## 2. 开工阅读顺序

1. 完整阅读根 `AGENTS.md`；这是安全、协作、架构和测试约定的权威。
2. 阅读本交接页，随后看 `docs/CURRENT_STATE.md`、`.agent/memory/project.md`。
3. 按任务选读：
   - `docs/MODEL_CONFIGURATION_AND_CONTEXT_2026-10-16.md`
   - `docs/UI_REFINEMENT.md`
   - `docs/UI_STYLE_TOKENS.md`
   - `docs/THIRD_PARTY_UI_REFERENCES.md`
   - 涉及引擎/验收时再看 `docs/TASK_ACCEPTANCE.md`、`docs/KERNEL_BOUNDARY.md`、`docs/DEBT.md`。
4. 新问题先定位真实调用链，再读取必要片段；不要凭文件名或旧报告猜实现。

## 3. 已完成与代码入口

### A. 宿主 UI 基础（第一批）

- 字号等值 rem/token 迁移，root 缩放一次；密度变量有设置、共用按钮和侧栏消费者，但不是全站统一完成。
- 流式阅读尊重向上滚动意图，冷却结束不自动抢回；显式跳转恢复吸底。
- Portal 处理 DOM 包含、焦点、IME、CSS 变量和 viewport；统一 Segmented、加载态和宿主动效适配。
- 入口：`src/components/ui/`、`src/lib/scrollPinning.js`、`src/lib/hostMotion.js`、`src/lib/motionPreference.js`、`src/styles/appearance.css`。

### B. 审批回执（第二批）

- pending/submitting/resolved/error/unknown 来自实际宿主决定回执，不用定时器模拟成功。
- 严格核对 approval ID 与附带的归属；切后端/owner/session 时隐藏旧提示。决定成功不等于工具执行成功，结果未知不自动重放。
- 入口：`src/lib/approvalDecisionPresentation.js`、`src/components/ApprovalDecisionNotice.jsx`、`src/pages/ChatSplit/useApprovalDecisionNotice.js`、`useChatApprovals.js`。

### C. Changes 内部与历史（第三批）

- 删除 Changes 内部重复“改动／文件”模式；≡ 直接搜索/选择变更文件，选文件直接看 Diff，高级比较在 ⋯。
- 原始路径是文件身份；同名不同目录不能 basename 拼接。完整文件阅读留在原有文件工作区。
- 首次打开本次改动带入 session 比较目标，不误扫整个工作区。订阅有卸载清理。
- 左下菜单移除历史；设置复用嵌入 HistoryView，原 `/history` 链接、数据和操作保留。
- 外层焦点陷阱的 Tab 保持 capture；Escape 在 bubble 尊重内部处理、IME 和嵌套层，内菜单 Escape 不误关面板。
- 入口：`rightWorkbench/diffReview/`、`dock/dockStore.js`、`dock/DockHost.jsx`、`useChatOverlays.js`、`src/pages/HistoryView.jsx`、`src/lib/useModalFocusTrap.js`。

### D. 最近四项模型/上下文修复

| 行为 | 入口与关键约束 |
|---|---|
| 获取后全选、全不选、单项选择 | `src/components/modelConfig/ModelSelectionList.jsx`、`modelSelection.js`、`AddProviderPanel.jsx`、`ProviderModelDirectory.jsx`；`enabled: false` 取消选用而非删除候选，保留窗口元数据 |
| 保存后聊天立即可见 | `src/lib/llmConfigClient.js` 成功变更通知 `model-providers:changed`；`useChatRuntimeCatalog.js` 重读；失败不发成功事件 |
| 配置真正可解析使用 | `server/adapters/modelProviderConfig.js`、`modelRuntimeCatalog.js`、`server/llm/llmProviderService.js`；写入/读取共享默认 home，禁用模型不进运行时允许目录，默认项保留 Provider 身份，部分更新保留协议 |
| 模型菜单“添加模型” | `modelPicker/ModelPickerPanel.jsx`，按钮在 listbox 外；复用 `ChatSplit/index.jsx` 的设置导航；不要重新加入本机登录门槛，路由 RequireAuth 和后端认证仍保留 |
| 圆圈随上下文变化 | `server/llm/modelRuntimeProfiles.js`、`server/utils/modelCatalog.js` 让窗口信息传到画像、状态和实际窗口；前端继续由 `contextMeter.js`、`useChatContextUsage.js`、`ComposerActions.jsx` 共用当前待发送估算 |
| 测试隔离 | `scripts/testEnvironment.mjs` 隔离 HOME/USERPROFILE/GUGO_HOME；不能删掉隔离后用生产 opt-in 门槛隐藏配置 |

注意：原圆圈的 SVG 百分比数学本来正确，本批修的是计量数据链路。不靠计时器、固定最小弧或历史累计 tokens 制造“在动”。未知窗口不伪造分母。

## 4. 用户明确要求保留的边界

- **不能重设计页面或右上角入口。** 保留“侧边栏／本次改动／预览／任务清单”的名称、图标、顺序、位置和主布局。
- 终端、文件已在侧边栏；不新增重复入口。本次改动就是 Changes；不要再改成仿 Claude 五按钮工具栏，该提案已撤回，未进入生产代码。
- `WorkbenchToolbar.jsx`、`RightWorkbenchFrame.jsx`、`ChatSessionHeaderBar.jsx`、`ChatRightPanels.jsx` 在本次实现相对 `71b01e4` 无差异；后续未经明确授权不要重排。
- 保留暖纸风格和品牌色。丙档的 Surface 四阶重配色、品牌焦点环、全局角色圆角不做；不改 HTML/Office/PPT 等作品自身内容排版。
- 隐藏终端不终止 PTY/活跃进程；预览按钮不自动启动命令。
- 本机免登录不等于移除 owner/userId、认证、回环监听、CSP、目录授权或审批。默认本机模式不自动开放公网匿名能力。
- 不默认读 `.env`、真实密钥、真实模型配置、数据库或会话；不默认调用付费/真实模型。
- 不自动 stage/commit/push、创建 PR、合并或发版。本次提交授权不是未来开发每轮的永久 Git 授权。

参考仓库为本地 `D:/open-claude-ui` 的 MIT 提交 `2834bc158a4849f21c97cbb2e0b10525f6e646f1`。字符串存在不证明原厂 SVG、按钮顺序或交互曲线；不复制专有字体、图标、音频、二进制或会话。

## 5. 验收证据及可信范围

| 批次 | 当时冻结全量 | 持久证据 |
|---|---|---|
| UI 第一批 | 1170 文件 PASS | `docs/review-evidence/ui-refinement-phase-1/verification.json` |
| 审批回执 | 1172 文件 PASS | `docs/review-evidence/ui-refinement-phase-2/verification.json` |
| Changes/历史 | 1176 文件 PASS | `docs/review-evidence/ui-refinement-phase-3/verification.json` |
| 模型配置/上下文（最新） | **1180 文件 PASS / 875.231 秒** | `docs/review-evidence/model-configuration-context/verification.json` |

最新全量前后 184 个改动代码/测试/配置哈希一致；定向 22 文件/186 项，离线 71 项，lint、类型（18 个负例拒绝）、debt、复杂度、i18n、依赖、隔离 Web 构建通过。随后又做 lint 和交接前文件/敏感模式核对，没有再改业务源码。

`docs/review-evidence/model-configuration-context/source-manifest.json` 保存这 184 个文件的验收工作树 SHA-256 和对应 Git blob ID。工作树字节哈希受 LF/CRLF 影响，跨 checkout 时以 Git blob ID 核对同一源码快照，不把换行转换误认为新业务变化。它不表示所有旧文件都有单独新增测试。

浏览器实际验证：32 候选选 2 个、保存返回聊天、已保存目录进一步选 1 个、返回保留草稿；本机 HTTP 模型代理及正常输入框 SSE 链路；草稿增长和 70,000/100,000 的 0.700 弧长；1440/360 × 三主题。正常输入框链路记录 1 次流式请求和 1 次非流式标题请求。

**以上模型响应均来自自建本机确定性 fixture，不是真实 Provider/模型效果成功率。** 未验证原生 Electron 安装包、长期性能/FPS、OS 沙箱或签名发布。没有为了验收修改用户真实配置或数据。

原始失败/中止日志、快照及隔离 profile 仍在本机临时目录，可能被系统清理，不能作为跨机器唯一证据：

- `C:/Users/21161/AppData/Local/Temp/gugo-model-selection-9O63K9`
- `C:/Users/21161/AppData/Local/Temp/gugo-changes-simple-RImjKQ`
- 前两批：`gugo-ui-parity-MHl4UR`、`gugo-ui-decisions-8SnPeC`

自建 UI/模型 fixture/Edge 服务已关闭。不要按旧 PID 或端口杀进程，也不要删除用户本来运行的服务。

## 6. Claude Code 接续执行计划

### 第 0 步：只读确认

- 确认上述目录、Git 分支、实现提交和工作树状态。若出现新改动，先盘点，不 reset、stash 或覆盖。
- 阅读约定和与新需求相关的源码；向用户确认下一项要改什么。用户目前只要求交接，没有给下一项新功能。
- 保留已经完成的四项行为；不要从旧 TODO/旧失败日志推断它们还未修复。

### 第 1 步：小范围计划和复现

- 一轮只选一个有明确验收条件的问题。三文件以上/复杂逻辑先给 `<plan>`，说明文件、边界和验收，等用户确认。
- 相关测试先跑基线，再构造实际失败用例；不得用只锁 JSX/Hook 写法的源码断言代替可见行为测试。
- 需要浏览器时，用独立 profile、数据库、工作区、HOME/GUGO_HOME 和自有 loopback 服务。禁止直接对真实配置写入调试数据。

### 第 2 步：修复和近邻回归

- 局部修改，不借 UI 小修重写执行引擎或整仓类型系统。
- 优先复用原语/协议和真实消费者；校验菜单焦点、IME、空态、失败态及 owner/session 隔离。
- 先运行相关组，例：

```text
node scripts/run-tests.js tests/llmRuntimeSelection.test.js tests/unit/ModelConfigurationFlow.test.jsx tests/unit/ModelConfigurationLiveCatalog.test.jsx tests/unit/ContextRingProgress.test.jsx tests/unit/ModelPicker.test.jsx tests/unit/ContextMeterDraft.test.jsx
```

工具栏/Changes 修改另选 `ChangesNavigation`、`ChangesOpenTarget`、`ModalEscapeLayers`、`HistoryPlacement`、`ChatRightPanels`、`RightWorkbench` 等对应测试，不能仅跑模型组。

### 第 3 步：门禁与冻结

以 `package.json` 的真实命令为准：

```text
npm run lint
npm run typecheck
npm run debt:check
npm run audit:functions -- --check
npm run i18n:check
npm run i18n:keys
npm run deps:check
npm run eval:offline
```

构建使用临时输出目录，禁用自动 dotenv 加载；需要 dev/桌面启动时先配置隔离的 APP_DATA_DIR、APP_DB_PATH、GUGO_HOME、WORKSPACE_ROOT、loopback host/端口和禁用工具开关，不直接对真实环境运行。测试 runner 会创建自己的数据/home 隔离。

业务代码稳定后冻结新清单，再从头 `npm test`。本机最近一次耗时约 15 分钟；运行期间改代码的 PASS 不是最终基线。失败三次且没有新证据时停止定位，不靠猜测重试。保留原失败记录，并更新本轮证据，不覆盖旧轮次历史。

### 第 4 步：交付

- 明确实际修改、测试和未验收范围；更新当前状态、经验及相应契约。
- 关闭本轮自己启动的服务，保留证据。
- 只有用户再次明确要求时才提交/推送；原生打包、真实 Provider 测试、签名/发布另行授权。

## 7. 未完成项，不要误当成本次必做任务

- UI 甲＋乙仍有旧控件迁移、间距/图标/阴影、主题例外、焦点对比度、小字分类和动效时长/easing 的后续治理；不是所有 WP 已完成。
- 引擎总依赖袋仍有 241 项，严格验收契约不等于自然语言目标已全自动可靠判定，类型试点也不是全仓完成。
- 任意模型别名并不都有可靠窗口元数据；未知应明确标注，不能凭名字或截图猜超大窗口。
- 原生 Electron、真实 Provider、长期性能、OS 隔离、安装包和发布仍待各自独立计划/授权/验收。

这些只是候选方向。先等用户指定新的修改目标，不自动开展大改。

## 8. 可粘贴给 Claude Code 的开场提示

> 请接手当前本地 Gugo 项目。先完整阅读 AGENTS.md、docs/CLAUDE_CODE_HANDOFF.md 和 docs/CURRENT_STATE.md，核对 git status 与本地实现提交 39b20c31e868bd3adf272fb12a70172448b3304e。先只读检查，向我简要报告基线并等待我的下一项需求。不要重设计页面、改动右上角四入口，不要读取真实密钥/配置/用户数据库，不要调用真实模型，不自动提交、推送、打包或发版。复杂任务先给计划，经我确认再实施。
