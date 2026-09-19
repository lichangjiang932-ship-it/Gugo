# 工作包 B：文件工作台与可信桌面打开

日期：2026-09-19。此记录只覆盖右侧工作台、文件预览和桌面文件操作，不代表全项目或真实模型能力验收。

## 本轮行为

- 文件工作台将输出文件与来源附件分组，普通点击沿用右侧多标签预览；下载是次要操作。
- 预览工具栏展示文件路径面包屑，完整路径保留在可访问名称和提示中。Markdown、HTML、SVG、代码、JSON/XML/CSV 和普通文本提供阅读/源码切换；PDF、Office 和媒体保留原有渲染器，不伪造文本源码。
- 源码最多读取 4 MiB，流式检查实际字节量，不只信任 Content-Length；HTML 源码作为文本转义显示。当前身份通过请求头发送，去掉失效的 URL token。切换文件或关闭面板中止旧请求，晚到的结果不能覆盖当前文件。
- 历史工具读回但没有持久化 receipt 的文件保留名称、路径和快照内容，不再变成空的 directFile。此类快照不会凭 UI 路径获得本机打开权限。
- “打开”菜单提供预览、桌面默认应用打开、显示所在文件夹和另存为。没有既有可信编辑器启动能力，因此不展示虚假的 VS Code/Cursor/Terminal 菜单。
- 浏览器地址栏拒绝 file://、本地绝对/相对路径、非 HTTP(S) 协议、控制字符和含用户名/密码的地址。保留现有 iframe sandbox；持续说明网站可能禁止嵌入，并提供系统浏览器入口。iframe load 事件不被当作成功渲染证据。

## 桌面权限与身份契约

1. Renderer 只传递 `open` / `reveal` 枚举、当前账户 token 和同源文件引用；不传命令或授权依据意义上的本地路径。
2. IPC 仅允许当前应用主窗口的可信 main frame。子 frame、其他窗口、导航离开后的未完成请求和重复并发操作被拒绝。
3. 主进程固定请求本机同源 `POST /api/local-files/desktop-target`，禁止重定向。启动时生成的临时 bridge secret 对请求、nonce、时效和返回元数据签名，不能仅靠“端口位于 localhost”认定服务可信。
4. API 重新验证账户、receipt 的 turn/session/owner 和当前目录读授权，或复用托管 artifact 的 owner / 同名冲突 / canonical-root 检查。接口只返回签名文件元数据，不授予权限、读取正文或执行 Shell。
5. 主进程实时校验 canonical path、普通文件类型及 dev/ino/mode/size/mtime/ctime 指纹。UNC、设备和特殊路径拒绝；不允许以默认应用执行脚本、快捷方式、二进制或宏文档。
6. HTML/SVG 交给外部应用前显示默认取消的警告；确认后再次解析授权和文件版本。拒绝或取消不会伪称已经打开。
7. bridge secret 只存在于启动进程及其后端环境，加入敏感环境和受保护执行环境表；即使模型工具显式请求 env_keys 也不能继承。开发启动器为自己的 Vite/Electron 配对共享临时值，不写磁盘配置或日志。
8. 未知 I/O/数据库失败返回脱敏 500，bridge 不可用返回 503，权限/签名错误保持 403；不回传底层路径、异常消息或堆栈。

这不是文件系统事务锁：外部程序仍可能在系统打开文件的瞬间修改文件。版本和 canonical 检查用于阻止已观测到的替换，不宣称消除操作系统级所有竞态。

## 验证证据

所有数据库、文件、junction 和网络 fixture 均隔离在测试临时目录。没有读取真实用户数据库、调用收费模型、实际发布或生成安装程序。

| 本次实际入口 | 结果 |
| --- | --- |
| `desktopFileActions`、`desktopFileTarget`、`desktopPackaging`、`desktopSecurity`、`sensitiveEnv` | 77/77 通过 |
| `RightPreviewPane.test.js`（含完整多标签阅读/源码切换） | 30/30 通过 |
| `RightWorkbench.test.js` | 11/11 通过 |
| `localFileAccessRoutes`、`artifactDownloadPreview`、`artifactHtmlPreviewSession`、`previewArtifactRevisionSync`、`unit/previewRendererRegistry`、`directFileSource`、`rightWorkbenchNavigation`、`codeDebt` | 50/50 通过 |
| `unit/DirectFilePreview.test.jsx` | 17/17 通过 |
| `unit/FileWorkbenchActions.test.jsx` | 7/7 通过 |
| B 范围定向 lint | 零 warning 通过 |
| `audit-function-length.cjs --check` | 0 复杂度违规、0 解析错误 |
| tracked 差异空白检查 | 通过 |

