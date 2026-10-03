# Agent 优化接续记录（2026-09-17）

## 接手边界

- 用户授权：Pi 完成当前修改后，保留全部既有改动，继续完善 Agent，优先 CLI，不做外观迭代或自动发布。
- 已确认 Pi 同项目会话于 2026-09-16 23:50:12（Asia/Shanghai）产生 `assistant / stop` 终态；2026-09-17 00:06 检查没有 Pi 子进程，工作树保持稳定。Pi 交互进程仍存在，不等于继续修改。
- HEAD 仍为 `23c1dec`，现有大量未提交内容均为接手基线，不能回退、覆盖或宣称由本轮实现。
- Pi 已完成 CLI 交互回调/退出、类型化目标验收、v119 embedding 空间与双路候选、重建范围、上下文无变化重试等修复。历史通过记录见 `CLI_HARDENING_BASELINE.md`，不代替本轮回归。

## 本轮工作包（进行中，不是完成声明）

1. 主任务：人工确认权威、类型化验收真实性、目标会话/版本绑定、计划提示与执行控制。
2. 记忆子任务：历史语义 top-k、索引写入竞态/归属、游标与重建覆盖、资源边界及离线回归；不新增原生依赖或修改已有 migration。
3. 随后：请求前缀/供应商缓存观测、长上下文与短期记忆恢复、loop 反思/重规划事实及 trace 一致性。
4. 最终：CLI 行为矩阵、工程门禁及可行的全量回归；真实模型测试前核对明确可用的本地配置，不能把模拟结果当真实成功。

## 验证与安全约束

- 只使用隔离测试数据库、产物目录和假网络依赖；不修改真实用户数据、密钥或模型配置。
- 保留默认本地免登录、owner 隔离、审批、取消、执行租约与未知副作用不重放的边界。
- 代码使用 `apply_patch`；分批记录实际命令、结果和剩余限制，不自动提交、推送或发布。
- 完成与否由工作包及验收证据决定，不以模块数量、代码行数或测试总数声称“追平 Pi”。

## 当前验证记录

### 第一批：目标验收与记忆正确性

- 新增 `goalAcceptanceAuthority.test.js`，先得到 8 个真实失败，随后修复模型伪造人工确认、跨会话/过期版本操作、旧计划被最近 50 条过滤掉、错命令/缺 cwd/后台未终结、文件路径与摘要交叉拼接、空 verification、未知 typed kind 和不可读计划提示。
- 人工确认入口仍由认证的人操作，确认者从宿主 userId 派生；模型工具不再暴露或接受人工确认字段。全部机器验收条件 AND 判定保留。
- 计划记账工具不再算实质执行证据，也不清空真实失败反思序列；每条验收保存其对应工具调用 ID。
- 修复 goal HTTP 错误路径重复发送响应（此前回归虽然通过，日志仍有 `ERR_HTTP_HEADERS_SENT`）。未开展网页外观工作。
- 记忆语义召回改为合法作用域内的历史向量 keyset/top-k，保留独立词法召回；修复索引分页跳行、写入归属/编辑删除竞态、取消与覆盖报告。无新 native 依赖或 migration 改动。
- embedding 空间身份 v2 支持显式 revision/dimensions；旧向量不删除，但在既有重建机制更新前不参与跨空间比较。默认 embedding 仍关闭。
- Turn 取消信号已传入查询 embedding、后台索引和上下文；后台索引使用实际选择的 effectiveAgentId。background prompt 补 querySpace，提示上下文保留脱敏的召回覆盖诊断，不复制用户 query/原始错误文本。
- 为明确区分准备 I/O 与提示块渲染，抽出 `renderPromptMessages`；不通过压缩空行规避复杂度门禁。

验证记录：

- 记忆子任务 11 个关联测试文件 99/99 通过（隔离 SQLite + fake embedding），定向 ESLint、AST 复杂度通过。
- 主线整合后 14 文件 97/97 通过，覆盖 goal/CLI/记忆/提示压缩/取消。
- `npm run typecheck` 通过，14 个无效协议 fixture 按预期拒绝。
- `npm run deps:check` 通过；主线修改文件定向 ESLint 零 warning。
- `npm run audit:functions -- --check` 最终 0 违规、0 解析错误。
- 过程中发现并修正了本轮渲染函数的名称遮蔽；一个旧正向 fixture 缺必需工具名，已补真实 `read_file` 身份，不降低证据规则。
- 尚未执行本轮全量 `npm test`、真实模型演示或构建，不能宣称最终验收完成。

