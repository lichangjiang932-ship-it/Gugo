# CLI 优先修复执行记录（2026-09-18）

## 边界与基线

- 用户已授权按照审查计划实施。保留全部既有 dirty 改动；不自动提交、推送、发布、修改凭据或调用收费模型。
- 接手核对：Pi 对应会话最后为 assistant/stop，最后写入 2026-09-17T04:32:30.897Z，原 Pi 进程及其子进程均不存在。
- 本次之前的全量回归只代表当时的代码。新增输入、附件、会话搜索和 MCP 改动需重新验证。
- 默认本地免登录和目录/工具/审批/未知结果边界保持不变。readline 仍是默认输入层，Ink 先作为可回退选项。
- 所有实现用 apply_patch；行为测试使用隔离临时数据目录和假网络，真实模型/终端结果单独记录。

## 工作包

1. **已实施：CLI 入口**——会话搜索真实存储消费、附件、Provider+模型绑定、输入所有权与历史。
2. **已实施：输入与工具协议**——字素/显示宽度、可选 Ink 适配器、Windows MCP 启动、schema 失败关闭。
3. **已实施本轮工作包：记忆与核心闭环**——词法候选/规范化、去重、后台语义记忆、loop/恢复/上下文与请求观测；不等于全部长期能力建设已完成。
4. **已完成本轮验收**——定向、真实本地模型/工具/RAG 演示、两次 992 文件全量及工程门禁已记录；末尾网页取消补丁另有专项回归。
5. **已完成本轮网页与分发**——功能一致性、真实生产网页与取消/继续、干净 R2 Web 验证包；无外观迭代或正式发布。

## 执行结果

### 已验证的增量（整体仍进行中）

- 搜索：先得到 3 个红例，改为复用 canonical messages 的 FTS 查询，含准确总数、稳定分页、owner/session/归档作用域及终端控制字符过滤。含 2005 条历史的关联 3 文件 18/18 通过；尚未把 Unicode/中文索引优化列为已完成。
- 输入子任务：完整字素前删/移动、视觉列、CRLF、显示宽度折行、非光标行重复、resize、可选 Ink adapter 和终端探针。6 文件 44/44；真实 Windows PTY 两轮输入/增强 Ctrl+J/取消退出通过，实体键盘及全终端矩阵未实测。
- 依赖：显式添加 string-width 8.2.2、Ajv 8.17.1、ajv-formats 3.0.1，Ink 7.1.1 改为精确可选依赖，React/DOM 19.2.6 保持不变。安装禁用生命周期脚本，没有更新全局工具或凭据。
- Windows MCP：先真实复现 node→node.cmd 的 EINVAL，改为可信 exe/npm CLI 解析且保持 shell:false、allowlist、环境净化。10 文件 88/88；本地 Node fixture 和 npm/npx 离线版本探针通过，没有下载 MCP 服务。
- 工具 schema 子任务：统一资源有界 Ajv 校验和动态注册预验证，非法 union/const/allOf/local-ref/第 201 项不进入审批或执行；64/64 builtin 编译。14 关联文件 262/262，另 plugin/registry/risk 6 文件 35/35。远程/递归引用与不支持的复杂 schema 明确拒绝，不静默放行。
- 模型入口：结构化 Provider+model，读取当前本地身份的配置而非裸 HTTP；缓存按 owner/runtime 隔离且不可当执行授权；picker 先 suspend 主输入并复用注入终端。新目录+历史+chat 关联 45/45。
- 历史：独立职责模块，重启加载、owner 分区、原子写入、大小限制、关闭后不重开。测试曾因 TERM=dumb 和把 Up 重绘当新提示而失败，改为明确模拟终端和实际第二次 Turn 事件，未减弱历史/审批隔离断言。
- 附件：run/chat 传显式文件请求，由认证后的 host 流式存入 managed attachments 再传 ID；resume 冲突提前到 argv 阶段；新增 /attach、/attachments、/detach。清理用 unbound 快照 CAS，不删除已绑定回执。关联入口/模型/存储 13/13；headless/存储 32/32。开发中出现过 descriptor 关闭顺序和 duck-typed signal 兼容失败，均修复后复测，不将中途失败记作成功。
- v120 记忆索引迁移已注册；新派生表及 pending 队列不删除旧记忆。主线新增列/索引/失效 trigger 契约；原主键/唯一键检查按职责抽成独立模块，保留原导出，未加尺寸门禁豁免。

上述是早期整合记录，计数只代表对应当时命令。后续增量如下；尚未以这些定向结果代替最终全量与网页验收。

### 后续整合、反例与修复

