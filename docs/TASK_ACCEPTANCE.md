# 目标级验收与自定义验证

此文件维护目标契约的当前语义。产品、安全和数据归属约束见 AGENTS.md；当前实施状态见 CURRENT_STATE.md。

## 四个不同结论

1. 工具执行成功：操作返回了确定成功结果。
2. 检查通过：特定检查产生了通过结果。
3. 检查覆盖：其范围/版本覆盖当前修改。
4. 目标满足：用户显式要求的行为或交付物具有对应证据。

低一级不能自动冒充高一级。退出码、模型文本和审查模型判断都不是通用的目标满足证明。

## 显式 contract v1

Goal step 的 acceptance 数组现在可包含：

```json
[
  {
    "kind": "contract",
    "version": 1,
    "checks": [
      { "kind": "command", "command": "./scripts/verify.sh", "cwd": "/project" },
      { "kind": "file", "path": "/project/report.md", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    ]
  }
]
```

摘要示例不是任意文件的真实摘要。实际使用必须从独立、授权的验证获得期望值。

- schema 见 shared/taskAcceptanceContract.js。非空、最多 16 条；未知版本/字段/类型拒绝，不降级为任意工具通过。
- 所有条件 AND；command 必须精确命令、目录和最终成功退出。
- file 必须同一路径和 SHA-256；后续覆盖或结果未知的写入尝试不能沿用更早摘要。
- artifact 绑定具体 ID；若需要语义/布局还须声明对应独立验证，不把有 ID 等同质量通过。
- verification 绑定 checkKind/cwd，而非随便一个任务验证结果。
- manual 仍需可信人工入口；模型工具不能制造人工确认。

复用 goalPlanEvidence / goalPlanService 的会话、版本、审批和宿主持久事件路径，不创建第二套有权威的模型声明。计划本身是需求声明；真实性来自宿主事件，不来自 contract 字段名称。旧验收数组和旧无条件工具兼容保持，但不因此成为强目标契约。

## 自定义检查入口

### 包脚本

run_project_check 支持已配置的 `test`、`lint`、`build`、`check`、`typecheck` 及其命名空间，如 `check:all` 或 `test:integration`。只读查看受限大小的普通 package.json；未配置则返回 executed=false，不伪装失败测试或执行命令。

- 传输 schema 使用安全字符/长度约束，运行时再限制检查命名空间。
- 禁止 start/deploy 等任意脚本，不接受分号、重定向、变量替换等 shell 文本作名称。
- 不同脚本拥有不同验证 family/scope，`test:smoke` 不能清除 `test:all` 的失败。
- 命名只表达入口类型，不证明脚本内容不会写文件；仍依赖现有工具、目录、Shell 和副作用边界。不是 OS 沙箱。

### 项目自己的验证脚本

通过结构化 `run_test` 执行 `./scripts/verify.sh` 等，并在显式 contract 中绑定 exact command/cwd。已有 targeted fallback 保留；它不要求把所有 shell 命令猜成验证。

普通 bash 的保守识别器仍保留 8 段上限和非判定/有歧义参数排除。没有通过放宽任意链、无测试选项、目录授权或命令权限来“提高识别率”。

## 宿主阶段接口

verificationObservationStage 只接受 VerificationStageInput 与 VerificationStagePorts。它没有 s、s.d、数据库、模型和 Shell 端口；返回只读效果。verificationObservationConsumer 是严格检查的生产 consumer。旧 runtime-recordVerificationObservations 仅负责适配和应用效果，PDF 验证仍走既有处理。

这是逐阶段收敛的第一步，241 项总依赖袋仍在，其余阶段需独立迁移；不把局部成功写成依赖袋债务关闭。

## 测试政策

- 业务交互用真实组件/Hook/协议行为测试，不锁定回调字面写法。
- 尺寸、禁止导入和真实依赖方向属于合法结构约束，可用 AST 检查。
- 保留尚未迁移的源码断言清单，不一次性删除安全网。
- 构造无关通过、错误路径、错误摘要、未知结果、覆盖后旧证据、跨会话与错误契约版本等反例。

## 任务级评测

`evals/task-outcomes-suite.json` 使用独立 live 入口，检查实际报告文件、CSV 转义、负调整金额和不可变输入；判定器在复制 workspace 外。默认测试只验证判定器拒绝缺失/错误结果并接受正确参考产物，不调用 Provider。

真实执行前必须另行指定模型、权限及资源范围。禁止把参考实现/离线通过或一次受控任务通过称为所有真实任务成功率。
