# 2026-09-19 网页、CLI 与桌面集成验收

本文记录用户截图反馈的实现及真实验证；发布状态以远程 Release 为准，版本号提升不等于已发布。

## 已实现

- 正常回复移除请求 ID、上下文条数、前缀指纹及未知 KV 面板；底层诊断和失败恢复入口仍保留。
- 普通文本选择和复制不再弹引用浮层。引用改为消息工具栏的显式操作，只消费该消息选区；无选区时引用正文，保留输入框原草稿且不自动发送。
- 分支菜单的 backdrop-filter 层叠上下文原先低于消息区，真实点击被消息区域拦截。抬高有界 header 层级，保留分叉事务、owner 校验、活动任务拒绝及历史执行身份清理。
- 执行过程按公开文字的 UTF-16 偏移与真实工具事件交错。宿主在既有 checkpoint 中保存有界、版本化 publicTimeline，终态绑定 canonical 正文；刷新使用同一显示坐标，不改变模型历史，不展示隐藏 reasoning。旧记录没有证据则保守回退。
- 左侧 mini timeline 为轻量 1px 短线，去三角；项目可见会话数量移除，无障碍数量保留。工作台开关使用轻量 PanelRight 图标。
- 工作台本地文件默认阅读预览，提供路径、源码、多标签及显式另存为；网页不声称可以任意打开 file://。桌面打开通过受控主窗口 IPC、owner/receipt/目录授权、进程实例 HMAC 和文件身份复核。详情见 WORKBENCH_FILE_PREVIEW_2026-09-19.md。
- CLI 可显式绑定运行配置目录，每轮重读同一配置源，拒绝中途换库；默认权限只向更窄的 plan 收敛，不隐式继承 bypass。只读 gugo config 给出实际数据路径和 hash-router 设置入口。桌面自定义存储路径必须显式匹配，不猜用户目录，不迁移数据。CLI 入口仍随源码/网页发行包提供，不宣称 Windows 安装器已附带独立 CLI 可执行文件。
- 显式 CLI `--cwd`／chat `/cwd` 仅在新会话原子创建时绑定项目归属。续会话可使用本轮目录但不悄悄移动原项目；无显式目录仍归 Recent。进程范围目录授权不落永久 grant/trust，普通网页进程仍走既有授权检查，默认输出目录与执行目录保持分离。
- 明确的上游上下文超窗载荷有独立分类；仅真实解析来源且未观察到生成输出时进入既有上下文恢复，请求不缩小则停止。普通 500、伪造标记、取消和部分生成仍保守处理；失败报告的用量按实际字段持久化，恢复不重复计数。

## 隔离与证据

本轮浏览器工作目录为忽略的 `output/playwright/ui-release-20260919/`。QA 使用独立 SQLite、产物、静态文件及 loopback 端口 55103；没有读取或修改用户真实会话、Provider 密钥、Pi 会话或模型安装。

Playwright 真实浏览器已验证：

- 鼠标拖选、Ctrl+C：选区保留、草稿不变、无自动引用浮层。
- 显式引用将选区加入原草稿，刷新后草稿保留。
- 从指定消息分叉仅复制前缀；修复后顶部菜单可实际切回主分支，源会话后缀仍在。
- HTML 授权文件在工作台直接阅读；源码以文本呈现，多文件切换等待实际加载完成后无内容串用。
- 窄屏聚焦预览与 1600×1000 宽屏并排布局。

静态文件样本、确定性模型回调测试不是实时模型成功率证据。真实 Electron 与临时 ASAR 探针只对自建 TXT 调用显示文件夹；具体权限负例及限制见工作台交付文档。

## 保留的失败与修复依据

1. 初次 Vite QA 启动误用 runner，已改为项目相同的 native config loader；未改生产 Vite 行为。
2. 本地 LM Studio/Bonsai 8K 首轮返回 READY，第二轮上游明确报 `Context size has been exceeded.`。原任务记录仍为 unknown，未自动重放；不能将首轮成功说成多轮通过。检查已确认固定 Skills 目录约 15,975 字符、仓库工作目录指令约 5,040 字符，是小窗口压力的主要来源，简化 persona 并不能解决大部分固定开销。
3. 开发接线期间一次 CLI 探针遇到 publicTimeline 未导入；初次全量又遇到 error adapter 导出尚未就绪。这些失败日志保留，最终验收需在全部源码冻结后重跑。
4. 第一轮全量包含旧展示方式的源码形状断言失败；修复必须用真实时间线/挂载行为守住原目的，不能靠删除行为断言或放宽门禁处理。
5. 生产依赖审计发现 fast-uri 3.1.5 的四项 high 漏洞。锁定同一兼容系列的 3.1.6，保留原审计失败，更新后重新验证；不将未升级的安装目录冒充已修。