### 下一工作包

1. 目标计划审批接到真实副作用前边界，绑定 plan id/revision 与 checkpoint；不得仅依赖提示或把 bypass 当计划批准。
2. 原生 Anthropic 可选缓存控制及运行时请求前缀/usage 观测（独立缓存子任务处理中，未交付前不算完成）。
3. 完善长上下文 CLI/恢复/异常注入与 trace 关联；完成全量门禁后再决定网页功能调试与打包。

已知边界：历史向量扫描仍是同步 SQLite + JS 的有界精确扫描，不是 ANN；默认最多 2 万向量、1600 万向量元素、400 万文本字符，50ms 为页间软截止。达到预算明确报告 partial，不保证大规模库完整召回。

### 第二批：计划执行门控与原生缓存

- 新增纯端口驱动的 `goalPlanExecutionPolicy`，不向通用循环引入具体 DB。绑定 plan id/revision 到 checkpoint，旧 checkpoint 在当前授权边界获取绑定，新版本非法绑定保守拒绝。
- 未批准计划仍允许只读及规划控制工具；在 `normal`、`acceptEdits`、`bypass` 下均禁止新副作用。工具审批之前和 checkpoint 等待之后、分发之前都复核计划状态，旧版本不能继续执行。
- 目标阻断走明确不完整终态，不执行无进展的模型收尾。已确认 ledger 结果直接返回；在途结果因计划失效不能继续时仍保留 `SIDE_EFFECT_OUTCOME_UNKNOWN` 为主要事实。
- 两个真实循环复现先失败（未批准仍执行、工具审批期间改版仍执行），修复后门控/恢复/任务验证等 9 文件 193/193 通过；AST 复杂度、依赖清单、定向 ESLint 通过。
- Anthropic 原生新增显式 opt-in `MODEL_PROMPT_CACHE_RETENTION=short|long`，默认 none/未知值保持旧 wire。最多系统/最后基础工具/最近合法对话块三个断点；动态工具追加不移动基础工具断点。OpenAI/Gemini 不误带 Anthropic 字段。
- 真实流式构建链的 mock-fetch 测试额外发现 `modelStreamingTransport` 漏传 `env`，已补传。缓存相关 3 文件 46/46 通过；无实际模型调用，不宣称真实 KV 命中或加速比例。
- 全仓 `git diff --check` 发现 Pi 既有文件（例如未由本批修改的 `tests/cliRunOutput.test.js`）存在 CRLF/尾空白记录；不以全仓格式化覆盖既有工作，不将该检查冒称通过。

后续仍需：运行时前缀/记忆诊断和 trace 接线、子代理计划绑定边界复核、长 CLI 场景与可行的全量门禁、明确可用本地模型的真实演示。未完成整体验收，不进入外观迭代或发布。

### 第三批：上下文诊断、门禁与第一轮全量

- 已将请求前缀、工具 schema 指纹和脱敏记忆覆盖率接入真实 loop、checkpoint、`model.phase`、CLI stderr 与本地 trace；实际缓存 usage 仍独立记账，报告 0 与未报告明确区分。
- 这些指纹标记为 `pre_compaction`，不代表最终供应商 wire、tokenization 或 GPU KV 命中，不据此声称模型加速。
- 诊断相关 7 文件 54/54 通过；`eval:offline` 61/61 通过。全仓 lint、typecheck、复杂度和依赖清单检查通过。
- 尺寸门禁先发现新增超限；按职责将截断工具结果审计移入执行生命周期模块，将记忆提示渲染拆到 `memoryPromptRendering`，未添加豁免。debt 13/13 通过。
- 第一轮 `npm test` 最终 **FAIL**：batch 8 中 `TurnEngine owns a text turn and persists the final assistant message` 少预期了新增的 `context_prepared` 事件，其余批次无最终失败。文本完成和持久化断言正常；定向复现后更新完整事件序列及诊断字段断言，未删除断言。
- 补充复现可选诊断 observer 抛错会阻断模型的问题。计算/诊断 schema/普通 observer 现可降级且只记固定脱敏警告；宿主持久化 observer 用进程内身份区分，事件存储、lease/fencing/checkpoint 和取消错误仍必须停止执行。真实 TurnEngine + 诊断定向 105/105 通过。

