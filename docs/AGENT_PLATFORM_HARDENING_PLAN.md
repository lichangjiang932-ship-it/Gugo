# Agent 平台加固计划

状态日期：2026-09-10。本文区分已落地代码、可执行评测能力和仍需后续设计的工作；测试通过不等同于真实模型任务成功率。最新验证与未授权动作见 [交付验证记录](./DELIVERY_VALIDATION_2026-09-10.md)。

## P0：建立可信交付与测量基线

| 工作 | 状态 | 验收 |
|---|---|---|
| 零 warning、零复杂度违规 | 已完成 | `npm run lint`、`npm run audit:functions -- --check` |
| 生产依赖高危漏洞门禁 | 已完成当前闭环 | `sharp` 升至 0.35.4、`js-yaml` 锁至 4.3.2；`npm run audit:prod` 仅保留两个版本锁定且 2026-11-06 到期的 `image-size` 上游例外 |
| 确定性回归 | 已完成 | `npm test` 与 `npm run eval:offline` |
| 真实模型任务评测入口 | 已完成基础入口 | `GUGO_LIVE_EVAL=1 npm run eval:live -- --dataset <file>`；复制工作区、真实 Headless Turn、外部确定性 verifier；记录 Provider/模型、模型请求、工具调用、审批、重试、usage 与 false completion |
| 代表性公开任务集与基线分数 | 已完成 starter suite，基线待实测 | `evals/starter-suite.json` 提供 3 个故障修复任务，验收脚本位于可变工作区外且基线确认未解；同模型、同提示、同机器的真实 pass rate、耗时、工具调用与人工介入仍须显式付费/本地模型实测 |
| 可重现提交和桌面包验证 | 按最新源码重新验证；安装/卸载及提交待授权 | 旧快照和旧安装记录不替代最新结果。当前 tree、实际路径数、完整门禁、unsigned package、ASAR、unpacked chat/Agent 与真正 OOPIF 的证据统一见交付验证记录；用户文档不入候选，未执行 commit/tag/push/release |

## P1：提高任务完成率

| 工作 | 状态 | 验收 |
|---|---|---|
| Connector/Browser 渐进披露 | 已完成 | 无关已连接应用和浏览器工具不进入本轮；显式意图及历史调用可恢复 |
| 通用工具搜索与动态激活 | 已完成当前闭环 | `search_tools` 只搜索宿主已授权的 deferred catalog，按需增量激活并持久化；不会挂载未请求的产物生成器，激活也不等于执行审批。生产聊天初始 schema 已收敛为普通问答 4 个、纯 Web 6 个、常规代码修复 15 个；MCP、运行时插件和专用静态工具默认 deferred，可由明确意图、历史调用或精确搜索恢复。缺少 `search_tools` 的旧/自定义目录保持完整兼容，避免能力被不可恢复地隐藏 |
| General Subagent 独立验证 | 已完成基础闭环 | 增加 shell、command、test、project-check、git status/diff；仍走父级权限、审批、checkpoint 和 ledger；`remember` 仅保留给 general，explore/plan 不再拥有持久记忆写权限 |
| 项目指令与 Turn 目录一致 | 已完成 | 用户、并发 Turn、主/子代理读取同一授权目录 |
| 安全指令文件 | 已完成 | README 不再提升为 system；支持 `AGENTS.override.md`，显式子目录可分层加载 |
| 多语言明确文件修改 | 已扩展 | 六种语言常见直接命令进入执行证据门禁；复杂语义仍依赖显式 intent |
| 内置 Skill 服务端推断 | 已完成 | Web、CLI 与 API 对高置信度内置 Skill 使用同一共享规则；导入 Skill 仍需显式选择 |

## P2：扩展通用任务覆盖

