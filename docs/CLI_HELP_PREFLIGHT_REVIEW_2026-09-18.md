# CLI 帮助、启动预检与错误呈现复审（2026-09-18）

基线：`8e32538`，v0.11.56，开始时工作区干净。只按真实调用链修复；保留既有权限、审批、未知结果与 owner 边界。本轮未实现新的 CLI RPC、未开展外观迭代，也不据行数或测试数量声称追平 Pi。

## 一、审查结论校正

- 子命令帮助缺失属实。真实 CLI 子进程的首轮帮助回归 11 组中 10 组失败；不仅是缺少文档，错误分发确实拒绝合法 `--help`。
- goal 的必要参数在身份/DB 初始化之后才检查属实。trace 的问题比环境提示更大：旧实现直接 `getDb()` 和 `bootstrapAuth()`，会迁移数据、选择/创建本机身份和登录会话，并非真正只读。
- 当前语言约定是 **zh/en**：AGENTS 第 5 节、`shared/productLanguage.js` 和 DEBT-I18N-002 一致，旧 ja/ko/zh-TW 偏好归一到 en。不是五语遗漏。
- 没有独立证据支持“2072 处用户可见中文”。词法命中不能证明字符串可到达用户界面；现有前端门禁统计 CJK 字符基线，更不能拿来当 server 可见错误数。DEBT-I18N-001 关闭的是新 Turn failure 写入 code-only 与兼容回放边界，不是承诺所有 server 日志、密码 API、模型提示词都已翻译。
- 既有 HTTP v1 SDK（含 start/events/wait/cancel/resume/steer）和 CLI text/JSONL 不等于 Pi 式 CLI JSON-RPC；后者仍未提供，不能把 MCP 内部 JSON-RPC 当作已完成。
- 之前已有真实免费本地 run、PTY chat、工具、RAG 和网页取消/继续验收。“未做 live paid-provider”不等于“从未真实模型验收”；旧记录也不能替代本轮代码的新冒烟。

## 二、本轮实现

### 无副作用的统一帮助

`commandHelp` 在 main 命令分发前处理上下文帮助，覆盖 22 个命令/别名路由、6 个分组，支持 `--help`、`-h`、`help <command>` 与分组帮助。使用真实命令 parser / 共享选项声明，而不是旁支白名单；不把未知命令或非法参数变成成功。保留 `--`、选项值及 `run help` 的字面语义。

真实子进程回归用导入、网络、stdin 护栏及独立空目录证明帮助不启动 runtime/DB、不开网络、不取输入、不读 steps 文件。stdout 写失败只传播一次，不误判成 run 用法错误后再次输出。

### 参数前移、配置与身份快照

- goal/memory/trace 的缺参、重复/不支持选项、互斥条件、安全整数、steps JSON 与文件预算在配置、身份和存储初始化前拒绝；坏配置不能掩盖用法错误。
- goal 的命令级选项不再“接受但忽略”；list 的 session 过滤真正透传。steps 文件最多 1 MiB/64 步，读前/打开后/读后验证普通文件身份与稳定性，不阻塞读取 FIFO，不随错误内容回显敏感原文。
- `.env` 缺失诊断默认改为英文，新增 caller 级静默选项，不改变配置层或吞掉坏 JSON。goal/memory/trace 不再打印不适用的可选文件警告。
- `resolveLocalRuntimeIdentity` 同时返回 owner 与冻结配置快照：认证使用解析后的 AUTH_MODE / LOCAL_USER_ID，memory reindex 消费同一份 embedding 配置。避免身份用原 env、存储用解析 env 的分叉；配置变化不在同一命令内被二次重读。

### 真正只读的 trace

复用既有不可变 SQLite / 有界内存镜像诊断 reader 与异步作用域。只读取已有本机身份，不调用可写身份引导；不初始化/迁移数据库、不创建 WAL/SHM、不恢复 journal、不回写凭据，不改变并行运行时的数据库单例。

缺库、缺身份、旧/不兼容 schema、活跃 WAL、热日志、未完成配置事务和源文件变化均有阻塞码。明确 session ID 也不能跨 owner 读取；错误不回显原始 SQL、配置内容或系统错误文本。

另复现了 `--limit > 2000` 仍被底层单页上限截断的问题：现在按总预算分页并额外探测一个事件，返回 coverage/truncated，text 和 OTLP 同步提示。不把部分事件聚合当作整个 Turn 总量。

### 最小高频 i18n 修复

- 补 `AUTH_MAIL_NOT_CONFIGURED` 的双语登录提示。
- 审批 Inbox / Chat / 设置使用共享 code/HTTP 状态映射与安全兜底，不把原始后端 message 或 JSON parser 原文直接显示给用户。
- HTTP 200 的 expired / alreadyDecided 按真实持久化回执提示；保留原 Promise、清理和权限语义，不增加批准/拒绝、不自动重试。旧 owner/旧 Turn 的晚回执不能覆盖新提示。
- 未全仓机械替换中文。无 UI consumer 的密码 API 稳定码仍是后续独立工作包，不能混称高频可见缺陷已全部清零。