### 第四批：子代理与工具终态边界

- 真实 registry→dispatcher 复现控制名替换插件借 `manage_todos` 名称绕过未批目标的漏洞；控制工具豁免现必须来自真实 builtin，插件/MCP 风险元数据不被名字覆盖。normal/bypass 两条红例与纯策略红例修复后通过。
- `Agent` 不再恒定标为只读：只有明确全部 explore/plan 的任务属于只读；默认、general、混合任务均按可能写入分类。
- 父目标 plan id/revision、原会话 scope 与只读限制通过宿主 WeakMap 包装继承，不接受模型参数伪造；祖先约束只收紧、不替换。受控 SQLite checkpoint/隐藏策略锚点支持恢复；不把父会话冒充子会话，也不额外给子代理挂 goal 工具。
- 子代理在审批等待后及恢复时重新核对原目标。选装的 opaque `subagent-provider` 没有逐工具宿主治理端口：遇到已继承目标/未知目标/只读约束时明确报 `SUBAGENT_PROVIDER_POLICY_UNSUPPORTED`，不调用插件、不静默切换模型；无此限制的原路径保持兼容。
- 子代理/策略/拒绝相关 6 文件 59/59 通过。两个旧 general 委派 fixture 补明确 approvalId 才到达原预算/skills 断言；没有放宽执行权限。
- 新增用户拒绝、策略拒绝、缺逐次审批、审批过期、取消、未知结果六条红例：旧循环均会继续请求模型。现停止本批后续工具和自动模型收尾，保持独立终态与已确认进展；未执行提案生成可观察的 `tool_execution_skipped` 结果，恢复 checkpoint 也不能重新打开剩余调用。
- `ok:true` 与 `requiresUserVerification:true` 的矛盾工具结果另有真实红例；标准结果归一化现在优先未知状态，不能算成功或自动重试。
- 只读/禁用工具用例改为断言宿主拒绝、保留诊断且零收尾模型；每个禁用工具分别用独立请求验证。旧 crash 测试不再让模型虚构“已核对”后执行第二个写入，改为未知终态且两类执行次数有严格断言。
- 修正批次停止检查曾提前跳过“已返回但刚跨 token 预算”的工具提案的回归，仍按原预算契约处理。loop/拒绝 108/108 通过；加标准结果与 ledger 后 133/133 通过。
- 使用真实内存 SQLite ledger 补恢复测试：已在执行的操作遇到目标变更仍以 `SIDE_EFFECT_OUTCOME_UNKNOWN` 为主要事实，附宿主目标原因；不重放、不进行模型收尾。统一最终授权阻断的未知结果优先级。相关 5 文件 232/232 通过。
- CLI `/plan` 与隐式 `/approve`、HTTP 列表改为 SQL 先按 owner/session 筛选再 LIMIT；显式非法 expectedVersion 返回 400，不默认为跳过并发检查。先复现旧会话遗漏与 null 版本误批准，再修复；相关 7 文件 55/55 通过。
- 子代理文件再次触及 600 行门禁时，把策略 trace 恢复/保存移入现有运行状态模块，未压缩空行或扩大豁免。最新 debt 13/13、deps 与 typecheck（14 个反向协议 fixture）通过。

下一步是冻结后的完整回归与 CLI 隔离演示。仍未调用真实模型、未开展网页外观调试、未打包或发布；没有明确可用的本地推理服务时不得将 mock-fetch/离线通过当作真实模型验收。

### 第五批：第二轮全量与真实本地 CLI 接线