## 最终验收与发布状态

### 后续真实模型验收

使用已有本机 LM Studio `prism-ml/bonsai-27b`，没有加载另一份模型、调整窗口、停止用户模型或调用收费云服务。资源检查发现显存和内存余量不足，因此没有执行额外模型加载。所有以下任务使用独立 QA 数据及显式 `files` 工作目录；不把有仓库指令的第一次失败改写为成功。

- 非交互 CLI 两轮：`READY` → `CLI-WEB-CONFIG-919`，两轮 completed，各一次 wire request。
- 正常模式真实文件任务：模型实际调用 `list_directory`、`read_file`，两工具均 ok，输出文件内的 `UI-FILE-919`；一个 completed Turn、三次 wire request、未执行写文件或 shell。
- 真实 Windows PTY `gugo chat`：`READY` → `CHAT-CLI-919`，两轮 completed，`/exit` 退出 0。这不是脚本化 reader；仍不代表所有实体键盘和终端组合均验收。
- 修复新会话项目归属后：CLI 新建 `ui-cross-surface-20260919` 输出 READY；网页自动发现其 `files` 项目，切换为计划模式并接续同一历史，正确回答 `CROSS-SURFACE-919`。两轮持久化 projectDirectory 均为同一 QA files 目录。

上述成功组共 7 个 completed Turn、9 次该组 wire request、2 个真实文件工具结果。这个计数不含先前失败组及网页可选后台记忆提取，不是总体模型成功率。`live-model-summary.json` 是从隔离 SQLite 只读提取的证据。模型在文件任务中没有输出所要求的工具前公开进展段落；界面不拿隐藏 reasoning 冒充这种段落。文字/工具交错与冷恢复另由真实持久化链路的确定性回归验证。

### 门禁与范围

定向行为回归已覆盖取消、恢复、旧记录、跨 owner、撤销授权、CLI 默认与显式目录、新/旧会话、事务重试及打包缺文件。原全量运行的失败保存在 `full-tests.log`、`full-tests-final.log`；最终冻结代码使用单独的 `full-tests-release.log`，结果完成后追加，不能把前两份记录当成通过。

生产依赖 fast-uri 已实际安装为 3.1.6，相关四项 high 漏洞已不再触发审计。审计沿用仓库既有、到期日为 2026-11-06 的两项 image-size/pptxgenjs 版本锁定例外；没有新增豁免，不能宣称所有依赖零漏洞。

当前旧 release/ 目录并非本轮构建，不作为交付。真实 Anthropic/Gemini 等收费供应商缓存、Windows 实际默认应用打开（而非定位目录）、完整实体终端矩阵未在本轮实测。

### 提交前冻结代码验收

- `npm test`：**1025 文件，9042 测试，9033 pass / 9 skip / 0 fail**，进程退出 0；以 `full-tests-release.log` 为最终记录。
- lint 零 warning；typecheck 及 14 个反向 fixture、依赖清单、复杂度 0 违规、debt 13/13、i18n 23/23、离线评测 61/61 均通过。
- 402 个生产包许可检查通过；生产审计按前述两项既有临时例外通过。
- 浏览器生产构建通过，desktop:check 71/71；独立 Web 归档重新解包、全新生产依赖安装、CLI help/version 与隔离服务健康检查全部退出 0。
- 归档校验曾提前读取仍在压缩中的 tar，产生 truncated archive；等待压缩进程正常退出后再验证即通过。原失败日志保留，没有修改验证器来放行未完成包。
- Git 暂存差异检查通过，测试数据库、截图、日志、模型配置及临时包均未进入提交。

上述实现已作为 v0.11.57 提交并正常推送主线；远程 required secret scan 命中旧提交 a16a2aa 的合成 JWT 脱敏测试样本，发布因此被阻止。样本的 header 只有 sub、payload 只有 role，签名为字面量 SYNTHETIC_SIGNATURE，不是实际签发的凭据。

后续只将该样本改为运行时生成，并按仓库既有策略登记 commit/file/rule/line 四项精确指纹；没有忽略整文件、JWT 规则或历史区间，也没有修改历史。相关回归39/39；与 CI 相同的 Gitleaks 8.24.3 经发布方校验和核验后，完整历史749提交扫描无未排除泄漏。

