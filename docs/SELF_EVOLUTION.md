# Self-evolution Safety Pipeline

Gugo 的“自我进化”不是让当前模型直接修改生产 prompt、plugin、策略或用户文件。演进链路必须逐层建立可审计证据，并在隔离评测和人工批准之前保持只读。

## Phase 1: evidence corpus（当前已实现）

### 显式反馈

`POST /api/evolution/feedback` 将 `/feedback` 写入 user-scoped、append-only 的 `evolution_feedback` 表。正文限制为 1–4000 字符；聊天 session 仅在确属当前用户且不是认证 token 时关联。未同步草稿或其他用户 session 会降级为 `null`，反馈本身仍可靠保存。

### 结构化 Reviewer 证据

`GET /api/evolution/evidence?limit=1..200` 合并：

- 当前用户的显式反馈；
- 当前用户 Job 的 `task_reviewed` 事件。

响应使用 `schemaVersion: 1` 和 `Cache-Control: no-store`。Reviewer 事件只投影 verdict、summary、issues、evidence、repairAttempts 及隔离模型元数据；不会返回完整 job prompt、event message、原始 payload、模型 transcript、tool trace 或可执行代码。API 始终按认证用户隔离。

当前 evidence corpus **没有** prompt/plugin/config mutation、候选生成、自动安装或自动应用端点。

## Phase 2: dataset curation（当前已实现）

`GET /api/evolution/dataset?limit=1..200` 从当前用户的原始 evidence 动态生成派生数据集。它不会更新 `evolution_feedback` 或 `job_events`，并提供：

- 对 token、credential、常见 provider key、邮箱和本地绝对路径的确定性脱敏；
- 基于脱敏后规范化内容 SHA-256 的去重，同时保留不可变的 `evidenceIds`、出现次数和时间范围；
- 透明、版本化的规则聚类，包括 verification、artifact delivery、authorization、external dependency 和 tool runtime；未知失败明确归入 `unclassified_failure`，不冒充模型判断；
- `evidenceSchemaVersion`、`curationVersion`、每条记录的 `contentFingerprint` 和整体 `datasetFingerprint`；
- `schemaVersion: 1`、最多 200 条原始证据和 `Cache-Control: no-store`。

人工排除通过 `POST /api/evolution/exclusions` 写入独立的 user-scoped curation 元数据；`excluded: false` 可撤销。`GET /api/evolution/exclusions` 仅列出当前用户的排除项。排除会让派生 dataset 忽略对应 evidence，但不会删除、改写或隐藏原始 evidence；其他用户的 evidence ID 会按不存在处理。排除原因同样经过脱敏。

dataset 指纹只能证明同一 curation 规则下的输入与派生结果，不能证明候选质量。

## Phase 3: candidate generation（当前已实现）

`POST /api/evolution/candidates/generate` 只接受当前用户的 `datasetFingerprint` 和 1–20 个显式选择的 curated `sourceRecordIds`。服务在模型调用前后都会重新计算 dataset；指纹过期或生成期间 dataset 变化时 fail closed，候选不会落库。

候选生成边界：

- 只把 P6 已脱敏的 selected records 和再次脱敏的 objective 发给后台模型；原始 feedback、job payload、prompt、transcript 和 tool trace 不进入生成请求；
- 模型调用不提供 tools，不允许声称已 apply、install、activate、approve、test 或 deploy；dataset 文本按不可信数据处理，不作为指令；
- 模型输出必须是结构化 JSON，并在落库前再次执行 secret、邮箱和本地路径脱敏；无效、空或过大的输出被拒绝；
- `prompt`、`plugin`、`config` 只作为惰性文本对象写入 append-only `evolution_candidates`，状态固定为 `proposed`；plugin 内容不会进入 runtime plugin loader 或 renderer；
- provenance 保存 dataset/curation 版本、curated record IDs、不可变 evidence IDs、实际 generator model、无工具生成模式和内容 SHA-256；
- `GET /api/evolution/candidates?limit=1..100` 返回摘要，`GET /api/evolution/candidates/:id` 返回当前用户的完整候选；全部响应 `Cache-Control: no-store`。

不存在通用 candidate update、delete、apply、install、直接 approve 或 rollout API。`permissionsRequested` 只是等待后续独立权限审查的元数据，不授予 manifest contribution、工具信任或 renderer 权限。唯一例外是 Phase 10 的 `config:runtime` 专用确定性审查与本地所有者显式应用链路；它不复用通用 candidate apply，也不能修改端点、凭据或权限。