- 第二轮 `npm test` 已完成，最终 **FAIL（4 个失败批次、8 个失败用例）**，隔离 UI 阶段没有最终失败。失败分别来自 job 拒绝后的旧模型收尾断言、write/run_code/输出续写未知结果的旧收尾断言、plan/只读拒绝的旧文本断言、缺 owner 的旧通用错误码，以及撤销执行信任后只在第二次模型请求里观察工具结果的 fixture。
- 将这些检查移到真实 `onToolCompleted` / checkpoint 边界，保留原权限、审计、工具结果与幂等性断言，并新增零收尾模型断言。另先复现不可重试的授权身份故障仍触发模型请求，再按独立终态停止。对应 7 文件 75/75 通过；不能将这次定向通过写成第二轮全量通过。
- 发现本机已安装 LM Studio CLI，模型清单已有 `qwen/qwen3.5-9b`（Q4_K_M，工具调用声明为 true）。`lms ls` 自动唤起了 LM Studio；确认 HTTP 服务仅监听 `127.0.0.1:1234`，没有改用户凭据或模型安装。
- 将已有模型加载为临时实例 `gugo-cli-verification-qwen35`，实际 contextLength=16384、parallel=1、空闲 TTL=900 秒。没有下载权重、调用收费云模型或改 Pi 安装。
- CLI 演示副本位于 `C:\Users\21161\AppData\Local\Temp\gugo-agent-cli-demo-620b790573714a4b92a5d35e92a48c27`；3 个 fixture 的 runtime DB、产物与任务工作目录分离，19 个隔离检查通过。子进程仅继承必要系统变量，模型端点强制绑定到单个回环地址；本地执行开关只存在于演示子进程环境。
- 实际 doctor 暴露新缺陷：环境配置被误报成已探测（checkedAt=null 转成 0），显式 `--probe` 对环境端点又被跳过。已补实际环境探针、临时结果与缓存结果区分，探测失败不能被旧 ready 状态掩盖，保留脱敏错误信息。三个红例修复；关联 4 文件 42/42 通过。
- 真实 LM Studio HTTP 400 明确指出不支持对象形 `tool_choice`，仅接受 none/auto/required。端点画像新增 named-choice 能力：不支持时，只发送已授权的目标工具 schema + required；不扩大候选工具，也不改原 catalog。两条红例修复，关联 5 文件 67/67 通过。
- 此后真实 doctor 的模型列表、文本补全与 function-call 三步均通过（文本约 6.4 秒、工具约 5.5 秒）；这是实际本地模型结果，不是 mock。
- 首次真实 CLI 流式任务仍在请求渲染阶段失败。核对 LM Studio 本轮服务错误日志，确认是 Jinja 在推理前拒绝中途 system 角色；没有执行任何工具，fixture 未改。没有把原未知请求记录篡改为成功或自动重放。
- 增加端点画像的中途 system 能力：LM Studio wire 将中途控制消息保留原位置、降到 user 角色，初始静态 system 前缀不变，持久会话与工具配对不变；通用兼容端点保持原行为，显式 override 可选择。两条红例修复，相关 5 文件 62/62 通过。
- 第二次包装式 JSONL 演示已真实读到 fixture，并在编辑审批处安全拒绝：包装进程的 stderr 管道不具备 TTY，这不是人工点击拒绝。演示现改为全继承 TTY 的文本模式，逐项审阅并批准仅作用于临时 fixture 的调用；不使用 bypass。

真实任务演示仍在执行，尚未声明任务通过；最终全量、离线评测及后续网页/构建也仍待验收。

### 第六批：真实 CLI 收敛、统计尾帧和可操作诊断