v0.11.57 保留为失败发布记录，不移动或复用标签。准备版本改为 v0.11.58，明确延续 unsigned 策略，需重新通过远程 CI、完整五资产构建/校验和/来源证明与发布后核对。该次追加不改变已经完成全量及真实模型验收的业务实现。

### 发布门禁追加：coverage 运行器

v0.11.58 的远程历史密钥扫描、生产依赖审计、Docker、Node 20/24 原生 SQLite 兼容及 Ubuntu 全量检查已通过；coverage 在 2026-09-19T05:42:14Z 被自身 1,200,000ms watchdog 停止。日志保留在 `coverage-58-job.log`，终态为 `FAIL (1 final failure(s)): batch 1/1 (921 files), ETIMEDOUT`；没有把未完成的覆盖率执行算作通过。

原因是覆盖率必须把整个普通测试集合放在同一进程中聚合，但错误地沿用了普通 100 文件批次的 20 分钟时限。修复保持完整单批、测试集合、40% lines / 35% functions / 60% branches 门槛及失败退出码不变：

- 完整 coverage 默认 40 分钟，优先合法 `TEST_COVERAGE_TIMEOUT_MS`，其次合法 `TEST_BATCH_TIMEOUT_MS`；普通批次 20 分钟和隔离测试 3 分钟不变。空白/无效/非正整数不能关闭 watchdog。
- CI 显式设置 coverage 40 分钟，job 外层 50 分钟，为安装与隔离 UI 测试留有限余量；不增加忽略失败或绕过门禁的路径。
- coverage 保留捕获诊断并实时转发 stdout/stderr，不再等进程结束才输出，也不重复打印报告。
- watchdog / spawn 错误优先于子进程偶然返回的 exit 0，防止超时被误报 PASS；覆盖率不足即使 TAP 全绿、exit 0 也必须失败。

这些改动只修发布验证工具链，不改变已验收的应用行为。新增失败路径回归通过后使用独立 v0.11.59 标签重新进入完整 Release CI；v0.11.57 / v0.11.58 的失败标签与运行记录均保留。新 Release 的成功状态必须以实际远程完成及资产核对为准。

提交前追加验证：runner / selectors / process queue / releasePipeline 共 44/44，通过真实进程树短超时、真实 Node 覆盖率阈值失败、失败断言不重试与双通道提前输出握手；发布策略、来源证明、Release discovery / publisher、插件兼容及 Web 隔离验证共 95/95；全仓 lint 零 warning、typecheck 及 14 个反向 fixture、debt 13/13、依赖清单、复杂度 0 违规通过。独立只读复核未发现新增阻塞。这些定向结果不是新版全量 coverage 通过证明。

后续远程证据：v0.11.59 / `65dd21f` 的 coverage job `105849564994` 已真实通过。完整 921 文件批次约 14 分 25 秒完成，1025 文件（含隔离阶段）最终 PASS；`coverage-59-job.log` 的总计为 78.59% lines / 78.07% branches / 78.45% functions，保留原门槛。Ubuntu 全量 job `105849565115` 也通过。该结果验证了 coverage 工具链，不覆盖下文随后修正的 Windows 兼容问题。

### Windows 远程完整结果追加

v0.11.58 的 Windows job `105845997196` 已完整执行 1025 文件、9042 测试（9005 pass / 14 fail / 23 skip），包括 10 个普通批次及 104 个隔离文件，job 约 35 分钟后失败；不是外层 45 分钟到期。保留的 `windows-58-job-105845997196.log` 中的 14 条失败归为以下三类。隔离文件全部通过，不能将这些失败归咎于 Vite worker 偶发退出。