## Phase 4: isolated replay（当前已实现）

`POST /api/evolution/replay-suites` 创建 user-scoped、不可变 replay suite。每个 suite 绑定一个 P6 dataset fingerprint，包含 1–10 个显式 case；case 的 title/input 会再次脱敏并绑定 curated source record。dataset 过期或 record 不存在时 fail closed。

`POST /api/evolution/replays/run` 当前只接受 `prompt` candidate：

- suite 和 candidate 必须来自同一 dataset fingerprint；plugin/config 在此通用模型 replay API 中返回 `EVOLUTION_REPLAY_KIND_UNSUPPORTED`，不以文本模拟冒充真实执行；`config:runtime` 只使用 Phase 10 无模型、无副作用的专用确定性 replay；
- baseline 与 candidate 使用完全相同的 case、显式固定 model、temperature 和 maxTokens；实际模型名发生漂移时 run 失败；
- 每次模型调用都没有 tools。候选不能访问文件、网络、service 或 runtime state；仅宿主到已配置 model provider 的推理传输存在；
- baseline、case 和双方输出都经过敏感信息脱敏；任一调用失败、输出为空或过大时不写入部分 run；
- 完成后保存双方输出、耗时、模型参数、baseline/candidate SHA-256、suite/candidate 引用和整体 run fingerprint；可选 Provider 费用仍保存在本地结果中，但不进入 run fingerprint。

`GET /api/evolution/replay-suites`、`GET /api/evolution/replays` 返回摘要，单项 GET 返回不可变详情；全部 `Cache-Control: no-store`。Replay 结果没有 verdict，也不存在嵌套 evaluate、approve、apply、install 或 rollout API；同场输出不等于质量结论。

## Phase 5: independent evaluation（当前已实现）

配置 `EVOLUTION_EVALUATOR_PROVIDER_ID` 与 `EVOLUTION_EVALUATOR_MODEL_NAME`，或由受控设置页显式提交 evaluator 身份后，`POST /api/evolution/evaluations` 对一个不可变 replay 创建 user-scoped、append-only evaluation。实际 Provider 与模型必须和请求完全一致；只有 Provider 与模型都和 replay worker 相同时才视为不独立。历史 replay 缺少 Provider 身份时 evaluation fail closed，必须重新回放。

Evaluator 只接收已脱敏的 case input 和 baseline/candidate output，不提供 tools。它必须为每个 case 返回 0–4 分、`pass|fail|unknown` safety、直接 evidence 和 issues；缺 case、重复 case、非法分值或无具体 evidence 的输出不会落库。模型返回的 aggregate verdict 被忽略，最终 `pass|fail|inconclusive` 完全由宿主策略计算：

- 任一质量、安全或延迟回归直接 `fail`；
- 没有至少一个质量改善、安全证据为 unknown、延迟证据缺失或 candidate 请求新权限时只能 `inconclusive`；
- 只有无质量/安全/延迟回归、有质量改善、延迟证据完整且无需权限审查时才可 `pass`；
- replay 记录双方规范化 token usage 和可选的上游 Provider 费用估值；费用只作为本地 BYOK 遥测，不进入 verdict 或 evaluation fingerprint。未配置费率或 Provider 未提供 usage 时不会用猜测值冒充证据，也不会阻断评估。

Evaluation 保存 rubric 版本、逐 case 证据、宿主 metrics/issues、独立模型身份和 evaluation fingerprint。`GET /api/evolution/evaluations` 返回摘要，单项 GET 返回 case assessments；全部 `Cache-Control: no-store`。Evaluation 即使 `pass` 也不能自行批准；批准只能进入下一阶段的独立人工决策记录。

### 持久化模型操作与过期租约清理

candidate、replay 和 evaluation 的模型工作使用 user-scoped `evolution_operations` 状态机与短期 worker lease。checkpoint、完成、阻断和失败写入都同时校验 worker token、lease owner、墙钟期限与进程内单调期限；失租 worker 不能再写结果。

进程启动后会异步执行一次有界扫描，此后按固定间隔继续扫描；单批最多处理 64 条，存在更多明确过期记录时立即开始下一批，但每批仍保持上限。扫描只会把以下 `running` 记录 CAS 冻结为 `blocked/model_outcome_unknown`：数据库 lease 已到期、记录时间戳位于当前墙钟未来、或当前进程的单调 lease 已确认丢失。活跃 lease、仅缺少本地 fence 的其他进程 lease 和非 `running` 记录不会被修改。多实例同时扫描时由 SQLite `IMMEDIATE` 事务与 worker/version 条件保证最多一个实例成功。

