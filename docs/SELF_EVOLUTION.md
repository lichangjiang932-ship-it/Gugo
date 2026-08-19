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

不存在 candidate update、delete、apply、install、approve 或 rollout API。`permissionsRequested` 只是等待后续独立权限审查的元数据，不授予 manifest contribution、工具信任或 renderer 权限。

## Phase 4: isolated replay（当前已实现）

`POST /api/evolution/replay-suites` 创建 user-scoped、不可变 replay suite。每个 suite 绑定一个 P6 dataset fingerprint，包含 1–10 个显式 case；case 的 title/input 会再次脱敏并绑定 curated source record。dataset 过期或 record 不存在时 fail closed。

`POST /api/evolution/replays/run` 当前只接受 `prompt` candidate：

- suite 和 candidate 必须来自同一 dataset fingerprint；plugin/config 在具备专用 sandbox harness 前返回 `EVOLUTION_REPLAY_KIND_UNSUPPORTED`，不以文本模拟冒充真实执行；
- baseline 与 candidate 使用完全相同的 case、显式固定 model、temperature 和 maxTokens；实际模型名发生漂移时 run 失败；
- 每次模型调用都没有 tools。候选不能访问文件、网络、service 或 runtime state；仅宿主到已配置 model provider 的推理传输存在；
- baseline、case 和双方输出都经过敏感信息脱敏；任一调用失败、输出为空或过大时不写入部分 run；
- 完成后保存双方输出、耗时、模型参数、baseline/candidate SHA-256、suite/candidate 引用和整体 run fingerprint。

`GET /api/evolution/replay-suites`、`GET /api/evolution/replays` 返回摘要，单项 GET 返回不可变详情；全部 `Cache-Control: no-store`。Replay 结果没有 verdict，也不存在 evaluate、approve、apply、install 或 rollout API；同场输出不等于质量结论。

## Required next gates

后续能力必须按以下顺序增加，不能跳级：

1. **Evaluation**：结构化 rubric、独立 Reviewer、回归/安全/成本/延迟指标；缺证据不得 pass。
2. **Human approval**：显示 diff、来源、评测结果、权限变化和明确回滚目标；仅本地 owner 可批准。
3. **Canary rollout**：小比例、限定作用域、不可变版本标识和完整观测。
4. **Automatic rollback**：预先声明阈值；质量、安全或可靠性退化时恢复上一不可变版本。

任何候选都不能扩大 manifest `contributes`、工具风险信任或 renderer 执行权限而不经过独立权限审批。磁盘 transformer 仍只能在 worker sandbox 中运行，不能注入 React/renderer JavaScript。
