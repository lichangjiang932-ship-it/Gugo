# 通用 Agent 基础审计与验收记录

日期：2026-09-07。审计基线：`bc3fd6bc3ef6e16301b6ccb513e5046751bd2a21`。

本文记录真实代码边界、故障复现和验收结果，不以文件数量、代码行数或测试数量推算“完成百分比”。首轮准备版本为 0.11.55，其正式发布未完成；当前准备版本为 0.11.56。准备版本不代表正式桌面安装包已经发布。

## 目标与取舍

目标是本地优先的通用 Agent，而不是只会写代码的聊天页面：

- Pi：参考小型循环、明确的状态与工具契约，以及稳定的模型消息转换；不把应用的所有功能塞进内核。
- Codex：参考工具调用、恢复、连续执行和上下文整理；任务完成依赖真实证据，不依赖模型口头承诺。
- WorkBuddy：只参考可复用技能与插件的使用方式，不再以其任务完成控制作为目标。
- OpenWorker：参考本地状态归属、工作目录和可恢复运行；本地优先不等于依赖未经证明的“绝对离线”承诺。
- DeepSeek Harness：参考清晰的扩展边界、工具发现与技能资源接线；插件不能绕过宿主的授权和交付验证。

## 审计范围与参考版本

检查覆盖 `server/`、`shared/`、`src/`、`desktop/`、`bin/`、`scripts/`、技能种子与包、测试和 CI/Release 配置。方法为全仓目录/静态依赖检查、关键执行链实读、参考源码定点对照，以及隔离环境中的故障注入。第三方依赖、生成文件、用户数据库和凭据不作为可任意修改的源码；没有改动四份参考目录的用户修改。

这不代表对所有第三方代码作过逐行安全审计，也不代表所有真实模型都已经完成长期生产压测。

