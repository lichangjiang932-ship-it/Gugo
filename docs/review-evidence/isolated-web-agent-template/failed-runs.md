# 本轮验收失败记录（保留，不改写为通过）

这些是本轮验证启动环境的失败，不是业务修复的成功证据。最终状态以同目录 `verification.json` 和对应冻结结果为准；通过代表性复验不能替代从头全量。

## 全量尝试 1：错误复用 Web build 环境

- 退出码：1；runner 汇总：`FAIL (144 final failure(s))`。
- 耗时：1818.371 秒；3195 个源码/配置文件运行前后哈希一致。
- 冻结记录：`source-manifest-failed-env.json`、`freeze-result-failed-env.json`。
- 原始日志：系统临时目录 `gugo-round1-full-final.log`，可能被系统清理。
- 部分明确错误：
  - `act is not a function`：Web 环境设置 NODE_ENV=production，React 测试 API 不可用。
  - HTML 远程图片 CSP 及 Access fixture：Web 环境强制 pure-local 行为，改变测试意图。
  - `CREDENTIAL_VAULT_KEY_PERMISSIONS_UNSAFE`：Web 环境的合成 Windows 域影响临时密钥 ACL 的真实账号解析。
- 第一次环境纠正：测试模式、不强制 pure-local、仅保留必要 OS 账号发现；代表性 5 文件/35 项通过，但尚未解决全部全量环境差异。

## 全量尝试 2：仍残留 Web 专用默认值

- 退出码：1；runner 汇总：`FAIL (8 final failure(s))`，这里的 8 是失败批次记录，不是只有 8 个失败用例。
- 耗时：1151.981 秒；3195 个源码/配置文件运行前后哈希一致。
- 冻结记录：`source-manifest-corrected-env-fail.json`、`freeze-result-corrected-env-fail.json`。
- 原始日志：系统临时目录 `gugo-round1-full-corrected.log`。
- 明确的环境不匹配：
  - `MCP stdio 已被环境禁用 (MCP_STDIO_ENABLED=0)`：阻断本地测试 transport fixture。
  - `writer.function is not a function` 及 SQLite writer 错误映射断言：强制 Node SQLite 驱动，与既有 better-sqlite3 用例预期不匹配。
  - 工作区 `ENOENT`、历史/本机 onboarding 路径不等：外层设置了不存在的共享 WORKSPACE_ROOT。
  - Hook fixture 在该工作目录下不能执行，后续审批等待超时。
- 第二次环境纠正：不再复用 Web helper。独立 OS 环境白名单＋临时 HOME/配置/数据/DB/产物/tmp/cache；NODE_ENV=test、GUGO_LOAD_DOTENV=0，不指定工具禁用、SQLite 驱动、WORKSPACE_ROOT 或真实模型配置。
- 全部 13 个失败文件/138 项通过（退出 0、runner PASS），无业务源码、测试或断言变动。原始复验日志：`gugo-round1-minimal-env-probe.log`。

## 其他失败与边界

- 早期隔离测试导入尚不存在的 helper 失败，只证明实现缺失，不证明已复现 dotenv 泄漏。
- 新模板组件测试在修复前 10 项中 7 项失败，保留 `gugo-agent-template-ui-07t4hx/red.log`。
- 初次隔离构建退出 0 但 Tailwind content 缺失，不作为最终样式构建证据。
- internal-worker 直调在修复前不拒绝（实际退出 0），真实红灯见 `gugo-round1-worker-red.log`；后经 IPC＋环境/cwd 校验修补。
- 新增 CLI 测试首次缺失临时 TEMP 父目录；随后 Windows 自动补入用户发现键又被完整环境校验拒绝。两次失败均保留，见 `verification.json`。
- 浏览器工具三次返回错误配置，均停止。无原生键盘或视觉 PASS；不以离线/构建证明代替。