1. 桌面服务及保存的目录授权使用 `fs.realpathSync`，桌面端原先使用的 `fs.promises.realpath` 则在 Windows 扩展 8.3 短名及不同的大小写路径。两者指向同一实体文件、stat 指纹相同，但精确路径比较提前抛 `DESKTOP_FILE_CHANGED`。桌面端改为异步 `promisify(fs.realpath)`，与已有服务/授权算法一致；没有修改授权数据、签名协议或放松任何路径/文件身份比较。真实短名、大小写、HTTP 签名服务链路及同大小同 mtime 的 inode 替换、父目录 junction 替换、确认期间撤销授权均有回归。
2. 三份历史宿主提示词 fixture 被 Windows Git 的 `core.autocrlf` 改成 CRLF，无法匹配真实旧提示词的完整 SHA-256。只在 `.gitattributes` 固定这些 fixture 为 LF，不扩展生产代码对“宿主记录”的识别。新测试在独立临时 Git 仓库启用 autocrlf，再删除测试工作树文件并真实 checkout，先失败再通过；同时保证 CRLF 变体、附加权限条件和用户引用仍不被当成可删除的宿主记录。
3. 五个真实 CLI/PPT 验收共用的测试请求主动给 `run_command` 六秒期限，CI 冷启动在准备 Windows 进程树守护时耗尽它。失败日志里的 CLI 没有整体超时，脚本已写入但 PPT 尚不存在；实际工具结果明确报告自己的六秒超时。测试 fixture 为 Windows 提供包含该启动工作的有限期限，保留原有 CLI/测试外层期限和所有产物验证、损坏拒绝、同轮修复与 lease-loss 断言；生产进程守护及超时/取消语义不变。

v0.11.59 已推送的提交 `65dd21f` 不改写。用于补跑的本机 `full-tests-release-59.log` 在上述远程结果确认后主动停止，以免一边修复源码一边把混合版本运行声称为冻结全量通过。后续完整交付使用独立 v0.11.60 候选，仍须完成全量远程门禁、五项资产及下载后的独立校验。

v0.11.60 提交前定向结果：桌面关联 96/96，真实 Electron 短路径桥接退出 0；历史 policy 字节及升级回归 23/23；PPT 回归 13/13、生产 Windows 进程护栏 9/9、按 CI 串行执行的真实 CLI/PPT 链及参数修复 8/8。上述组有重叠，不相加为独立测试总数。整合策略/发布/桌面回归 74/74，全仓 lint、typecheck 及 14 个反向 fixture、debt、依赖清单及复杂度门禁均通过；两个独立只读复核未发现新增阻塞。最终冻结全量另记 `full-tests-release-60.log`，未完成前不宣称通过。

最终冻结全量已于 2026-09-19T06:19:35Z 前完成：**1026 文件、9059 测试，9050 pass / 9 skip / 0 fail / 0 cancelled**，退出 0；104 个隔离 UI 文件全部完成。以 `full-tests-release-60.log` 为本地最终记录，不能替代后续同一版本的远程 Release CI 和下载资产核对。

### 同毫秒分支排序测试追加

v0.11.60 的 Release coverage job `105852847527` 和 Ubuntu job `105852847545` 均已通过（coverage 总计 78.57% lines / 78.06% branches / 78.45% functions）。但同一 SHA 的 main CI coverage job `105852858161` 失败；实际唯一失败是 `tests/sessionBranches.test.js` 的分支摘要有序断言，证据保留于 `coverage-60-main-job.log`。

生产查询明确按 depth、forked_at/created_at、session id 排序。原测试连续两次调用 `forkSession` 的默认 `Date.now()`，错误地假定每次调用时间必然递增。若落在同一毫秒，词典序更小的第二个分支正确地排在前面。日志中源正文、两个分支的内容、摘要、角色和消息数均正确，只有列表顺序与测试假设不同。

将 `Date.now` 冻结后，旧测试稳定复现相同失败（`branch-order-frozen-red.log`）。修复只给原正文用例显式不同时间，并增加故意逆序插入、同毫秒兄弟和更早时间孙分支的行为测试；从根及每个分支读取同一有序树，保留跨 owner 拒绝及源正文不变检查。没有修改生产排序、添加 sleep、排序实际结果来掩盖问题或移除既有断言。固定时钟下 2/2、完整分支文件 7/7 通过，定向 lint 通过。

已在打包/发布前取消 v0.11.60 Release run `35426341193`，未生成公开 Release，保留标签和失败证据。v0.11.61 是仅含此测试确定性修复及版本/文档同步的下一候选，须按原门槛重新完成远程验收；不把上一版本成功的 coverage 当成它自己的结果。

后续 v0.11.60 main Windows job `105852858112` 已完整通过 1026 文件，日志 `windows-60-main-job.log` 确认真实短路径、大小写、HTTP 签名桥接、PPT 生成与 LF checkout 用例均执行通过。v0.11.61 提交前分支/恢复/客户端/真实 UI/发布策略关联 9 文件 46/46；全仓 lint、typecheck 及 14 个反向 fixture、debt、依赖清单和复杂度检查均通过。独立只读复核确认原断言完整保留，depth/time/id 的各级优先级分别由新旧用例守护。冻结全量仍另用 `full-tests-release-61.log`，以实际结束结果为准。