- 根目录 TTY 试跑曾正确修改计数器并通过独立 verifier，但 CLI 因验证债务不收敛而超时（124）。根因是末尾 `2>&1` 被算成新的写入，测试每跑一次就增加 mutation epoch。现仅对引号外、末尾独立的 stderr→stdout 合并作验证归类；写日志重定向、管道、掩盖退出码和复合命令仍不算通过证据，也不放宽 Shell 审批。真实 loop 红例修复，关联 160/160。
- 未配置的 `run_project_check lint` 现在返回 `PROJECT_CHECK_NOT_CONFIGURED`、`executed:false` 和 `availableChecks`，不启动 npm，不增加已运行失败的验证义务。实际配置但失败的测试保留失败语义。关联 39/39。
- 修正了一次本轮过宽分类：一般的 `systemFailure` 不等于授权失败，只有宿主 `authorizationFailure:true && retryable:false` 才因身份/授权不可核实停止。缺失工具链仍可选择其他验证方式；关联 62/62。
- `attempt-2` 中 edit 匹配失败后的 write 成功，但被缺失 lint / 过宽授权分类停止，保留失败记录。此轮不计 CLI 验收成功。
- `attempt-3` 的计数器修复（turn `191c5450-442a-4e38-b9d3-0b1d42929d2a`）和报表修复均 **CLI exit 0 + 仓库外置独立 verifier exit 0**。保持原 fixture/API，不修改 verifier，以 normal 模式逐次审批。报表修复验证了算术平均数及输入数组不被排序改写。
- `attempt-3` 配置修复失败 `REPEATED_TOOL_CALL`，没有改文件。发现 Git 非仓库错误把完整 help 同时放进 diff/stat，且标准错误归一化显示 `[object Object]`。现返回短错误码/提示，失败不冒充空 diff 成功，也不自动 git init；`--cached` 的误导性 unknown-option 用只读 rev-parse 交叉核对。3 个初始红例修复，新增 5/5 通过；真实 Git 的 staged/unstaged/clean 和原权限检查保留。
- 确认 LM Studio 支持 `stream_options.include_usage` 并启用端点能力。但真实 CLI 仍漏统计，原因是 `finish_reason` 后立即退出 SSE，漏掉 `choices:[]` 的 usage 尾帧。现仅在实际请求了 usage 的兼容 Chat Completions 且尚未取得 usage 时，做最多 1 秒、64 行/64KiB 的统计尾读；不再接收正文/工具，不重开生成。缺帧、EOF、重置、非法尾帧都不撤销已知终态，也不重试模型。取消后真实 loop 零审批/执行。初始 5 红后，关联 148/148，补充边界 16/16；原生/Responses 终态保持原样。
- `attempt-4-config` 已记录真实非空 token usage，例如单轮 `5551/125/5676`（prompt/completion/total）。本地端点没有报告缓存命中字段，仍保持未知，不能写成“0 命中”或据此前缀指纹声称 GPU KV 加速。
- Doctor 用真实临时 SQLite + fake probe 再复现未验证/失败模型误探测默认 Provider，以及 legacy 本地 env 被保存的云默认覆盖。选模与 readiness 分离，发探针前再次检查实际 model/URL/凭据绑定；冲突返回 `MODEL_PROVIDER_BINDING_MISSING` 并提示明确 `--provider` 或命名环境 Provider，不修改全局选模优先级。32/32 通过，无真实云请求。
- 空闲 TTL 会卸载本轮本地模型，已实际遇到 HTTP 400 `No models loaded`。旧终态仅显示 TURN_FAILED；现识别这一已确认的有限签名为 `MODEL_NOT_LOADED`，给固定加载提示，不透传上游私密正文、不改变重试/unknown/审批语义。真实隔离 CLI 4/4，关联 58/58；随后本地真实失败也显示了该固定提示。演示启动器改为先核对本轮专属 identifier 和窗口，再按需加载已有权重；不卸载别的实例或下载模型。
- 修好 Git 诊断后，配置任务仍重复只读调用。真实 checkpoint 显示只有 9 个只读/发现工具：`Do not change the exported function name` 被误作整轮只读，而文件定向的 `Harden` 又未识别为修改请求。现仅在独立明确修改请求旁，剥离完整、狭义的接口保留子句用于路由；原提示不变，全局/未识别禁令保留。新增 normal 审批拒绝的真实 loop 红例，修复后含中英/多语言/全局只读关联 124/124；配置任务正在重跑，不先宣称成功。
- 本批 lint 零 warning、typecheck（14 反向 fixture）、debt 13/13、deps 与 AST 复杂度通过。最新完整 offline eval **FAIL**：SAFE-03/05/06/07 四场景仍期望权限拒绝后的模型收尾，而实际正确返回宿主终态；正在把原安全断言迁移到 completed/checkpoint 并补严格零收尾约束。不能把该轮记录改写为通过。
- 第三轮 `npm test` 已启动，结果待收集。未开展网页外观、程序发布或自动提交。真实演示日志/数据库与全部失败记录仍在隔离目录，不能将中间失败丢弃后声称一次性全通过。