SQLite writer busy 只触发有界延迟重试，不阻塞服务启动；关闭时先取消后续 timer，并等待正在执行的扫描结束，数据库关闭后不会残留扫描。诊断日志只记录稳定错误码或错误消息，不记录 operation request、checkpoint、模型输出或用户 payload。冻结后仍必须读取服务新签发的一次性 recovery challenge，并由本地用户确认 Provider 侧确实未发送后才能恢复；sweeper 不会自动重放模型请求。

## Phase 6: local-owner human approval（当前已实现）

`GET /api/evolution/approval-reviews/:evaluationId` 生成只读审查包，包含 baseline→candidate 全文替换 diff、candidate/dataset provenance、replay 模型与隔离参数、逐 case evaluation、权限请求和明确的 baseline rollback target。宿主同时返回四个必须逐字确认的不可变标识：candidate content SHA-256、replay run fingerprint、evaluation fingerprint 和 rollback baseline SHA-256。

`POST /api/evolution/approvals` 只记录 `approved|rejected` 人工决定，并要求 1–2000 字符理由和上述四项精确确认。安全边界如下：

- 所有 approval review/create/list/get 路由都要求已登录、TCP loopback、`AUTH_MODE=local` 且当前用户是已固定的 local owner；multi-user 模式 fail closed；
- 同一 evaluation 只能产生一条 append-only 决定；改变决定必须创建新的 replay/evaluation，不能更新旧记录；
- `approved` 仅接受 prompt candidate、宿主 verdict=`pass` 且 `permissionsRequested=[]`；非 pass 或 plugin/config 不可批准，新增权限返回 `EVOLUTION_APPROVAL_PERMISSION_CHANGE_UNSUPPORTED`；
- `rejected` 仍绑定相同不可变证据和 rollback target，不能成为绕过确认的弱路径；
- approval 保存脱敏 review snapshot、local-owner-loopback approver mode 和 decision fingerprint；所有响应 `Cache-Control: no-store`；
- approval 不修改 candidate 的 `proposed` 状态，不写 active prompt/config，也不加载 plugin。只有后续通过受控 canary、自动护栏和独立生产推广审查的 Prompt 候选，才可进入 Phase 9 的显式激活流程。

## Phase 7: scoped prompt canary（当前已实现）

`POST /api/evolution/canaries` 只从 P10 的不可变 `approved` 决定创建尚未运行的 canary release；本地所有者随后必须显式调用 `POST /api/evolution/canaries/:id/start`，创建本身不会隐式分流。当前唯一支持的目标是 `prompt:workspace-instructions`；candidate 必须是 prompt、evaluation verdict 必须为 `pass`、`permissionsRequested=[]`，且 candidate/replay/evaluation/approval 的内容和四项指纹链必须再次一致。

安全与流量边界：

- create/rollback-policy/start/list/get/stop API 均要求已登录、TCP loopback、`AUTH_MODE=local` 和固定 local owner；multi-user 模式 fail closed；所有响应使用 `Cache-Control: no-store`；
- 创建时必须显式提供 1–10 个属于当前用户的聊天 session，以及整数 `trafficPercent=1..10`；canary 本身不存在全局 scope、100% 流量、plugin/config canary 或 renderer/runtime 权限变化；100% 生产推广只能走 Phase 9 的独立审查和激活流程；
- release 保存不可变 approval/evaluation/replay/candidate 引用、创建理由、session scope、流量比例、baseline/candidate SHA-256 和 release fingerprint；显式 start 前再次验证完整 provenance、实时 baseline 和 P12 immutable rollback policy，start/stop lifecycle 使用独立 append-only event，已停止 release 不可重新启动；
- 分流使用 `release fingerprint + sessionId + turnId` 的稳定 SHA-256 bucket，同一 turn 不会因重试改变 variant；control 与 candidate 使用同一正常 TurnEngine，仅替换 workspace instruction block，不覆盖 identity、Ishiki、安全、skill、memory 或 session block；
- 创建 release 和每个 turn 执行前都会读取当前 workspace instructions。SHA-256 与 replay baseline 不一致时绝不注入 candidate，而是追加 `baseline_mismatch`/`baseline_unavailable` 的 fail-closed baseline assignment，保留观测而不静默忽略漂移；
- 每个 assignment 都保存 variant、bucket、decision reason、approved/observed baseline SHA-256；`turn.completed|turn.failed|turn.cancelled` 后追加一次 terminal outcome，只白名单保存 token usage、provider cost、耗时和规范化错误码。v82 另为独立线上评分保存本地、脱敏、每段最多 16,000 字符的 task/output 快照及当时的 Provider、模型、模型修订和 config revision；不保存 tool trace 或 raw provider payload；detail GET 最多返回最近 200 条白名单化 observation，list 只返回聚合统计；
- `POST /api/evolution/canaries/:id/stop` 保留人工停止能力。stop 后新 turn 不再被分配；已分配的同一 turn 保持稳定 assignment，恢复执行时仍实时重验 baseline；不存在 apply/install/activate/deploy 路由。