- Pi 再核对：新交互进程存在，但对应会话只有模型/思考级别设置事件，最后实际消息仍为 `2026-09-17T04:32:30.896Z assistant/stop`，没有新工具回合或执行子进程。未干预或停止 Pi。
- Unicode 搜索补齐中文子串、NFKC/组合字符、字面 `%/_` 和有界续查；保留 FTS 远历史排序，两路去重。游标绑定 owner/session/query，数据库可见写入使其保守失效。底层双驱动各 30/30；另补真实 chat `/search --cursor` 入口透传测试。
- 后台记忆：Job/subagent 新任务只准备一次向量与空间身份，恢复已有上下文不重复 embedding；冻结环境并透传取消、memoryIds 和脱敏诊断。10 文件 135/135。
- v120 派生词法索引、失效队列、keyset 续建与精确 title/slug/置顶独立召回；记忆去重在事务中收敛，不把扫描未完成当作不存在。Node SQLite 返回 `Uint8Array` 导致向量反序列化丢失已以红例修复为 BLOB 兼容 Buffer。驱动 5 文件 39/39、Node 记忆 6 文件 90/90。
- 请求观测：最终适配后的 wire body/prefix/tools 指纹与 owner/endpoint/model/config 身份关联，绑定 modelRequestId/physicalAttempt；durable 写入失败在 fetch 前以 not_sent 终止。14 文件 229/229。指纹不是 KV 命中，缺失的 Provider cache usage 保持 unknown。
- Doctor 默认只读：不初始化/迁移 DB，不创建 WAL/SHM、账户或凭据，不探测模型。活跃 WAL、热日志、读取预算、源文件变化均有明确诊断；`--probe` 是显式探测，`--integrity` 是显式完整检查。默认/Node 驱动各 9 文件 67/67，独立只读复审 6 文件 45/45。旧迁移 fixture 的 v120 触发器依赖已修正，保留原契约断言。
- 测试入口漏洞：原“一个有效路径＋一个不存在路径”能误报 PASS，已复现后修为启动 worker/创建 DB 前退出 2；合法显式路径、别名与规范化去重保留。4 文件 39/39。
- managed 附件真实 CLI 子进程＋隔离 SQLite＋仅回环模拟 Provider 验证：文本/图片真正进入 wire，不支持图片时零模型请求并清理，2/2。不是实际模型图片能力验收。
- 上传取消红例：Node 文件流将本轮 reason 包成 `AbortError/ABORT_ERR`，导致 chat 退出。现在只在上传边界、完成清理后展开精确 cause，保留无关错误/清理聚合错误。命令续查、取消、附件相关 5 文件 24/24。
- 模型目录复审：保存的 Provider 曾隐藏命名环境 Provider，限定选择失败时误作裸模型名。按 canonical 配置合并后，本地 Provider 保留，删除/禁用/错误限定选择在 CLI 拒绝。**最终发送层原已有模型允许列表拦截，因此不能声称旧行为导致实际外传；按 P2 记录。** 相关 43/43，完整本地模拟发送链双 SQLite 驱动各 12/12。
- `chat --timeout` 曾解析但未消费：已逐 Turn 实施，覆盖审批、目录授权与未知结果确认；先到取消原因优先，等待清理、不重试。run/chat 共享 deadline 终态判定，不能用 timeout 覆盖持久化错误或更具体的 blocked/unknown；run 还释放复用输出流的监听器。chat 关联 68/68；run 关联 80/80，新增共享边界后 5 文件 32/32。
- 第一轮全量属于整合中运行，保留真实失败：包含尚未转绿的模型目录红例；插件 `structuredClone` 丢失深冻结是实现回归，已修宿主副本并保留调用方可变性，原生命周期测试未改，相关 233/233。后台 Job 测试误把 transport `userId:null` 当逻辑 owner，现用真实 `usageOwnerId` 并增加逐请求跨用户隔离断言，24/24。异步 session 降级本身正常，测试仍期待原始异常文本；改为精确安全错误码并补脱敏/日志失败回归，30/30。未删除断言或恢复敏感日志。

### 真实本地验收（隔离、免费、未调用云模型）

临时证据根：`C:\Users\21161\AppData\Local\Temp\gugo-cli-acceptance-e21d35d7827c4bdcb69c2a302be2b13d`。独立 profile、工作区、数据库及产物；网络 guard 只允许 `127.0.0.1:1234`。仅加载本机已有 LM Studio 模型，没有下载权重或修改真实 Provider 凭据。