直接运行 `node scripts/run-tests.js tests/unit/FileWorkbenchActions.test.jsx`；不新增重复 Vite 包装测试，沿用 runner 对 JSX 的 Windows 隔离执行策略。

### 过程中保留的失败与修正

- 导航回归先复现 `file:///C:/...` 被错误改成 `https://file///C:/...`，修复后通过。
- 新密钥最初仅进入默认敏感表，显式 env_keys 回归失败；补齐受保护表后通过。
- 跨 owner 同名测试最初被单表唯一索引提前拒绝，改为确实能触达 owner 冲突分支的 job/turn 跨表 fixture；没有放宽数据库约束。
- iframe 的普通 onError 未捕获非冒泡错误事件，改用捕获阶段；新增打开菜单遗漏下载完整 tooltip，恢复后原回归通过。
- 原生打开接线使 main.js 超出大小门禁。将新功能的初始化、确认和注册职责移到 fileActionSetup，未压缩语句或修改阈值；main.js 现为 599 行。
- 包闭包检查发现新增桌面模块未列入 electron-builder 的显式白名单，已补齐两个模块；没有实际运行安装器打包。

## 尚未扩大声明的部分

- native API、确认对话框和 IPC 行为在隔离 mock/真实临时文件组合中验证。本工作包未启动真实 Electron 去打开用户文件，真实 Windows 默认应用与文件管理器可用性需主任务验收。
- 真实浏览器视觉布局、跨域站点响应和真实本地模型任务由主任务另行记录；JSDOM/脚本测试不替代这些结果。
- 托管 artifact 和 verified/retained receipt 可申请 native 操作。普通附件、纯内容快照和任意 UI 路径不会自动获得这种权限，仍可按现有授权网页预览或另存为。
- 全局样式、CLI 配置、分叉/引用、真实模型、全量门禁与最终构建不归本工作包，未覆盖或宣称完成。

## 追加验证：真实 Electron 与临时 ASAR（2026-09-19）

以下是在上述首次交付之后补做的验证，保留前面的历史未验证记录，不将它改写成当时已经完成。此次没有变更业务后端、用户配置或已有 release 产物。

### 真实运行证据

仓库 `node_modules/electron` 的包元数据为 43.3.0，但 `dist/electron.exe` 当前缺失。因此没有声称完整的 `npm run desktop:dev` 已成功启动，也没有下载、安装或修改 Electron。探针复用仓库已有 `.artifacts/unsigned-0.11.55-afba65fae4c342c6be86caee30082dc3/win-unpacked.tmp/electron.exe`，实际运行版本确认为 Electron 43.3.0 / Node 24.18.1。

两轮各自使用独立临时 SQLite、产物、workspace、Chromium profile、日志和 loopback HTTP 服务。启动环境复用 `createDesktopSmokeEnvironment` 的白名单，禁止 dotenv/模型凭据/插件服务继承。Electron 与其 Node 后端通过 `windowsHide: true` 启动，BrowserWindow 使用 `show: false`，保留 production 的 contextIsolation、sandbox、webSecurity 和禁用 Node 的配置。

- **源码模式：退出 0。** 使用生产 `fileActionSetup`、`fileActions`、preload、metadata route 和授权服务。模拟开发启动入口的临时 key 配对，实际跨进程 HMAC 和真实 SQLite/文件校验通过。没有执行整个 `desktop/dev.mjs` 启动脚本。
- **mini-ASAR 模式：退出 0。** 从一个新建临时 ASAR 加载生产 `desktop/fileActionSetup.js`、`desktop/fileActions.js`、`desktop/preload.cjs`、`desktop/security.js`、`server/utils/desktopFileProtocol.js`、`shared/desktopFileReference.js`、`shared/productLanguage.js`；7 个模块均实际存在且被 Electron 的 ASAR 路径加载。此轮 metadata 后端仍从仓库源码加载，不是完整后端 ASAR / NSIS 安装验收。
- 两轮均确认 `gugoDesktop` 已冻结、`fileAction` 可调用、renderer 中 `require` 不存在。
- 两轮均完成真实 main-frame IPC → 独立后端授权查询 → 签名元数据 → 实时文件指纹校验 → **真实 `shell.showItemInFolder`**；目标仅为各自新建的无害 `bridge-probe.txt`。不是 mock shell。API 返回只表示系统显示目录请求已经发出，没有自动断言 Explorer 的视觉状态。
- 两轮均验证其他 owner 返回 `VERIFIED_FILE_NOT_FOUND`、原始路径和未知动作被拒绝、第二个真实 BrowserWindow 返回 `DESKTOP_FILE_SENDER_UNTRUSTED`、子 iframe 未暴露 bridge、撤销目录授权后返回 `PATH_NOT_AUTHORIZED`、后端 key 错配返回 `DESKTOP_FILE_SERVICE_UNTRUSTED`。
- 进程检查确认探针 Electron/Node 进程已退出，没有停止用户应用。默认应用 `open` 及 HTML/SVG 原生确认对话框仍只有隔离行为回归；此次不把它们扩大为真实系统应用验收。