Canary outcome 是可靠性、延迟和成本观测，不是自动质量 verdict；人工批准也没有被提升为全局激活权限。

## Phase 8: predeclared automatic rollback（当前已实现）

canary 创建后、本地所有者必须在 start 前调用 `POST /api/evolution/canaries/:id/rollback-policy`，一次性声明 immutable `canary-rollback-v1` policy。Policy 绑定 release fingerprint 和 approval 中确认的 rollback baseline SHA-256；创建后不可更新、替换或删除。start 时再次精确校验绑定关系。升级前已启动但没有 v68 policy 的历史 canary 对新 turn fail closed，已有 assignment 也只按 baseline 执行。

Policy 必须明确声明：

- `windowSize=3..200`；
- `minimumCandidateOutcomes=3..100` 和 `minimumBaselineOutcomes=3..100`，且均不得超过窗口；
- candidate 最大失败率、最大取消率（0..1）；
- candidate/baseline 最大平均延迟比（1..10）。历史数据库中的 `maximum_cost_ratio` 字段仅为兼容旧检查点保留，不参与决策；API 提交已退休的 `maximumCostRatio` 会以 `EVOLUTION_CANARY_ROLLBACK_POLICY_FIELD_RETIRED` 显式拒绝。

每个新 terminal outcome 与实际执行的 effective variant/reason 一起原子落库，然后由宿主确定性计算 guard evaluation：

- 只使用 `traffic_candidate|traffic_baseline` 的直接 outcome；baseline drift、baseline unavailable、candidate provenance mismatch 和缺 policy 的 fail-closed turn 不污染比较样本；
- 失败率/取消率达到最小 candidate 样本后可独立触发；延迟需要双方达到最小样本；上游 Provider 费用只作为本地 BYOK 遥测展示，无论是否完整都不得触发回滚、阻止推广或改变模型调用权限；
- 每次 evaluation 保存 `insufficient_evidence|continue|rollback`、白名单 metrics、breaches、policy fingerprint 派生的 evaluation fingerprint；模型不能参与或覆盖阈值判定；
- 任一已声明阈值被严格超过时，在同一数据库事务中写入每个 release 唯一的 append-only rollback record，release 立即变为 `rolled_back`，新 turn 不再获得 candidate assignment；
- rollback record 绑定 release fingerprint、trigger fingerprint 和 approval baseline SHA-256，并记录当前 workspace baseline 为 `verified|drifted|unavailable`。回滚撤销的是 canary prompt overlay，不覆盖或重写用户的 `AGENTS.md`；因此 baseline 漂移时不会冒充已恢复文件内容；
- 已经分配并执行中的 turn 保持版本隔离；没有人工 `/rollback` API，人工仍只能 stop。自动 rollback 不能扩大 session scope、traffic、prompt target、plugin/config 或任何权限。

v82 在上述确定性 operational guard 之外增加独立的逐 Outcome 在线质量/安全证据层：

