# Independent Task Reviewer

Gugo 的 Job verify 阶段支持独立模型 Reviewer。实现位于 `server/services/taskReviewer.js`，通过现有 `TaskEvaluator` SPI 接入 `createDefaultExecuteStep()`。

## 配置

```env
JOB_REVIEWER_MODEL_NAME=your-independent-reviewer-model
JOB_REQUIRE_INDEPENDENT_REVIEWER=1
```

- `JOB_REVIEWER_MODEL_NAME` 必须是当前用户模型目录中可调用的模型名，并且必须与 Job 持久化的 `modelName` 不同。
- `JOB_REQUIRE_INDEPENDENT_REVIEWER=1` 开启严格模式。Reviewer 未配置、worker 模型未知、两者同名、Reviewer 调用失败或没有返回合法结构化 marker 时，裁决为 `blocked`，Job 不得进入 `completed`。
- 严格模式关闭且无法证明模型隔离时，保留兼容的 worker self-evaluation，但持久化 `reviewer.independent=false` 和具体 fallback `mode`，不会冒充独立审查。

## 裁决协议

Reviewer 只能返回一个结构化 marker：

```text
<task_evaluation>{"verdict":"pass|fixable|blocked|needs_user","summary":"...","issues":[],"evidence":[]}</task_evaluation>
```

Reviewer 不继承 worker 的工具循环，也不直接修改任务。它读取有界的目标、完成标准、已完成步骤摘要、artifact IDs、worker verification 和验证证据，并拥有终态否决权：

- `pass`：允许 verify 完成；
- `fixable`：进入有界 repair → reverify；
- `blocked`：阻止完成并保留结构化原因；
- `needs_user`：转成可恢复 waiting/paused 状态。

## 审计

每次最终 verify 裁决都会写入：

- verify step 的 `output.acceptance`；
- `task_reviewed` Job event；
- 失败事件中的 acceptance payload；
- finalize output 的 acceptance 对账。

`acceptance.reviewer` 包含：

- `independent`；
- `mode`；
- `reviewerModel`；
- `workerModel`；
- Reviewer 调用失败时的有界错误摘要。

## 安全边界与限制

- 当前保证的是**显式模型名隔离**，不是供应商/账号/物理进程隔离。上游 provider failover 是否仍落到同一模型实例取决于模型配置。
- worker 没有持久化明确模型名时，系统不能证明隔离，因此严格模式 fail closed。
- Reviewer 只能依据提供的证据裁决；它不是事实数据库。worker 自述不被视为独立证据。
- `taskEvaluator` 仍可由测试或后续 runtime plugin adapter 替换；第三方 evaluator 必须保持同一 verdict 和审计协议。