### 证据与复现

本机证据根：`%TEMP%/gugo-native-bridge-9a33cb2bd42f4169b3badc043c3a42e2`。

- `report.json`：源码模式结果。
- `mini-asar-report.json`：临时 ASAR 的 7 个生产模块清单。
- `asar-run/report.json`：ASAR 模式真实 Electron 结果。
- `stdout.log` / `stderr.log` 及 `asar-run` 内对应文件：进程输出。
- `launch.mjs`、`probe.mjs`、`backend.mjs`、`build-mini-asar.mjs`：可复现的本机探针。
- `closure-report.json`：额外只读打包依赖检查。

从仓库根目录复现（只读使用已有 Electron，输出仍在探针临时目录）：

```powershell
$desktopBridgeProbeRoot = Join-Path $env:TEMP 'gugo-native-bridge-9a33cb2bd42f4169b3badc043c3a42e2'
$desktopBridgeElectron = Join-Path $PWD '.artifacts/unsigned-0.11.55-afba65fae4c342c6be86caee30082dc3/win-unpacked.tmp/electron.exe'
node "$desktopBridgeProbeRoot/launch.mjs" "$PWD" "$desktopBridgeElectron"
node "$desktopBridgeProbeRoot/build-mini-asar.mjs" "$PWD"
node "$desktopBridgeProbeRoot/launch.mjs" "$PWD" "$desktopBridgeElectron" "$desktopBridgeProbeRoot/bridge-mini.asar"
```

这些临时探针不是仓库默认测试、正式产品入口或新 installer；临时目录若被系统清理，需按其保留记录重建。

### 发版闭包补齐

发现 `verify-desktop-package.cjs` 的 afterPack 固定清单未覆盖本轮 5 个新 bridge 模块。经主任务确认，已加入两个 desktop 模块、metadata service、签名 protocol 和 shared reference policy；必须存在的 runtime 文件从 23 个增至 28 个。测试用生产文件生成真实 ASAR，每次仅移除一个目标文件并还原，再验证对应缺失明确失败，不由上一处缺失替后续用例“通过”。

- `npm run desktop:check`：语法检查及 **71/71** 通过。
- `desktopFileActions`、`desktopFileTarget`、`desktopSmokeEnvironment`：**24/24** 通过。
- 包验证器与包装回归的定向 lint：通过。
- 额外只读遍历 `desktop/main.js` 的 1,050 个静态可解析本地依赖：缺失文件 0、未被打包规则覆盖 0、`bin/` 依赖 0。保留 2 处动态加载未纳入静态证明，不宣称覆盖用户自定义模块。通用 AST 助手最初将 JSON 当成 JS 解析失败；辅助检查将合法 JSON 作为资源叶节点处理，未修改生产源码或测试助手。

既有 `release/win-unpacked/resources/app.asar` 虽标为 0.11.56，实际不含本轮 5 个 bridge 模块。对该旧产物的真实检查，在补清单前已因缺少 `server/adapters/browserUploadAutomation.js` 失败；补齐后同时报告该既有缺失和 5 个新 bridge 缺失。**没有发生“旧包通过了新验收”，也没有覆盖或修补这份旧包。**

CLI 分发范围只读核对：`electron-builder.yml` 原本不包含 `bin/**`，既有 ASAR 顶层 `bin/` 文件数为 0，`bin/yma-cli.js` 也不在包内。`package.json` 中的 bin 元数据不等于桌面安装器提供了 CLI。新 `runtimeSelection.js`、`configCommand.js` 属于独立源码 CLI，不是此次 desktop 漏装；本轮没有擅自增加 CLI 打包入口。

**仍未生成本轮 installer，未发布。** 主任务应通过完整 release/CI 重新构建并验收新安装包，不能交付这份已有旧产物或把 mini-ASAR 当成安装包。