- 本地所有者在 start 前通过 `POST /api/evolution/canaries/:id/online-grader-policy` 一次性冻结 `canary-online-grader-v1` policy，包括 grader Provider、模型、显式模型修订、Provider config revision、rubric version、最低 candidate 质量分、最大 candidate 相对 baseline 质量下降和最大 candidate safety failure rate。Policy、身份和阈值共同派生 SHA-256 fingerprint，创建后不可替换；
- `POST /api/evolution/canaries/:id/online-grades` 对指定 outcome 执行评分；`GET` 返回 policy、append-only grades、最新线上 guard 和按当前窗口重新计算的 evidence 状态。全部路由仍只允许 loopback local owner，且 `Cache-Control: no-store`；
- grader 只接收脱敏 task/output 快照，没有 tools。实际 Provider/模型必须与冻结身份完全一致；与被评估 Outcome 的 Provider+模型相同、模型绑定缺失、Provider config 漂移、调用失败、非法 JSON、缺 evidence 或 safety=`unknown` 都 fail closed。失败也追加不可变 grade 记录，不会被重试改写成成功；
- baseline 与 candidate 的每个 Outcome 分别保存 0–4 quality score、`pass|fail|unknown` safety verdict、直接 evidence、issues、两侧模型身份、snapshot/policy/grade fingerprint。宿主按 rollback policy 的同一窗口和双方最小样本数计算线上 guard，模型不能声明总体 rollout verdict；
- 缺任一侧样本、任一 grade、有效安全结论，或 grader 执行失败时，线上 guard 只能是 `insufficient_evidence`，绝不会返回 `continue`。质量或安全阈值越界时写入 `rollback` guard，并把其 fingerprint/ID 挂到每个 release 唯一的既有 rollback record，因此同一 release 最多自动回滚一次；
- operational guard 与线上 guard 是并列证据：可靠性或延迟可以先独立触发回滚；上游 Provider 费用始终只是本地只读遥测。Promotion 必须两类 guard 都对当前样本返回 `continue`。没有 grader policy 的历史 canary 可以继续收集 operational 观测，但不能进入生产推广。

## Phase 9: immutable production promotion（当前已实现，仅 Prompt）

生产推广不会改写用户的 `AGENTS.md`，也不会把 canary 的 1–10% 流量直接扩成隐式全局状态。本地所有者先调用 `GET /api/evolution/canaries/:id/promotion-review` 获取只读审查包；只有同时满足以下条件才会返回：

- canary 已由本地所有者显式 stop，且从未触发自动 rollback；
- immutable rollback policy 存在，最新 guard evaluation 为 `continue`，candidate/baseline 样本均达到 policy 下限；上游费用证据是可选的本地观测项，不是晋升前置条件；
- immutable online grader policy 存在；当前窗口内 candidate/baseline 每个样本都有独立、完整的质量与安全 grade，最新线上 guard 与重新计算的 sample fingerprint 一致且为 `continue`；
- candidate、replay、evaluation、approval、canary release、rollback policy 和最新 guard evaluation 的引用、内容摘要及派生指纹仍逐层一致；
- candidate 仍为 `prompt:workspace-instructions`、evaluation verdict=`pass`、没有新增权限请求；
- 当前本地 workspace instructions 与批准时的 rollback baseline SHA-256 完全一致。

审查包返回六个必须完整核对的值：canary release fingerprint、candidate content SHA-256、rollback baseline SHA-256、rollback policy fingerprint、online grader policy fingerprint 和 online guard evaluation fingerprint。`POST /api/evolution/promotions` 要求 1–2000 字符的明确理由以及这六项逐字确认；服务会在 `IMMEDIATE` 事务内重新验证全部前置条件，然后原子写入：

- 包含 candidate 内容快照和完整 provenance 的不可变 production promotion；
- append-only `activated` lifecycle event；
- 当前用户与目标唯一的 active pointer。

相同目标的 active canary 与 active promotion 互斥。每个新 Turn 首次解析时读取 active pointer，将 production candidate 内容、摘要、promotion fingerprint 和当时观测的 baseline 摘要冻结到唯一 assignment；流量为 100%，不依赖 session scope 或随机 bucket。Turn checkpoint 还会冻结最终 Prompt 消息和最小 assignment 元数据，因此进程重启不会重新读取新的 Prompt、插件或 Canary 状态来改变同一 Turn。

`POST /api/evolution/promotions/:id/revoke` 只允许本地所有者显式撤销。撤销在 `IMMEDIATE` 事务中删除 active pointer 并追加 `revoked` event：

- 撤销后的新 Turn 立即回到当前本地 workspace baseline；
- 已经分配的 Turn 继续使用 assignment 内冻结的不可变候选，即使撤销后恢复也不会换版本；
- promotion 不可原地修改或重新激活；若要再次推广，必须产生新的 evidence/replay/evaluation/approval/canary 链；
- terminal outcome 只保存规范化状态、耗时、白名单 usage/cost 和错误码，不保存 Prompt、transcript 或 tool trace。