### 第七批：独立验证反馈、真实 RAG 与完整门禁

- `attempt-4-config` turn `9134dc6b-0d0f-4d03-bce4-1fc95c76996e` 已 CLI exit 0，原外置 verifier exit 0，normal 模式依次批准编辑/可选 lint/实际 test。lint 未配置的结果没有制造新的验证债务。因此三项 starter 任务各自都有实际 CLI + 原独立 verifier 的通过记录，但不是一次性成功率。
- 额外黑盒验证发现该模型补丁会误删 `toJSON` / `hasOwnProperty`；在同一持久会话中反馈失败后，它修正了普通字段和两个输入的过滤，但漏了 symbol。此轮还提出覆盖原 `test.mjs` 并使用不抛错的 `console.assert`；该调用未批准、原文件 hash 未变，CLI 等待审批期间达到演示墙钟（124）。不能将该轮当作成功。后续 symbol 修正虽通过当时的额外断言，新增非枚举属性检查又发现与 Object.assign 原契约不一致，继续保留这条失败记录并做独立任务复核。
- 已使用现有本地 Nomic 权重加载专属 `gugo-memory-verification-nomic`（80.21 MiB），无下载。真实 768 维 embedding + CLI `memory reindex --all-agents` 首次索引 3 条本用户记忆；跨 owner/Agent 排除正确，语义-only 与词法召回独立。内容编辑后旧向量排除，重建仅更新 1 条，再次独立进程重启索引 0 条；错误空间不召回。隔离 SQLite integrity_check=ok、foreign_key_check 为空。脚本和数据库在演示根 `runtime/verify-live-memory.mjs` / `memory-smoke-data/app.db`；这是小样本正确性实测，不是大库性能或 ANN 测试。
- Shell 新增真实执行前的绝对 `executionCwd`，保留显示 `cwd`。复用 Shell 的命令排队准入时记录实时目录，不把命令结束后的 cd 位置当成入口位置。目标验收优先使用宿主字段，显式坏字段不能回退相信模型 args.cwd；旧回执仅沿用原比较，不补造证明。5 红后新 8/8、关联 116/116；不改 taskVerificationScopes 的旧相对键或 DB schema。
- 第三轮全量最终 **FAIL，3 批次/3 用例**：Provider 画像整对象缺少新增字段预期、两个 intended-consumer 场景却使用了缺失 owner 导致先被授权门控拦住。定向复现后补新增能力的模型覆盖/Provider fallback 行为测试；两个旧 fixture 补有效 owner/单次授权，所有原“不得假成功/不得激活无关产物工具”断言保留。关联 22/22、14/14 通过。
- 测试环境还补了 npm cache 与 user/global npmrc 的 worker 隔离；新隔离断言先 2 红，修复后通过。演示本身已单独隔离 npm 配置和产物。
- 修正 offline 四条旧拒绝后模型收尾 fixture，保留原安全断言并增加严格单次模型调用、本批后续候选 skipped 和零执行/无额外审批检查。最新完整 `eval:offline` **61/61 PASS**，JSON 报告位于演示根 `runtime/logs/offline-latest.json`；此前失败记录没有改写。
- 第四轮完整 `npm test` **PASS（943 个测试文件）**。全仓 lint 零 warning、typecheck（14 反向 fixture）、deps、AST 复杂度、debt 13/13 通过。该完整扫描之后又发现下面两项真实模型边界，不能把第四轮通过冒充涵盖所有后续代码。
- 同会话扩展任务 `e7a90522-6ac5-49e4-97fc-87ad43d1cf1d` 在已确认写入后触发模板 500。只读核对本轮 LM 日志 `2026-09-17.1.log:34193`（06:55:35），明确是渲染阶段 `No user query found in messages`，不是推理中断；没有篡改旧 invocation 的未知记录或重放。实际 wire 只有 system、assistant 摘要和成对工具尾部，压缩档案仍有原始用户方向。
- 端点画像新增 `requiresUserMessage`（LM Studio 默认 true）。在该端点的供应商视图确实缺少 user 时，插入一个小于 240 字符、明确标为“Runtime continuation; not new authorization”的宿主控制消息；不冒充新的用户目标、不把摘要/模型思考提升为用户指令、不改压缩原文/档案或账本。普通端点保持原 wire，可显式 override。先红后绿，并验证工具配对与持久消息未改变。
- 另复现未知模型结果在 iter>0 被泛化为 `interrupted + retryable:true + resume_turn`。现保留 unsafe/unknown 错误向宿主传播，统一非重试阻断、`verify_model_request` 动作与已确认进展；恢复没有新增请求或写入。真实 fake-SSE→loop 红例修复，含 TurnEngine/压缩/恢复等 174/174 通过。

