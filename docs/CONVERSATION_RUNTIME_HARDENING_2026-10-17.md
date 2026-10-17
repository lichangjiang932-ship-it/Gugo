# 会话并发、实时上下文、写后验收与简洁失败提示

## 范围

用户确认修复四项实际交互：后台会话运行时新会话不能发送、Context Window Usage Ring 不实时、写后验收漏项导致未完成、失败提示过于冗长。保持原页面布局和右上角四入口，保留 owner/目录/工具/审批及完成证据边界，不以“顶级 Agent”为由扩张权限或改造无关模块。开工前外部快照保留原有未提交现场，index 未动，本轮不提交、推送或打包。

## 1. 发送锁与迟到确认

原 `useChatSendFlow` 用一个组件级 boolean 锁，直到整轮流结束才释放；切换会话不会创建新的 Hook 实例，因此 B 仍会被 A 的锁挡住。改为 backend/owner 与 session/draft-version 组合的独立锁，同一作用域仍单飞，A 完成不会释放 B。

另补两条相关竞态：旧草稿 ACK 到达时，只有当前作用域仍匹配才调用清草稿回调/激活；否则通过 `NEW_SESSION activate:false` 在后台保留旧会话，不抢当前新草稿。只读 preflight 迟到且 owner 已变时，不再把旧输入提交到新 owner 的连接。确实被阻止时同时显示 toast 和原工作台状态，不依赖右侧面板是否打开。

入口：`chatSendScope.js`、`useChatSendFlow.js`、`sessionLifecycleReducer.js`、`ChatSplit/index.jsx`。既有 registry 仍按会话注册/取消，切换或卸载不终止其他会话，后端并发限制不放宽。

## 2. 圆环从生产数据实时更新

此前 SVG 能画比例，但仅消费最终 retained 观测；prepared/completed 只被记录，不能驱动当前窗口。持久 Provider UUID 与真实运行时 key 不同时，原匹配还会丢掉有效窗口。

- Host 根据原始持久绑定和 primary physical attempt 确认运行时别名；真正 failover 不套用原 Provider 的窗口。不同 physical attempt 不继承上次实测输入。
- prepared、completed 及工具批次之后的 retained 观测均进入当前计量。completed 包含公开响应，工具结果在批次完成后重新计量，压缩后新请求替换旧窗口基线。
- 真实公开文本流（包括暂存等待完成判定的正文）用共享 token 权重增量估算；只保留数字及至多一个待拼接 surrogate，不复制提示正文。最多约每 200ms 发一次数字观测，不轮询模型、不产生额外模型请求，不逐块重算整份提示。没有采集或输出私有推理正文。
- UI 使用按 request/physical attempt/owner-session 隔离的有界数字锚点，在两次 Host 观测之间补可见增量，避免最新流式消息一变就把 Host 基线永久判旧。草稿/附件仍参与估算；旧历史、累计消耗和 cache 命中不冒充当前占用。
- 分母是当前实际服务使用的有效窗口；估算仍明确标注，未知不伪造。它不是逐 token 的上游精确账单，也不承诺任意模型别名都有经原厂证明的最大窗口。

生产链测试不是手动给 SVG 写百分比：真实 `contextUsageObservation` → `dispatchTurnEvent` → `messageReducer` → Hook → Composer。覆盖 wire prepared、文本 delta、completed、工具结果、压缩切换及 UUID/key 别名。

## 3. 写后验收

“两个文件有可打开的验证收据”不等于整个任务已通过：生成命令可能留下未知 workspace 修改。没有读原会话真实数据库，也没有重跑用户的真实生成任务，所以不声称原截图的具体调用已被重新验收成功。

本轮复现并补齐两条确定缺口：

1. 有明确项目根、命令历史中的规范执行 cwd 也都属于该根、且 canonical `git_status` 已在允许工具内时，Host 才通过原 checkpoint/审批/工具流水线做只读状态解析，把保守 `<workspace>` 转成具体文件，再读回 PPT/helper。缺目录来源或跨 cwd 的未知命令不查另一个已授权项目来充当验收。测试确认生成命令只执行一次，未重跑生产脚本。
2. 模型调用/token 恰好达到上限只应阻止下一次模型请求，不应误挡尚在工具/墙钟预算内的 Host 只读验收；真正超限、墙钟到期、取消、权限拒绝、动态工具替换或未知请求仍不能自动继续。
3. Git 清单可能包含用户之前就修改的凭据/配置。自动内容读取明确跳过常见 .env、credentials、settings.yaml 和私钥/证书条目，仍保留对应 pending target，不把“跳过敏感读取”伪装成通过。这不是完整 DLP，也不替代原路径/工具权限。