所有 review/create/list/get/revoke 路由都要求已登录、TCP loopback、`AUTH_MODE=local` 和固定 local owner，并返回 `Cache-Control: no-store`。Promotion 没有文件写入、plugin 安装、配置变更或权限扩大能力。

当前生产推广边界仍然明确：仅支持 `prompt:workspace-instructions`；plugin/config 不进入 canary/promotion。`config:runtime` 仅能走下面的专用本机配置链路，不能借此获得 Prompt、plugin 或权限推广能力。v82 的独立质量/安全 grader 是 Promotion 前置的 Canary 门禁；激活后的 production promotion outcome 仍只记录 operational 指标，尚未进入持续 A/B 评分，因此激活后新出现的退化仍需人工 revoke。系统不会用完成状态冒充质量信号。

## Phase 10: reviewed runtime config changes（当前已实现）

`config:runtime` 候选只能提交 `schemaVersion=1`、`mode=patch` 和明确安全键白名单中的 `env` 值；模型端点、模型名称、URL、API Key、token、secret、工具、路径、权限及原型污染键全部在候选落库前拒绝，且 `permissionsRequested` 必须为空。专用 replay 只解析候选并计算 baseline/proposed 哈希和锁定层，不写文件、不调用模型或插件；独立宿主策略随后生成 evaluation。只有 loopback local owner 能逐项确认 candidate、replay、evaluation、baseline/proposed 指纹并作出一次性 approval。

应用前还需要第二个由完整审查包派生的 `applyConfirmationSha256`。服务同时对原始 `runtime.json` 和 effective config 做 CAS；任何更高优先级配置锁、审批漂移或手工文件修改都会 fail closed。apply、rollback 和 revoke 都追加不可变 `evolution_config_change_events`，回滚同样要求当前文件精确等于原 apply 的 after 哈希，因此绝不会覆盖后续手工编辑。

文件与 SQLite 审计之间使用持久化 pending journal 保证崩溃恢复：

- 替换 `runtime.json` 前，服务先在同目录写入并 `fsync` 临时 journal，再以独占方式原子认领；journal 绑定 owner、candidate、approval/apply review fingerprint、事件 ID、目标路径以及 before/after 原始内容和 SHA-256。API 响应和错误不返回目标绝对路径；
- 配置文件原子替换并激活后，审计在数据库事务中以事件 ID及唯一索引 CAS 写入；提交成功才清理 journal。rollback/revoke 使用完全相同的协议；
- 服务启动时会在 HTTP 监听以及 plugin、Turn、Job 恢复之前同步执行恢复；任意 `/api/evolution/config-*` 请求仍会幂等复核。文件仍精确等于 before 且没有审计时，判定写入从未发生并安全终止 journal；文件精确等于 after 时，校验 owner 与完整数据库谱系后补齐或确认唯一审计；启动恢复失败时 runtime fail closed，不会创建监听或启动后台恢复任务；
- 文件为第三种哈希、journal 损坏、路径/owner/审批谱系不一致或已有冲突审计时，恢复器保留 journal 并报稳定冲突，绝不覆盖用户文件。重复恢复只验证既有审计并清理，不会产生第二条事件。

任何候选都不能扩大 manifest `contributes`、工具风险信任或 renderer 执行权限而不经过独立权限审批。磁盘 transformer 仍只能在 worker sandbox 中运行，不能注入 React/renderer JavaScript。

## Repository offline eval gate

仓库级离线 eval 是开发与 CI 验收门禁，不是线上模型服务，也不是收费或额度系统。它不读取用户 BYOK 凭据、不调用任何模型 Provider，并在净化敏感环境变量后封锁网络与外部进程逃逸面。每个 case 在独立 Worker 中运行；协作式超时之后仍未退出的任务会被宿主终止，不能污染后续 case。

```bash
npm run eval:offline
npm run eval:offline -- --eval-suite capability
npm run eval:offline -- --eval-json artifacts/offline-eval-latest.json
npm run eval:offline -- --eval-baseline path/to/read-only-baseline.json
```

Suite 从 `tests/offline-evals/*.eval.js` 自动发现。Baseline 只读比较：case 回归、删除或整 suite 缺失都会让门禁失败；runner 不提供自动覆盖 baseline 的路径。生成报告默认不进入 Git，诊断在写盘前经过结构化凭据脱敏和完整 schema/summary 校验。