## 三、验证与失败记录

定向记录：帮助 Node22 / Node20 最终各 12/12，既有 CLI 3 文件 101/101；本地命令专用 5 文件 18/18；只读 trace/身份/配置/Doctor 6 文件 43/43；i18n consumer 7 文件 90/90，i18n 门禁 23/23。不同命令有重叠，不相加冒充互不重复总数。

保留的红灯包括帮助缺失、启动前预检、runtime env 2 项、只读 trace 9 项、memory 配置快照及审批已决回执。第一次 trace 修复复测仍有 3 项失败：测试创建 session 时留下异步 lifecycle hook，在 fixture 关闭 DB 后又重开可写单例；已改为事务型 fixture 写入，继续保留文件/sidecar 字节不变断言，而非删掉失败检查。

最终全量与综合门禁如下，执行环境为 Windows / Node.js v22.20.0：

| 检查 | 实际结果 |
|---|---|
| `npm test` | **PASS，1005 文件**：905 个常规文件 + 100 个隔离文件；TAP 进程汇总 8939 项，8930 pass / 9 skip / 0 fail / 0 cancelled |
| `npm run lint` | 0 error / 0 warning |
| `npm run typecheck` | 通过，14 个非法调用 fixture 正确拒绝 |
| `npm run audit:functions -- --check` | 0 复杂度违规 / 0 parse error；未改门槛或豁免 |
| `npm run deps:check`、`npm run debt:check` | 通过，debt 13/13 |
| `npm run i18n:check` | 23/23，保持 zh/en 对称 |
| `npm run eval:offline` | 61/61，网络护栏及临时数据隔离 |
| 隔离 Vite 生产构建 | 10.13 秒通过；禁用 dotenv/envDir，产物只在临时目录，未创建运行时数据库 |
| 差异与冻结检查 | tracked 差异检查通过，13 个新增 JS/JSX 文件无尾随空白/多余 EOF；28 个本轮源码/测试文件均未在全量启动后修改 |

9 项 skip 为现有环境或已登记限制：LibreOffice 缺失、当前 Node22 跳过 Node20 专属 Ink 入场用例、文件系统不区分大小写、4 个 POSIX 专属测试及反馈面板已有 skip 的两个入口。本轮没有新增 skip、删除断言或把模拟网络通过称作真实厂商回归。源码之外只在测试结束后补充本文和 CLI 用法说明。

日志根：`C:\Users\21161\AppData\Local\Temp\gugo-cli-help-preflight-e65bc2b4dc5c4270b90035c270b3408e`。本轮未调用真实付费模型、未提交/推送、未打包/发布。基线仍为 `8e32538`；构建产物不是新发布包。

## 四、本轮真实本地多轮冒烟

使用已存在的 LM Studio `qwen/qwen3.5-9b`（Q4_K_M）权重，临时 identifier `gugo-cli-help-e65bc2b4`，上下文 16384。独立 runtime / SQLite / task workspace，净化子进程环境，唯一 Provider 是 `127.0.0.1:1234`，本机出站策略开启，没有云凭据、下载权重或 Gugo HTTP 服务。

通过真实 Windows PTY 启动 `gugo chat`（readline、plan 模式、每 Turn 180 秒 deadline），完成：

| Turn | 实际回复 | 独立持久化核验 |
|---|---|---|
| `970eaf07-ac9f-4fb3-a6c5-4d54c8fb518d` | `READY` | completed，1 次模型请求，wire 2 messages |
| `593ee533-aa7a-41a5-8d38-b7e0d891e1a1` | `CLI-SUNRISE-918` | 准确复述上一轮口令，completed，wire 4 messages |
| `20be74cc-51e9-42f9-97a2-70ac7d7790a6` | `15` | 完成新问题，completed，wire 6 messages |

同一 session：`9ca9e01c-a6a9-45e3-968c-d5c87d627faf`。3 次独立模型请求、3 个 completed、0 failed/cancelled、0 工具调用；`/exit` 退出 0。终态来自只读 DB 查询，不只采信终端文案；证据见 `live-durable-evidence.log` 与 `live-terminal-transcript.txt`。本任务模型随后已按精确 identifier 卸载；没有停止既有 LM Studio 服务或干预 Pi。

第一次自建隔离启动器把 `MODEL_FIRST_TOKEN_TIMEOUT_MS` 误判为 token 凭据，在 CLI 启动前被保护断言拒绝；改为精确凭据后缀检查后重跑。该失败不是一次模型请求，更没有被算作通过。

这是单个真实本地模型的无工具多轮 smoke，不是跨厂商基准、真实 KV 命中或复杂任务完成率，也不是实体键盘/全终端验收。CLI RPC、跨 Turn 缓存历史、Node20 原生 SQLite、ANN 大库性能与额外独立进化 holdout 仍按既有边界登记。
