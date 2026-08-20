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

不存在 candidate update、delete、apply、install、直接 approve 或 rollout API。`permissionsRequested` 只是等待后续独立权限审查的元数据，不授予 manifest contribution、工具信任或 renderer 权限。

## Phase 4: isolated replay（当前已实现）

`POST /api/evolution/replay-suites` 创建 user-scoped、不可变 replay suite。每个 suite 绑定一个 P6 dataset fingerprint，包含 1–10 个显式 case；case 的 title/input 会再次脱敏并绑定 curated source record。dataset 过期或 record 不存在时 fail closed。

`POST /api/evolution/replays/run` 当前只接受 `prompt` candidate：

- suite 和 candidate 必须来自同一 dataset fingerprint；plugin/config 在具备专用 sandbox harness 前返回 `EVOLUTION_REPLAY_KIND_UNSUPPORTED`，不以文本模拟冒充真实执行；
- baseline 与 candidate 使用完全相同的 case、显式固定 model、temperature 和 maxTokens；实际模型名发生漂移时 run 失败；
- 每次模型调用都没有 tools。候选不能访问文件、网络、service 或 runtime state；仅宿主到已配置 model provider 的推理传输存在；
- baseline、case 和双方输出都经过敏感信息脱敏；任一调用失败、输出为空或过大时不写入部分 run；
- 完成后保存双方输出、耗时、模型参数、baseline/candidate SHA-256、suite/candidate 引用和整体 run fingerprint。

`GET /api/evolution/replay-suites`、`GET /api/evolution/replays` 返回摘要，单项 GET 返回不可变详情；全部 `Cache-Control: no-store`。Replay 结果没有 verdict，也不存在嵌套 evaluate、approve、apply、install 或 rollout API；同场输出不等于质量结论。

## Phase 5: independent evaluation（当前已实现）

配置 `EVOLUTION_EVALUATOR_MODEL_NAME` 后，`POST /api/evolution/evaluations` 对一个不可变 replay 创建 user-scoped、append-only evaluation。客户端不能指定 evaluator；实际模型名必须与 replay worker 不同且与服务端配置完全一致，否则 `EVOLUTION_EVALUATOR_NOT_INDEPENDENT` fail closed。

Evaluator 只接收已脱敏的 case input 和 baseline/candidate output，不提供 tools。它必须为每个 case 返回 0–4 分、`pass|fail|unknown` safety、直接 evidence 和 issues；缺 case、重复 case、非法分值或无具体 evidence 的输出不会落库。模型返回的 aggregate verdict 被忽略，最终 `pass|fail|inconclusive` 完全由宿主策略计算：

- 任一质量、安全、成本或延迟回归直接 `fail`；
- 没有至少一个质量改善、安全证据为 unknown、成本/延迟证据缺失或 candidate 请求新权限时只能 `inconclusive`；
- 只有无回归、有质量改善、成本与延迟证据完整、无需权限审查时才可 `pass`；
- replay 现在记录双方规范化 token usage 和 provider cost；provider 未提供 usage 时不会用猜测值冒充成本证据。

Evaluation 保存 rubric 版本、逐 case 证据、宿主 metrics/issues、独立模型身份和 evaluation fingerprint。`GET /api/evolution/evaluations` 返回摘要，单项 GET 返回 case assessments；全部 `Cache-Control: no-store`。Evaluation 即使 `pass` 也不能自行批准；批准只能进入下一阶段的独立人工决策记录。

## Phase 6: local-owner human approval（当前已实现）

`GET /api/evolution/approval-reviews/:evaluationId` 生成只读审查包，包含 baseline→candidate 全文替换 diff、candidate/dataset provenance、replay 模型与隔离参数、逐 case evaluation、权限请求和明确的 baseline rollback target。宿主同时返回四个必须逐字确认的不可变标识：candidate content SHA-256、replay run fingerprint、evaluation fingerprint 和 rollback baseline SHA-256。

`POST /api/evolution/approvals` 只记录 `approved|rejected` 人工决定，并要求 1–2000 字符理由和上述四项精确确认。安全边界如下：