- `qwen/qwen3.5-9b`，有效窗口 16384。`run --file` 读出 managed 文本附件标记 `LOTUS-918-CJK`，completed/exit 0，无工具调用。
- 真 PTY chat 连续记住 `IRIS-918`；`/search` 返回准确分页，`/model` Picker 能恢复主输入并绑定 `acceptance` Provider，`/exit` 退出 0。
- 中途 TTL 卸载导致一次真实 `MODEL_NOT_LOADED`，只发生一个物理请求，无自动重试、无假完成。重新加载相同本地 identifier 后，新一轮仍正确复述原标记。失败记录保留。
- 只读工具任务：`list_directory` → `read_file` → 正文，3 次模型请求/2 个成功工具，返回 `LOTUS-918-CJK`。工作区只有原 marker.txt 且字节未变。后两轮请求 prefixChanged=false；Provider 未报告缓存命中计数，KV 命中未实测。
- 独立 DB v120 quick_check=ok、foreign_key_check=0；附件绑定记录保留。公开结果与关联 ID 保存于 `logs/acceptance-evidence.json`，不公开 reasoning 事件。
- `doctor --headless --json --integrity` 真命令 exit 0、probe=not_run，SQLite quick/integrity/FK、FTS、memory index 通过。前后 10 个数据文件 SHA256/路径完全一致。合并 stdout/stderr 的演示解析曾被 Node 实验性警告干扰；读取独立 stdout JSON 后确认报告正常，这是验收脚本问题，不是 Doctor 输出协议失败。
- 使用本机已有 `nomic-embed-text-v1.5` 真 embedding，768 维：实际 CLI 默认重建 2 条 global、重复重建 0 条、`--all-agents` 再补 1 条 agent 记忆；另用户相同正文不串读。语义首位召回 House style，空间 revision 变化拒绝旧向量但词法召回仍可用，编辑正文后旧向量被排除并重建 1 条，SQLite 检查通过。见 `logs/rag-evidence.json`。这是小样本检索链路验收，不是大库召回率/ANN 性能评测。

### 当前保留的限制

- 门禁与本轮网页/分发结果见下面的冻结及 R2 记录；9 月 17 日旧 ZIP 和本轮首包不代表最终推荐代码。
- 没有声称全部长期能力建设完成：大规模 ANN、计划 rewrite 差异映射/限额、额外 holdout 自进化验证仍需后续有界工作包。没有扩张工具权限或让自进化自动越权。
- 实体键盘/全部终端矩阵未覆盖；readline 默认不变，Ink 是可回退选项。Node20 真环境验证另行记录，模拟版本检查不等于真实运行。

### 冻结门禁与网页验收记录

- `full-test-final.log` 与包含网页观测补丁的 `full-test-release-candidate.log` 均真实完成：**992 个测试文件 PASS**，9 个普通批次及 99 个隔离 UI 文件全部通过。未使用此前整合中的失败运行冒充最终结果。
- 最新 lint 零 warning；typecheck 含 14 个反向调用 fixture；依赖清单一致；AST 复杂度 0 违规/0 parse error；debt 13/13；离线评测 61/61；402 个生产依赖许可检查通过。构建成功，desktop:check 71/71。
- 这两次全量后，真实网页取消又发现一个展示缺陷：持久化事件明确为 `turn.cancelled`/`TURN_CANCELLED`，只有 1 次物理请求、0 工具、0 completed，但网页把通用 `turn_incomplete` 展示为“未保留具体原因”。只修网页取消提示优先级，不改变后端终态或重试权限。末尾补丁独立 8 文件 **171/171**（主线另跑 5 文件 **148/148**）、lint/i18n/debt 通过；**没有把前面的全量称作包含该末尾补丁的再一次全量**。
- 网页观测包保留经 schema 校验的 wire/context diagnostics、modelRequestId/physicalAttempt、completionPolicies，复用执行详情显示，zh/en 同步；重试清除旧诊断，unknown 缓存不显示为 0。关联 9 文件 177/177，未改 CSS。后续取消提示保留具体模型/外部副作用 unknown、验证失败与 blocked 的优先级。
- Playwright 真浏览器：本机自动身份免登录，CLI 历史、工具记录能显示；真实模型请求返回 `WEB-918-OK`，0 工具。详情准确显示请求 ID、物理尝试、上下文、记忆召回与“实际 KV 未知”。开发态编辑时曾因 Fast Refresh provider/context 失效出现短暂错误，页面重载恢复；独立生产构建无此错误。
- 首个 Web 包内启动生产服务成功，CLI `--version`=0.11.56、自引用 `gugo/sdk` contract=1；真实浏览器返回 `PACKAGE-918-OK`，0 工具，console errors/warnings=0。运行时数据另置隔离目录；依赖使用独立 staging 中指向已安装依赖的临时 junction，因此**不是一次全新 `npm ci` 安装验收**。
- 首包 2058 文件、15,236,636 bytes，SHA256 `b354da77d64271dff58ff0d78a1e18f88ba88346c345680dfe2f4a73dafe60aa`。它保留上述取消文案失败证据；**最终推荐交付以 R2 包为准**。两包都不含 node_modules、用户 DB、运行时 `.env` 或凭据，不是 Windows 原生安装器、签名包或发布。
- 手工分发检查器曾误把合法 `server/data/agent_templates` 静态模板当用户数据而中止，已收窄到顶层 runtime data 并继续拒绝 DB/key/env/node_modules；历史失败未删。全仓 `git diff --check` 仍有既有 CRLF/尾空白差异；将 CRLF 按 Windows 换行处理后仅剩未在本轮改动的 `server/services/loop/runtime.js` 尾部空行，未借机格式化其它改动。
- 控制 marker 的基线治理写入 AGENTS.md：不准单改数字过门禁；变更必须同时核查 issuer/consumer、信任时序、恢复与行为回归。未改变 marker 基线值。