| 参考项目 | 本地提交 | 核验的上游默认分支提交 |
|---|---|---|
| [Codex](https://github.com/openai/codex) | `d44696065723a56b9de6538cd6348fcbe6c1542e` | `694b6319d3ad2399f6e435760a22d9b9357f0697` |
| [Pi](https://github.com/earendil-works/pi) | `cd6852a123f2c0cc646a41a2a52f3711a603b822` | `9767ba275f3e9a5ee0f5c5342249b629ab1b2282` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `49a606bc5b5934603f22a26957a07dc799ab0291` | `d347e703908d0406b7a7ef80e3a0e594d86b2215` |
| [OpenWorker](https://github.com/andrewyng/openworker) | `db93d75bf634e3a855b29e00d8f5d677438cac1f` | `5bc10d928e0b64aae74313349a3b17bd19643ae2` |

OpenAI 的 [Compaction 文档](https://developers.openai.com/api/docs/guides/compaction)另用于核对协议边界：原生 `/responses/compact` 返回的完整窗口是后续上下文的权威输入，不能只保留其中一个 opaque item。Gugo 的跨 Provider 摘要/截断策略必须与这种厂商原生隐藏状态压缩区分，不能把二者混为一谈。

## 已有基础，不应重复推倒重写

1. 内核已有完整、版本化的 loop 与 persistence 适配器；Turn、Job、CLI、Subagent 有共享执行契约和可执行依赖边界。
2. 任务已有持久检查点、执行租约、fencing、审批、未知副作用恢复和执行后验证。不能为了少显示失败提示而关闭这些检查。
3. 插件已有兼容约束、签名/不可变 Release、激活与回滚、生命周期清理及 durable Agent Event 消费。
4. SSE/WS 的传输版本与 durable Agent Event 的版本表示不同契约，不能仅因为数字不同就当成重复架构错误。
5. 对话渲染已有有界窗口；运行时和前端大小门禁已有测试，不应把拆文件当作本轮主要价值。
6. 类型检查不是零：严格 `checkJs` 协议试点已接入 CI，但还远非全仓类型安全。

## 本轮确认的实际缺陷

### 任务与模型循环

- 最新用户消息若采用多模态/typed-content 数组，循环初始化可能跳过它并继承旧修改任务，造成普通新问题被要求提供执行证据。
- Gemini function-call 的 `thoughtSignature` 与调用身份在消息转换/检查点中丢失，下一轮可能不再满足 Provider 的上下文协议。
- 机械压缩会截掉长用户资料的中段；原始档案还在，不等于当前模型窗口仍知道其中关键约束。必须接入有界、可取消的语义整理，并诚实呈现降级。

### 插件与技能

- 插件导入的 prompts 目录可以通过 junction/symlink 指向包外，校验与实际读取边界不一致。
- Codex 技能文件变化后，运行时可能继续沿用旧的 ready 判断，即使新正文已经需要额外运行能力。
- 导入技能的 references/scripts 虽已存储，也有鉴权 HTTP API，但模型没有可调用的资源读取链路；资源数量不等于技能可运行。
- MCP 声明 `tools.listChanged` 后，管理器未订阅变化通知，旧 schema 可持续被使用。
- 旧动态工具 disposer 能删除后来注册的新一代状态。

### 本地运行与界面

- 桌面仅覆盖 `APP_DATA_DIR` 时，默认数据库与产物目录仍可能停留在旧 userData 路径，与 Web/CLI 身份不一致。
- “忽略恢复提示”只存在 React Ref 中，跨路由卸载/重新进入或跨窗口后会恢复。
- Markdown 远程图片直接交给浏览器加载，绕过服务端纯本地出网策略。
- Web/桌面发行验证脚本继承部署环境，可能读取真实数据库、配置或自定义持久化模块；已改为验证命令专用白名单和独立运行目录，并覆盖异常退出时的环境恢复。

### 长期记忆

- 自动记忆和显式 `remember` 的去重未正确按 Agent 作用域隔离，可能覆盖或移动另一个 Agent 的同名记忆。
- 记忆正文、来源和关联链接不是原子更新；链接写入失败后仍可能留下已修改正文。
- 自动更新后的来源仍指旧会话/消息，不利于核对事实。
- 中文标题丢失于 ASCII slug 归一，不同记忆获得同一个链接；重命名还会破坏旧入链。
- 无标签的已知 Provider token 格式可能被额外发送给自动记忆提取流程或被接受为记忆候选。

## 已落地的验收路径

| 场景 | 修复后的实际约束 | 验收依据 |
|---|---|---|
| 新问题与旧任务 | 最新 typed-content 用户消息决定当前意图，保留原始图片/附件；普通新问题不继承旧修改任务 | `typedUserExecutionIntent.test.js` |
| 原生模型连续工具调用 | Gemini 签名、原始参数、调用 ID 与提供商/模型/端点绑定；审批改参不能伪装成原始签名调用 | `geminiReplayState.test.js` |
| 长资料整理与冷恢复 | 完整分片、按需摘要、预算/取消/降级；摘要请求独立于主回答，人工恢复后实际消费摘要并只计一次费用数据 | `semanticCompactionContinuity.test.js`、`modelRequestRecoverySlots.test.js` |
| 旧版本检查点升级 | 无新压缩 recipe 的旧请求先本地重建并核对原指纹；未知请求不提前创建第二个摘要请求；已知失败可安全恢复 | `legacyCompactionRecovery.test.js`、`subagentRuntime.test.js` |
| 技能真正读取资料 | 已选技能才有资源入口，只能读所属用户范围内的文本；不执行脚本、不授予目录权限 | `skillResourceToolIntegration.test.js`、`skillResourceRuntime.test.js` |
| 动态扩展 | MCP 通知触发有界刷新，失败保留已知有效目录；旧生命周期清理不能删除新注册状态 | `mcpToolCatalogNotifications.test.js`、`toolSchemaDynamicRegistryLifecycle.test.js` |
| 记忆归属与溯源 | 按 Agent 作用域去重，正文/来源/链接原子更新；中文稳定链接和凭据过滤 | `autoMemoryScopeIsolation.test.js` |
| 本地数据与远程图片 | 桌面覆盖目录一致；Markdown 远程图片经过认证代理与实时网络政策，纯本地禁止该出网 | `desktopSecurity.test.js`、`remoteMarkdownImage.test.js`、隔离浏览器实测 |
| 恢复提示 | 仅忽略当前身份、服务实例、会话、轮次与失败边界；刷新和跨路由后保留，新失败仍可提示 | `streamResumeDismissals.test.js`、`ChatTurnRecoveryLifecycle.test.jsx`、隔离浏览器实测 |

语义压缩的默认值、费用、失败降级和未知上游请求边界见 [CONTEXT_COMPACTION.md](CONTEXT_COMPACTION.md)。它不是无限记忆，也不能替代真实工具执行证据。手工恢复 `completed` 只恢复用户核对过的上游响应，`not_sent` 只允许在核对请求确未发送后重新发送。

## 到目标还差什么

目前不是“需要重新拼一个内核”的阶段，主要差距是跨场景可靠性、扩展可用性和可验证的运行边界。

| 目标 | 可交付验收条件 | 仍需保留的边界 |
|---|---|---|
| 通用任务 | 普通问答、文本工作、文件/工具工作不互相误判；当前用户意图优先 | 不能承诺任何模型、任何问题都必然成功 |
| 长任务 | 输出续写、压缩、工具对话与检查点可连续使用；关键约束可追溯 | 摘要有损，需真实长任务样本和跨模型回归，不能宣称无限上下文 |
| 高缓存复用 | 稳定提示前缀、工具顺序和 Provider/模型身份；不把随机状态放入可复用前缀 | 命中率还受供应商缓存策略、请求内容和窗口变化影响，不能凭本地代码保证固定百分比 |
| 技能插件 | 已选技能的资源可以被实际工具读取，schema 变化能到达执行器 | 任意二进制模板的安全物化/执行仍需独立能力；不自动执行第三方脚本 |
| 本地优先 | 相同明确数据目录对应同一数据源；应用控制的出网经过服务端政策 | 任意 Shell、可信插件和 MCP stdio 不构成 OS 级网络隔离，严格 air-gap 需要经验证的系统边界 |
| 工程可持续 | 类型试点继续覆盖关键实现与调用方；能力用例持续增长 | 全仓类型迁移尚未完成；不把静态 aliases 当作实现检查 |
| 正式分发 | 验证过的主分支提交、匹配版本/标签及显式签名策略、完整资产、校验和与来源证明 | 0.11.56 沿用首次为 0.11.55 选择的未签名策略，接受缺少 Windows 发布者身份的风险；不能伪称证书或签名保证已补齐 |

已有历史记忆的含混旧链接不会被猜测性重写；新的稳定链接策略负责阻止新增歧义。公开 Marketplace 自动分发也属于独立的信任与产品决策，不应为追求“完全插件化”绕过验证安装。

## 发布预检

发布预检时仓库最新稳定版本为 `v0.11.54`。其 [Release run 34021618396](https://github.com/lichangjiang932-ship-it/Gugo/actions/runs/34021618396) 在当时仅允许签名分发的 `Require Windows code-signing credentials` 步骤失败。本轮当时读取仓库 Secret/Variable 元数据，确认以下配置未提供：

- Secrets：`WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD`。
- Variable：`WINDOWS_PUBLISHER_NAME`，必须与签名证书发布者一致。

这说明“发布脚本具有安全门禁”与“生产签名已配置并成功发布”是两个状态。上述缺证书导致失败的历史事实仍然成立，不会通过修改报告、删除既有正式资产或覆盖旧标签抹去。

用户随后明确选择“不配置签名发布”。因此 0.11.55 通过当时提交的 `scripts/release/policy.json` 将 `version: "0.11.55"` 与 `windowsSigning: "unsigned"` 绑定。这是经明确选择的分发策略，不是因缺少 Secret 自动降级。后续升级版本也必须同步审查策略版本；策略缺失、无效或版本不一致均停止发布。选择 `signed` 的版本仍要求完整证书、时间戳、发布者与更新器配置验证，失败不转未签名。

未签名路径使用 `npm run desktop:package:unsigned`，禁止 executable signing 但保留图标和版本资源，验证安装器与打包主程序均为 `NotSigned`。CI、完整五资产、SHA-256 校验清单、GitHub 构建来源证明及已发布资产不可变约束全部保留。校验和与来源证明不是 Authenticode，也不能给未签名安装包补上 Windows 发布者身份或保证其安全。因此相关签名债务保持开放并记录显式接受的风险，当前符合已提交未签名策略的发布不再仅因缺证书而阻塞。

Windows/SmartScreen 仍可能提示未知发布者，不建议关闭系统或组织保护。更新器在 SHA-512 校验后、提交缓存和报告 ready 前仍调用当前 `NsisUpdater.verifySignature`，不全局禁用签名校验。正确执行发布者校验的签名客户端会拒绝未签名更新，需用户核对风险与下载校验后显式手动迁移；新代码不能追溯修复已分发的旧客户端。操作与限制见 [DESKTOP_RELEASES.md](DESKTOP_RELEASES.md)。

早先本地说明补记时，未签名构建已走过配置结构校验，但实际打包在 Electron 解压后的 `rename` 阶段遇到 `EPERM`；当时没有将配置检查记作安装包验证或发布成功。构建产物仍须通过 `powershell -NoProfile -File scripts/release/verify-windows-signing.ps1 -Mode unsigned`，确认安装器与主程序均为 `NotSigned`，且真实 YAML 更新元数据不声明证书发布者；隔离输出通过 `-ReleaseDirectory` 指定。

本次策略调整的提交前回归覆盖发布策略、来源校验、桌面更新与安装入口、进程清理、崩溃恢复：10 个测试文件，174 项通过、2 项平台跳过、0 失败；lint、类型检查与大小门禁通过。还修正了合并后 CI 暴露的两处测试前置条件：实际崩溃后先等待持久租约到期，线程池压力目标使用真实 sealed Job。未修改产品租约或 PID 身份门禁，也不声称已追溯出历史 CI 的具体 Win32 错误码。最终安装包与正式发布结果仍以新提交的 Release 工作流为准。

后续 `v0.11.55` 标签固定在主分支提交 `3a6c161264ad8b5579b5171e46e3d30111203663`。该次 Release 的全部 CI、未签名打包、双 `NotSigned` 校验、校验清单及构建来源证明阶段已经成功，但 publisher 在草稿 Release API 阶段失败，没有正式发布的 Release 或公开资产。保留该失败标签，不挪动或复用；这些已完成的前置步骤不等于发布成功。

当前以 0.11.56 修复草稿发现与数字 Release ID 复核，并将版本声明和 `scripts/release/policy.json` 同步绑定为 0.11.56／`unsigned`，仍不配置证书。当前版本必须取得自己的最终验证与发布结果，不能继承 0.11.55 的通过结论或宣称其已补发；未签名风险及签名客户端需手动迁移的边界保持不变。

生产依赖审计另有两项 `image-size@1.2.1` 的版本锁定临时例外，过期日为 2026-11-06。审计通过不代表不存在任何已知漏洞；其边界和到期条件继续由 `scripts/audit-production.mjs` 验证。

## 最终验证

以下是未签名分发策略调整前的通用 Agent 修复验收记录；未结束的门禁不记为通过。后续发布策略与更新器变更必须针对最终提交独立验证，不能直接继承下表的通过结论。审计前版本的 794 个测试文件与 61 项离线评测通过记录，不作为本轮修改后的通过证明。

| 检查 | 当前结果 |
|---|---|
| `npm run eval:offline` | 61/61 通过，网络隔离的离线能力评测 |
| `npm run lint` | 通过 |
| `npm run typecheck` | 通过，11 个非法调用反向 fixture 全部被拒绝 |
| `npm run audit:functions -- --check` | 7,734 个顶层函数，0 复杂违规、0 解析错误；4 个显式声明型排除 |
| `npm run debt:check` | 13/13 通过，无新增大小豁免或门禁放宽 |
| `npm run build` | 通过 |
| `npm run benchmark:checkpoint` | 通过，atomic/direct 中位数比值 0.97x，门限 3.00x |
| `npm run audit:prod` | 通过，但保留上文所列两项定期失效例外，不代表零漏洞 |
| `npm run licenses` | 333 个生产依赖许可检查通过 |
| Web 发行包 | 1,925 个打包文件与冻结源码逐字节一致；全新目录 `npm ci --omit=dev`、CLI 版本/帮助、后端健康检查通过 |
| 桌面发行依赖 | `desktop:check` 47/47，静态入口闭包未发现漏打包模块；smoke 环境及现有打包测试 30/30；未声称已验证新的签名安装包 |
| Web 验证脚本 | 17/17；专用 8 项隔离回归分别通过 PowerShell 7 和 Windows PowerShell 5.1 |
| `npm run test:coverage` | 812 个测试文件通过：7,008 项通过、10 项既有跳过、0 失败、0 取消、0 重跑；门禁范围内行覆盖率 77.57%、分支 76.60%、函数 76.99% |

首轮全量的四项失败分别为未签名原生响应的旧清理契约、子代理已知失败检查点被误判为未知请求、历史诊断中的 token 脱敏兼容，以及新增只读资源工具后的显式目录数量断言，均已在修复后的全量覆盖率复跑中通过。原生模型首正文仍在终态前逐步到达；子代理的 `completed` 和成功工具不重放断言未被降低。最终跨平台结果以本次提交关联的 [CI 运行](https://github.com/lichangjiang932-ship-it/Gugo/actions/workflows/ci.yml) 为准；合并和正式发布必须等待相应门禁，不能使用本报告的局部绿色结果代替。

CI 密钥扫描还识别了两个本轮新增的模拟 Stripe token 字符串。核对后确认均是固定字母表测试数据，不是真实凭据；现改为运行时组装，并只对原提交的两条精确历史 fingerprint 登记假阳性例外，未排除整个文件或放宽扫描规则。调整后的脱敏/验证回归 18/18 通过，关联 CI 的密钥扫描已通过。

本地已验证网页归档的 SHA-256：`ad606b591d05c7ca0a493ad7b3ade18671382574901cd64b05f8d069a20d5587`。这只是本地归档验证，不是签名桌面 Release 或 GitHub 构建来源证明。

浏览器使用独立数据库、独立工作目录和本地确定性假模型，没有使用用户的真实模型凭据。普通 `hi` 得到最终回复；故意不执行文件修改的假模型仍被 `EXECUTION_EVIDENCE_MISSING` 拦住。点击忽略后，切换设置页、返回和整页刷新均不再展示该恢复操作；失败记录仍保留。远程图片的元素没有外网 `src`，浏览器观测到的跨源请求为零，服务端拒绝代码为 `OUTBOUND_PURE_LOCAL_DENIED`。这证明的是该隔离流程，不是任意真实模型的长期成功率。