| 工作 | 状态 | 验收 |
|---|---|---|
| 任意 Skill 搜索/激活 | 已完成基础闭环 | 模型可从 metadata catalog 调用只读 `load_skill`；宿主重新校验当前用户所有权并把完整指令作为独立 system block 注入，tool result 不含指令；激活状态和可信 block 随 checkpoint 恢复，单 Turn 最多 8 个 |
| 浏览器复杂工作流 | 已完成当前基础闭环 | 已支持经授权、100 MiB 上限、逐次高风险审批的单文件上传；有界遍历 open Shadow DOM 与同源 iframe；`browser_tabs`/`browser_switch_tab` 可发现并切换 popup/tab；`browser_frames`/`browser_switch_frame` 通过精确 frameId、独立 CDP isolated world、URL/SSRF 与 connected-app 所有权复核支持跨源 iframe，导航后旧 context fail closed 失效；未授权 tab/frame 均脱敏。`browser_download` 仅原子发布一个有界完成文件并记录 SHA-256。真实本机 Chrome 已完成同源/跨源 iframe、Shadow DOM、模拟登录、popup/tab、上传、下载、截图和服务层 DOM 操作烟测；真实认证外部站点的系统化评测矩阵仍待建设 |
| 消息节点分支 | 已完成当前闭环 | 可从已持久化的 user/assistant 消息节点分叉，废弃后缀不会复制；工具 trace 去除可恢复身份后保留；聊天头部可加载用户隔离的分支树、显示有界最新消息摘要并导航。分支树现在仅从成功工具结果中的 `changedPaths`/`verifiedOutputs` 提取文件操作，按原始消息 provenance 与直接父分支做精确差集；Provider 重复 tool-call id、多层分叉、DTO 白名单、数量上限及证据不完整时 fail-closed 均有回归覆盖 |
| 通用 SDK/RPC | 已完成 JavaScript / Python HTTP SDK v1 | `gugo/sdk` 与随仓库/npm 包分发的零依赖 `sdk/python/gugo_sdk.py` 共用无内部 service/SQLite/UI 依赖的版本化 HTTP/SSE 语义，覆盖 Turn 启动、查询、带压缩水位连续性校验的轮询与 SSE、引导、取消和恢复；请求携带契约版本并保留稳定服务端错误码。两种客户端拒绝 URL credentials、限制请求/响应并独立执行总等待 deadline；Python 默认仅允许同源重定向，跨源目标在收到 Authorization 前以 `GUGO_SDK_REDIRECT_DENIED` fail closed；当前不是 PyPI 包，其他语言绑定待建设 |
| OS 级隔离 | 已完成可选 Docker Shell 当前闭环 | `SHELL_SANDBOX_MODE=docker` 将每次非持久 Shell 固定放入禁网、禁 pull、只读 rootfs、drop-all capabilities、no-new-privileges、限 CPU/内存/PID 的新容器，仅挂载当前授权根；`SHELL_REQUIRE_OS_ISOLATION=1` 禁止 host 回退并强制镜像 SHA-256 digest；Docker CLI 使用绝对可执行路径且 `--host` 只接受本地 socket/named pipe。真实本地 daemon 与 digest-pinned Ubuntu 镜像已验证成功写入、实际 HostConfig、取消和零残留；每次容器使用随机宿主名，中断/异常后显式 `rm --force`，清理失败以 `PROCESS_TREE_CLEANUP_FAILED` fail closed。容器逃逸防护、插件进程隔离及其他 OS 后端仍待建设 |

## Live eval 数据要求

真实能力报告至少分开记录：

- 任务是否通过确定性 verifier；
- 首次成功率与重试后成功率；
- 模型、Provider、上下文窗口和权限模式；
- 模型调用数、工具调用数、耗时和人工介入次数；
- 假完成、误拒绝、错误工具选择和恢复失败。

详细格式见 [LIVE_AGENT_EVALS.md](./LIVE_AGENT_EVALS.md)。没有真实运行结果时不得填写或推断 Gugo/Pi 的成功率百分比。