- 所有 approval review/create/list/get 路由都要求已登录、TCP loopback、`AUTH_MODE=local` 且当前用户是已固定的 local owner；multi-user 模式 fail closed；
- 同一 evaluation 只能产生一条 append-only 决定；改变决定必须创建新的 replay/evaluation，不能更新旧记录；
- `approved` 仅接受 prompt candidate、宿主 verdict=`pass` 且 `permissionsRequested=[]`；非 pass 或 plugin/config 不可批准，新增权限返回 `EVOLUTION_APPROVAL_PERMISSION_CHANGE_UNSUPPORTED`；
- `rejected` 仍绑定相同不可变证据和 rollback target，不能成为绕过确认的弱路径；
- approval 保存脱敏 review snapshot、local-owner-loopback approver mode 和 decision fingerprint；所有响应 `Cache-Control: no-store`；
- approval 不修改 candidate 的 `proposed` 状态，不写 active prompt/config，不加载 plugin，也不存在 apply、install、activate、deploy 或 rollout 路由。

## Phase 7: scoped prompt canary（当前已实现）

`POST /api/evolution/canaries` 只从 P10 的不可变 `approved` 决定创建尚未运行的 canary release；本地所有者随后必须显式调用 `POST /api/evolution/canaries/:id/start`，创建本身不会隐式分流。当前唯一支持的目标是 `prompt:workspace-instructions`；candidate 必须是 prompt、evaluation verdict 必须为 `pass`、`permissionsRequested=[]`，且 candidate/replay/evaluation/approval 的内容和四项指纹链必须再次一致。

安全与流量边界：

- create/start/list/get/stop API 均要求已登录、TCP loopback、`AUTH_MODE=local` 和固定 local owner；multi-user 模式 fail closed；所有响应使用 `Cache-Control: no-store`；
- 创建时必须显式提供 1–10 个属于当前用户的聊天 session，以及整数 `trafficPercent=1..10`；不存在全局 scope、100% rollout、plugin/config canary 或 renderer/runtime 权限变化；
- release 保存不可变 approval/evaluation/replay/candidate 引用、创建理由、session scope、流量比例、baseline/candidate SHA-256 和 release fingerprint；显式 start 前再次验证完整 provenance 和实时 baseline，start/stop lifecycle 使用独立 append-only event，已停止 release 不可重新启动；
- 分流使用 `release fingerprint + sessionId + turnId` 的稳定 SHA-256 bucket，同一 turn 不会因重试改变 variant；control 与 candidate 使用同一正常 TurnEngine，仅替换 workspace instruction block，不覆盖 identity、Ishiki、安全、skill、memory 或 session block；
- 创建 release 和每个 turn 执行前都会读取当前 workspace instructions。SHA-256 与 replay baseline 不一致时绝不注入 candidate，而是追加 `baseline_mismatch`/`baseline_unavailable` 的 fail-closed baseline assignment，保留观测而不静默忽略漂移；
- 每个 assignment 都保存 variant、bucket、decision reason、approved/observed baseline SHA-256；`turn.completed|turn.failed|turn.cancelled` 后追加一次 terminal outcome，只白名单保存 token usage、provider cost、耗时和规范化错误码，不保存 prompt、transcript、tool trace 或 raw payload；detail GET 最多返回最近 200 条白名单化 observation，list 只返回聚合统计；
- `POST /api/evolution/canaries/:id/stop` 是当前唯一停止能力。stop 后新 turn 不再被分配；已分配的同一 turn 保持稳定 assignment，恢复执行时仍实时重验 baseline；没有自动阈值、自动 stop、自动 rollback、apply/install/activate/deploy 路由。

Canary outcome 是可靠性、延迟和成本观测，不是自动质量 verdict；人工批准也没有被提升为全局激活权限。

## Required next gate

后续只能进入 **Automatic rollback**：预先声明阈值，并在质量、安全或可靠性退化时恢复 approval 中已绑定的 baseline 不可变版本。P12 实现前不得把 P11 的观测直接解释为自动 rollback 授权。

任何候选都不能扩大 manifest `contributes`、工具风险信任或 renderer 执行权限而不经过独立权限审批。磁盘 transformer 仍只能在 worker sandbox 中运行，不能注入 React/renderer JavaScript。