仍进行中：最后两项边界的扩展回归与实际本地验证、配置额外语义检查、网页功能一致性及必要构建。未开展外观迭代，也未自动提交、发布或变更真实用户数据。

### 第八批：网页一致性、真实交互式 CLI 与分发边界

- 第五轮全量 **PASS（944 个测试文件）**；最后协议/未知结果相关 251/251，Shell/子代理/目标合并 68/68，完整离线评测再次 61/61 通过。随后网页与交互式真实入口仍发现下面缺陷，单元通过不替代实际入口验收。
- 对新的真实本地请求验证了压缩后的无 user-role 快照：LM Studio 成功返回 `COMPACT_OK`、finish=stop、0 工具，真实 usage=279/6/285；原压缩源仍 0 个 user role，供应商适配没有修改持久档案。该测试是模拟历史输入 + 真实本地传输，不是重新发送先前结果未知的请求。
- 扩展配置补丁已通过独立严格脚本的普通字段、两个输入危险键、symbol、继承属性、非枚举属性、输入不变等检查。但最新扩展 CLI turn `449aaa21-a6c2-4111-9218-8674211e9593` 在有效内容空闲 120 秒后仍被正确阻断为 `MODEL_REQUEST_OUTCOME_UNKNOWN` / `verify_model_request`；不算扩展 CLI 完成，不自动重放。原三项 starter CLI+verifier 通过记录依旧有效，不推出小型本地模型对所有复杂多轮任务都稳定。
- 使用 Playwright 技能在 `web-functional/data/app.db` 这个隔离 SQLite 备份上验证真实 Chrome 页面：本机自动身份无需登录，CLI 历史能显示；未知结果页明确区分模型请求核实与文件核实、保留文件、展示物理 Provider / model / request ID；未确认事实时保存裁决按钮禁用。没有执行未知结果恢复。截图在 `web-functional/.playwright-cli/page-2026-09-16T23-21-29-041Z.png`，已目视检查。
- 原网页请求“这是隔离网页功能验证，不需要调用工具。请只回复：网页链路正常”却强制生成 HTML（turn `a056e264-f946-4c76-846c-defddfcc7bcd`，2 工具）。文件确实仅生成于隔离 fixture 工作区，不是用户桌面或真实项目。保留这条真实失败与 3378 字节 HTML，没有改写为当时成功。
- 新共享 `toolFreeResponseIntent` 同时服务产物/执行/工具选择；运行时在审批/dispatch 前拒绝违背本轮禁工具指令的提案，跳过 pre-tool 改写/专用输入处理，不做模型收尾。恢复旧产物/动态工具契约不能绕过；已确认 ledger 结果与 in-flight 未知事实优先保留。不把“运行测试后只回复 PASS”、外部工具限制、显式例外和引用文字误作全局禁工具。主线接完因子代理限流未完成的执行边界；关联 200/200，CLI/文本/恢复 113/113 通过。
- 新增代码一度使 `shared/artifactIntent.js` 达 612 行，debt 门禁真实失败；将覆盖/副本/冲突模式及其规则按职责移到 `artifactRevisionMode.js`，保留原导出，未缩空行或加豁免。相关含尺寸门禁 139/139 通过。
- 重启隔离网页后同一句真实请求返回 **“网页链路正常”**，turn `fc476148-b5c5-47f9-b690-44b659446ee7` 为 completed，**0 工具、0 产物**，usage=4692/72/4764。这是实际本地模型/browser/SSE/SQLite 全链路证据；不把延时变化解释成 KV 命中率。
- 真实 `gugo chat` 首次启动暴露未导出的 `loadBuiltinHeadlessRuntime`，旧单测全注入 runTurn 因而漏检。run/chat 现共用独立延迟加载模块，先选择可信持久化再建立身份，消除 interactive→CLI 入口反向导入。无替身 builtin 启动红例修复，CLI 关联 60/60。
- 随后真实 TTY 连续两轮：会话 `135e3d11-9ba7-4d24-9f14-6a19f43d022b`，第一轮原样回复 `ORCHID-731`，第二轮在未重给标记时正确回复相同值；均 0 工具，分别 1777/89 和 1808/131 的真实 token 计数。`/session` 和 `/exit` 正常，进程 exit 0，证明实际短期会话保留及 stdin 释放；不依赖 remember/RAG 伪造这项结果。
- Web 构建成功（仅临时输出目录），桌面检查 71/71 通过。分发核对另发现 package.json 声明 `gugo/sdk`，Web 白名单却漏了 sdk；先复现缺失导出，再补 JS/Python SDK 入包并验证 staging 后 Node 自引用 import，关联 20/20 通过。没有安装/更新全局工具，也没有发布。