未删除 `POST_MUTATION_VERIFICATION_MISSING` guard，未用文件扩展名、成功 exit code 或选中的收据直接清空未知修改。`DEBT-VERIFY-003` 记录非 Git/无权限或既有脏工作区缺少有界变更来源的限制。确实没有证据时仍必须保持未完成。

## 4. 用户要求的提示

普通任务完成判定失败，聊天只展示一条红色提示：

> 任务尚未完全通过验证。已完成的本地修改会保留；请检查后继续。

默认不再展示错误码、原因、缺失项、下一步和重复文件清单。原文件入口各保留一次，可点击；原 message/meta/结构化诊断没有删除，也没有升级为成功。取消、暂停、连接中断、未知副作用/模型请求的必要恢复入口及环境修复提示不混同为普通完成失败，继续保持各自语义。

复用既有双语 `replyPartiallyCompleted` 文案，不抬高翻译模块 600 行上限；旧 UI 测试迁为单行红色/文件可达/诊断保留行为断言，后台失败分类测试继续保留。

## 验收与证据

- 最终定向 21 个测试文件/312 项通过，包含 ChatSplit 300 行边界、阻止反馈 presenter 及共享子代理调度回归。新增复现先失败再修复，包含双会话、旧草稿 ACK、旧 owner preflight、准备/流式/完成/压缩链路、Office/helper 验收以及单行提示。
- 隔离浏览器实际发送 A，保持其 SSE 尚未结束，再新建 B 并发送；B 独立回复时，模拟端点确认 A 仍打开。随后 A 单独完成，B 不被覆盖。
- A 结束前，圆环从约 18.234% 增至 18.919%，来自真实本机 SSE 与 Host 观测；没有手改样式或注入百分比。实测失败摘要色为 `rgb(180, 35, 24)`，保留 2 个不重复文件入口。
- 另模拟同会话 preflight 尚未完成时重复发送，浏览器能看到发送等待 toast，当前草稿未丢失；未提交真实 Turn。
- 模型响应来自自建 loopback fixture，流与标题请求只在隔离 HOME/GUGO_HOME/SQLite/profile 内进行，不是实际 Provider 成功率。真实用户实例 5175 未操作。最终开发 Host 显式 `envDir:false`、关闭 dotenv；自建服务均已关闭。
- lint、类型（18 个负例拒绝）、debt、复杂度、i18n、依赖、许可、隔离 Web build 和离线 71 项通过。
- 条件收尾发现阻止反馈原先只写工作台，在侧栏关闭时不够可见；加入 toast 后废弃早先非冻结运行。全量随后捕获 index.jsx 达 304 行的既有 300 行边界失败，将反馈抽为独立 presenter 并验证双端可见，不抬阈值；又补敏感清单读取保护。中止/失败日志保留。后续一次完整全量仅剩子代理旧“只调用一个命令”的精确序列断言失败；复核新增只读检查的 cwd 来源，补了跨项目负例与规范目录绑定，再将测试改为每个工具范围已获审批、缓存复用有界、只读检查不越项目、生成只执行一次。没有删白名单或权限检查。修复后重新冻结从头运行。终局重新从头 **1193 文件 PASS / 退出 0 / 1290.284 秒**，4254 个源码/配置/资源文件在运行前后 SHA-256 一致（不含 docs、.agent、.claude 与敏感/运行时路径）；见 [验收记录](review-evidence/conversation-runtime/verification.json)。没有用之前的失败或中止运行代替终局。

持久证据：`docs/review-evidence/conversation-runtime/`。原始快照、红/绿日志、完整全量及临时 fixture 在 `C:/Users/21161/AppData/Local/Temp/gugo-conversation-runtime-eouGVO`，可能被系统清理。前轮 1191 PASS 不是本轮新代码的证明。

## 使用与后续边界

本轮改了后端事件/验收逻辑；仅前端 HMR 不保证旧 Node/Electron 服务载入新模块。用户应等现有任务结束或明确暂停后再重启加载新代码，不在任务执行中强制杀进程。本轮没有自动重启真实服务。

“顶级 Agent”的后续应按可复现任务、真实权限、失败恢复、产物证据和资源行为逐项验收，而不是承诺所有任务无条件成功、放开并发/工具或用模拟数据代表真实模型表现。原生 Electron、真实 Provider、长期压力/性能和非 Git 变更来源仍需独立计划与授权。
