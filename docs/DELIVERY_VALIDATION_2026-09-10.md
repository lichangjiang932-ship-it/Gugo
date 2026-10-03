# 最新交付验证（2026-09-10）

对象：v0.11.56，feat/ui-prompt-experience-20260906 的当前候选树；HEAD 仍是 8389ca3。本文不把旧安装包、旧 gate 或脚本化模型结果当作最新真实能力证明。

## 本轮实际修复

1. durable Agent Event 类型增量中的正向 fixture 有隐式 any 参数，导致 typecheck 失败。已将监听器输入标注为 unknown；14 个负向 fixture 与对应运行时回归通过，没有关闭 strict/checkJs 或增加 any 豁免。
2. 真正 OOPIF 实测发现主页面 FrameTree 不含独立 iframe Target。已补只接纳当前页面父链下 Target 的有界发现，授权后才 attach，DOM/上传调用经独立 CDP session 路由。导航失效、非所属 Target、授权拒绝、旧 URL 和断开的 session 均有回归；没有绕过 URL 或 connected-app 权限。
3. 完整回归发现 modelPhaseHeartbeat 对同一进度读取两次时钟，跨毫秒时把刚收到的进度记成非零 idleMs。改为使用进度发生时的单一时间戳；新增每次读取均递增时钟的确定性回归，保留 idleMs=0 的原断言。定向 heartbeat / 真实 CLI 流式回归 7/7 通过。
4. ASAR 必需文件清单补入 durable consumer support、frame 和 upload 模块，并同步精确清单测试；上传协议绑定抽到独立 adapter，保持原有复杂度/行数门禁。
5. 明确区分已执行门禁和仍需现场授权的安装、卸载及外部模型任务；不再以旧候选文件数说明新快照。

## 依赖例外复核

- npm registry 当前 image-size 最新版为 2.0.2，但两项公告的影响范围仍为 <=2.0.2：GHSA-w3rx-r6r6-pgpr、GHSA-5p2g-fcmc-qvqq。
- 曾做父依赖范围内的 2.0.2 试升，真实 PPT 图像输出可通过，但生产审计仍报同样漏洞。试升及撤销例外的实验均已撤回，package.json/package-lock 保持试验前的候选版本。
- 继续锁定 image-size 1.2.1 / pptxgenjs 4.0.1 的两个临时例外，截止日仍为 2026-11-06，未延期。审计在既定例外下通过，不是零漏洞。
- 未采用 npm 建议的 pptxgenjs 1.1.5 跨大版本倒退；也没有用重命名、未验证 fork 或忽略扫描伪装修复。

## 验证范围

| 事项 | 结果 |
|---|---|
| 类型与负向 fixture | typecheck 及 14 负例通过；相关运行时 20/20 |
| 完整回归 | 最终候选 897 文件通过；包括 OOPIF 和进度时钟修复后的重新验证 |
| 离线评估 | 14 套件 / 60 场景通过；不是 live Provider 基线 |
| lint / 类型 / 复杂度 / 代码债 | 已执行；最终结果见终验 |
| 生产审计 / 许可证 / build / desktop check | 已执行；审计保留上述两个严格例外 |
| Windows 包 | 使用显式 unsigned 配置、publish never、新输出目录；未覆盖旧包 |
| ASAR 与 unpacked chat/Agent | 已实跑独立数据目录和本机 mock Provider；chat 无工具，Agent 实际读取 fixture.txt 并完成 |
| 最新 unpacked GUI | windows-delivery 包免登录打开；已通过原生 GUI 输入、点击发送并显示回复，未调用真实 Provider；不是 installed 验收 |
| OOPIF | Chrome 强制 site-per-process；必须看到独立 type=iframe Target，并在其 session 中读取/点击；仅跨端口同进程 iframe 不算该验收 |
| npm pack / tree | 从最终候选索引导出并记录；详见终验/外部快照清单 |

## 本轮没有执行或不能宣称完成

- Windows 安装与卸载：computer-use 技能要求动作发生前现场确认；尚未执行本轮安装/卸载，不把 unpacked 当作 installed。
- 真实模型 starter suite / SWE-bench：未选择和授权真实 Provider、模型及资源预算；未发起收费模型请求。
- commit、tag、push、release：没有授权，不执行。
- DEBT-TYPE-001 仍 Open：本轮类型边界改进不代表 persistence、SessionAdmin 和 runtime policy 全部进入严格类型检查。
- runtime plugin 的 OS 进程隔离、容器逃逸防护及其他 sandbox 后端未据此完成。
- 浏览器真实认证外部站点矩阵未运行，未操作用户个人浏览器资料或外部账号。

## 快照边界

仅把候选源码、测试与文档纳入索引。docs/GPT-6-Astra-Introduction.md 是原先排除的用户文档，继续保留为未跟踪，不用修改 ignore 或删除文件制造“零未暂存”。零未暂存指已跟踪候选文件的 diff 为零；排除项单独列出。

最终 tree 与制品哈希写入 .artifacts/validation-20260910/snapshot.json，避免在 tree 内写入自身 hash 的循环引用。npm pack 以候选 Git tree 导出的源码/SDK目录执行，不混入原工作区的未跟踪文档、数据库或运行日志；不宣称它是预构建 Web 发行包。

## 终验

- 最终运行时代码已冻结；Windows 输出目录为 `.artifacts/validation-20260910/windows-delivery`，23 项 ASAR 清单通过，1,027 个包内运行时文件与工作区源码逐字节一致。
- 最终包健康检查、chat/Agent、真正 OOPIF 读取与点击通过。API 烟测数据位于 `desktop-run-kzoY8o`；GUI 输入发送验证数据位于 `desktop-run-2Yq0fZ`，均在本次验证产物目录中，与用户正常数据隔离。
- `typecheck`（含 14 个负向 fixture）、零 warning lint、复杂度（7,954 函数、0 违规、0 解析错误）、代码债 13/13、desktop check 71/71 通过。
- 离线评估 14 套件 / 60 场景通过（Node 汇总 61/61）。生产审计在两个原例外下通过；333 个生产包许可证通过；生产前端 build 通过。
- 最终完整回归 **PASS（897 个测试文件）**，八批普通测试和 99 个独立 UI 测试均通过；保留已有 skip，不把 skip 算作通过。完整日志：`../output/Gugo-validation-7f24b58a-c7e2-4636-8449-e073036c9392.log`。此前清单断言不匹配及进度时钟失败的运行不记作通过。
- 当前候选相对 HEAD 为 **440 个变更路径**，包含用户此前暂存的累计改动，并非本轮新改 440 个文件。最终 tree、总文件数、零已跟踪未暂存差异、源码包及 Windows 制品 SHA-256 由外部 `snapshot.json` 记录；未提交、未打 tag、未 push、未发布。