最终收尾中：最后完整回归结果收集、本地 Web 分发包及清单核验、演示进程清理。仍不声称已产出/安装 Windows NSIS 安装器，不声称 ANN、大规模召回、实际缓存命中率或已全面追平 Pi。

## 最终验收与交付

- 第六轮全量 **FAIL（仅尺寸门禁 1 项）**，读取到拆分前的 612 行意图模块；拆分后的相关 139/139 和 debt 13/13 已通过。保留该轮失败，不将进行中的扫描冒充冻结验证。
- 代码冻结后的第七轮全量 **PASS（946 个测试文件）**；完整离线评测 **61/61 PASS**，lint 零 warning、typecheck（14 反向协议 fixture）、deps、AST 复杂度、debt **13/13** 均通过。生产依赖 license 检查 **333 个包通过**。
- 最终新增 CLI 真实 builtin 启动、产物规则、SDK/分发闭包回归通过；原有失败输入、授权、取消、未知结果、旧数据与恢复用例保留，没有降低门槛或增加门禁豁免。
- 本地模型实测：run 三项 starter 各有 CLI + 原独立 verifier 成功证据；chat 同会话两轮标记回忆正确、零工具、退出 0；Nomic 768 维真实索引/召回/重建及 SQLite 完整性通过；无 user-role 压缩快照经端点适配后真实返回 COMPACT_OK；网页禁工具回复修复后为 completed / 0 工具 / 0 产物。扩展长多轮的模型超时仍按未知阻断，未冒充完成。
- 最新前端 build 生成在独立 `web-functional/dist-final`，桌面安全/打包契约检查 **71/71**。已生成本地 **Web 验证包**：`output/agent-hardening-20260917/gugo-0.11.56-web-local-verification.zip`。包含前端、服务端、CLI 与 JS/Python SDK，不含 node_modules、测试数据库或运行时 `.env`。需 Node.js 和按锁文件安装生产依赖；**不是独立 Windows 安装器，也不是正式发布**。
- 包内 `BUILD-VERIFICATION.json` 提供文件清单和逐文件 SHA-256；实际 staging 的 CLI `--help` / `--version` 和 `gugo/sdk` 自引用 import 已通过。归档逐项核对包含 2016 个清单文件（另有清单自身）。最终 ZIP 的摘要以包旁校验文件为准。
- 已关闭仅本轮创建的 Playwright 浏览器及 5187 端口网页服务，chat 正常退出。临时 Qwen 实例已卸载，Nomic 实例已按 TTL 释放；没有停止 Pi 或用户其他模型实例。隔离演示/失败数据库与日志仍保留，便于复查。
- 未提交、推送、发布、修改模型代理凭据或更改 AGENTS.md / package-lock.json；保留 Pi 和用户的全部原有 dirty 改动。全仓既有换行/尾空白没有借机格式化。

剩余边界：历史向量检索仍是有界精确扫描，不是 ANN；缓存命中字段未由本地端点报告，不能声称真实 KV 命中率；复杂多轮成功率仍取决于模型与任务，反思/自进化必须通过独立验证与现有授权，不能自我批准或扩权。Windows NSIS 安装器和跨机器安装验证留待后续明确构建流程，不以 Web ZIP 或静态检查代替。