### Node 20 实际兼容范围

- 官方便携 Node **20.19.0 / win-x64 / ABI 115** 已校验 SHA256 后执行，未改变全局 PATH、Pi 或项目 node_modules。ZIP SHA256：`be72284c7bc62de07d5a9fd0ae196879842c085f11f7f2b60bf8864c0c9d6a4f`。
- `--version`/`--help`、readline/auto 实际输入（禁止加载 Ink）、显式 Ink 的 `CLI_INK_NODE_UNSUPPORTED`、缺 DB Doctor 不建数据均通过。纯行为 8 文件 **72/72**；Node22 相关 14/14。
- 原 69/72 的失败为两个 fake-Ink 测试未注入支持版本和一个测试使用 `Promise.withResolvers`；只修这两份测试，保留原断言及失败日志。
- Node20 原生 SQLite 的独立安装因预编译下载超时、隔离环境缺少 Python 而未完成；真实数据库初始化/迁移/持久化 run **未覆盖**，不能拿 Node22 二进制复用结果或纯测试当成已覆盖。
- 证据：`C:\Users\21161\AppData\Local\Temp\gugo-node20-verification-83785ed858fe4f8382bf360af3a44781\COMPATIBILITY.md`。门禁日志：`C:\Users\21161\AppData\Local\Temp\gugo-sept18-gates-245c4264647b4e15b33954b0a0f3e2f2`。

### 最终 R2 交付

- 文件：`output/agent-hardening-20260918/gugo-0.11.56-web-local-verification-r2.zip`；**2058 文件、15,236,905 bytes**；SHA256：`a876cd847050f867bca38fdcf9890e6af0acd01b14894e8fea73c9a087500a1c`。逐文件 manifest 与 `.sha256` 在同目录。
- 前端从全新 `web-dist-r2` 构建，未混入旧哈希资源；清理前的中间 R2 已原样保存在 `prior-r2/`，没有删除历史失败或覆盖用户文件。最新包的非生成源码逐文件匹配当前仓库，mismatch=0；最终 lint 零 warning。
- R2 包内生产服务再次启动，本机免登录，实际点击停止后正确显示“已停止 / 已按取消请求停止本轮执行 / 部分结果保留 / 未标记完成”。对应 turn `3375fcb8-decc-439c-a828-84df402bc29c` 为 `turn.cancelled`，并保留 224 字符的部分文本。
- 同一会话手动发送下一轮，turn `d7d55357-e684-46b3-b249-016b5684b963` 为 completed，真实本地模型返回 `AFTER-CANCEL-918-OK`。浏览器 errors=0、warnings=0，截图见公开验证证据。未将用户取消变成自动重试或“完成”。
- 本次临时浏览器/服务及本任务的 LM Studio 模型 identifier 已关闭/卸载；用户的 LM Studio 服务、Pi、真实运行时与模型凭据未变。没有提交、推送、发版、重建自动化或修改全局 Node/PATH。
- 本轮工作包已完成，不宣称全面追平 Pi 或所有长期能力完成。实际 KV 命中指标、Node20 原生 SQLite、全新机器安装、完整 Windows 原生安装器、ANN 大库压测和额外自进化 holdout 仍按上述限制处理。

## 验收约束

- 模拟 transport/工具通过不等于真实模型任务通过；前缀指纹不等于实际 KV cache 命中。
- 向量精确扫描、ANN 以及大库性能分别报告；不以计数或模块数量声称全面追平 Pi。
- 任何权限、取消、unknown、持久化失败不得被“必须收尾”逻辑转成新的调用或假成功。
- CLI_READY 前不将后续网页、安装包或发布列为完成。
