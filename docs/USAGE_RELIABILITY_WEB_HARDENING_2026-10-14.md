# 用量账本、请求诊断与 Web 可靠性修复

2026-10-14。基线 HEAD `b5698be`，在此前未提交工作树上继续；不重置现场、不提交、不推送、不发版。用户已确认计划，明确本轮不处理桌面专属事项。

## 1. 范围与前提

本轮涉及本机后端、共享协议、Web 界面、测试与评测夹具。保持本机免登录，内部身份仍用于归属与权限。没有取消目录授权、审批、回环监听、密钥保护或原有完成证据闸门。

不处理 Electron 安装包、BrowserView、原生文件选择器、签名/更新。浏览器使用独立临时 Edge profile，只是 Web 验收工具，不代表桌面安装包验收。

## 2. 用量账本

### 已修复的累计错误

`localUsageReportService.js` 与新 `usageLedger.js`：

- 同一 owner/session/turn 的暂停、恢复、完成快照只贡献一次累计用量。
- 最新状态按 Turn 内 sequence 决定，不因系统墙钟回拨选错旧状态。
- 完结记录没有有效用量时保留此前最近的有效累计观测，非法/null 计数不能抹掉已知用量。
- 无 Turn ID 的旧记录不擅自合并，避免把不同旧回合当成同一个。
- 有明确 modelRequestId/physicalAttempt 的重复 completed 观测只统计一次；不凭相同计数猜测请求重复。

回归：暂停 500、完成 800 → 1 个 Turn、800 输入 Tokens，而不是 2 个 Turn、1300。

### 日期口径

- 全历史总量：每轮最新已记录的累计快照。
- 带 since 的时间范围：范围内已记录的 completed model response 用量。
- 整轮累计另放在 `turnCumulativeTotals`；`accounting.basis` 明确来源，不把整轮跨期消耗塞进完成日期。
- 日历范围使用本地日期运算，不靠固定 24 小时减法跨 DST。
- 以上都是已记录数据，不是所有物理尝试/失败请求的完整消耗。截断、缺失与模型明细差异提示保留。

### 实际来源归因

来源取实际 fenced provider attempt，不拿默认配置猜 failover 后的来源。记录公开 Provider ID、端点/配置摘要与物理请求身份；不记录 URL、Authorization、API Key 或请求正文。

同名模型按 Provider/端点/配置分组，缓存计数重叠估算也按该连续性分开。UI 使用模型名、来源和报告内组别编号，不显示摘要串。旧事件缺来源仍保留为旧口径分组，不伪造来源。

## 3. 连续重命名

新增 `sessionRenameCoordinator.js` 与 `useSessionRename.js`：

- 同会话显式意图串行，旧响应不覆盖新的乐观名称。
- 提交前读取规范 metadata，写入附 expectedRevision。
- SQLite UPDATE 在 SQL 内原子判断版本；可选版本字段沿 HTTP → Port → Store 传递，旧调用未提供该字段时保持兼容。
- 用户名、其他会话、数据源/身份切换的旧结果不回灌当前界面。
- 外部更名与版本冲突不自动覆盖；未知结果不重放，并阻止排队中的后续写入冒充成功。
- 失败 observer 只收到归一化公开事实；不展示服务端原始诊断。

真实 Web+SQLite 验收人为延迟 A 的回包，再提交 B：等待时仍显示 B，B 在 A 返回后提交，携带更新后的版本，数据库最终名称为 B。

第三方 SessionAdmin 后端如实现条件重命名，必须原子遵守 expectedRevision 契约；本轮实际验证的是默认 SQLite 后端，不声称替第三方实现了原子性。

## 4. 编译与前缀诊断

### 本机编译

`cachedBuild()` 返回本次块的 hit/miss 观测，不采用进程全局计数差值。

Turn 准备阶段关联 identity/ishiki/skills/sessions 观测；同轮后续模型调用标为 turn_reuse；恢复标为 checkpoint_reuse。复用不再重复计作新的缓存查找，也不当成本进程或上游 KV 命中。

### 跨 Turn 比较

当前轮内已有比较时优先使用；否则取同会话上一轮公开 wire 元数据。仅在 owner、端点、模型、配置均可比较且未截断时比较；缺摘要不当作相同。

Web 验收暴露了真实断层：历史消息水合时原来没有保存 wire/编译观测。现已将经过 schema 白名单校验的诊断保存到宿主检查点/助手 modelContext，并由真实 snapshot normalizer 恢复，加入 JSON 往返/水合回归。旧记录没有这些字段时保持未知，不假造历史。

观测字段不进入模型正文，不改变 Prompt/工具权限，不成为执行或验证权威。原始请求、请求头和私有推理不显示。

## 5. Web 输出与性能

### 浏览器时间

宿主事件时间与浏览器 clock 分开。新增请求范围内的可见 DOM 检查与双 RAF 绘制机会观测，带 owner/session/message/request 标识，重复结果不膨胀；后台页、遮挡、未看到起点等情况保持未记录。

这是“本页观测到公开输出绘制机会”，不是 OS 物理呈现、Provider 首 Token，也不是精确屏幕 TTFV。公开输出缓冲和完成证据闸门没有放开。真实假模型链路显示过约 0.2 秒观测，数值受受控释放与运行负载影响，不用于产品延迟承诺。

### 排序瓶颈

旧排序每次比较重复解析活动和置顶时间。现在先装饰每项，只解析一次，比较阶段使用数字。保留置顶、时间、ID 与稳定排序规则，不丢旧会话。

`npm run benchmark:sidebar`：5000 会话、30 次排序，所有顺序逐次一致。

| 路径 | 中位数 | P95 |
|---|---:|---:|
| 原比较器 | 56.675 ms | 59.223 ms |
| 时间戳预计算 | 3.511 ms | 4.705 ms |

这是 Node 局部排序，不是全应用 FPS。

Web 合成 2000 会话：70 行、898 个 DOM 元素；在并发全量测试负载下记录一组 RAF 间隔 median 6.1ms / P95 30.1ms。该结果是有界目录观察，不是长期流式帧率或性能 SLA。没有盲目再引入虚拟列表，也没有缩小字号、隐藏活跃项来消红。

上下文预算/诊断组装抽到 `useChatContextUsage.js`，保持既有组件尺寸预算，而不是放宽门槛。延续本轮已涉及的 ActionButton、重连、错误与可访问状态，不进行全仓按钮替换。

## 6. 评测夹具

新独立 `evals/reliability-suite.json`，3 个受控任务：累计账本修复、异步重命名顺序、缓存未知/零值区分。每个任务有合成 workspace、基础检查及 workspace 外验证器；默认测试验证夹具与判定器，不调用模型。

独立入口沿用 `scripts/run-live-agent-evals.mjs`。本轮没有选择真实 Provider、读取真实密钥或消耗外部额度，没有把夹具/参考实现通过当成模型成功率。执行真实评测前需另行确认目标模型、权限、任务范围与资源。

## 7. 验证与历史

- 基线：6 个定向文件、70 项通过。
- 最终关键边界定向：15 文件、71 项通过，覆盖账本、来源、请求去重、重命名队列、SQLite CAS、编译作用域、浏览器 clock、评测夹具与排序。
- 持久化/水合修复：5 文件、210 项通过，包含真实 Turn 引擎、Loop wire 与客户端协议回归。
- 确定性离线评测：71 项通过。
- lint、debt、i18n、字典键、依赖、typecheck、复杂度门禁与隔离构建有通过记录。
- 最终从头完整全量：1157 个测试文件 PASS，退出码 0，完整运行 1599.412 秒；不是失败批次重跑拼接。

首次全量在批次 2 发现旧的“必须内联 renameSessionRemote”源码断言，以及 ChatSplitView 达 304 行。前者更新为队列/Hook 契约，并有行为回归；后者抽出职责，未调大预算。该轮主动停止，非完整全量 PASS。

第二轮未观察到定向失败，但浏览器发现水合诊断缺失，主动停止并修根因；不将未完成运行包装成 PASS。最终另起从头回归，日志名为 full-tests-closure。

截图与摘要见 `docs/review-evidence/2026-10-14-web/`，自有 QA 服务/假模型/调试浏览器已关闭。

Web 第一次冷启动在并发测试负载下超出脚本就绪期限，随后通过实际就绪条件继续；另一脚本曾对 React 事件提交使用同步查询，已改条件等待。保留失败记录，不归因成未经证明的生产功能缺陷。

临时验收目录：`C:/Users/21161/AppData/Local/Temp/gugo-ledger-IkutHz`。使用独立数据库、目录和 Edge profile，模型流量仅自有 loopback 假模型。

## 8. 复验入口

```bash
node scripts/run-tests.js tests/usageLedger.test.js tests/usageCoverage.test.js tests/sessionRename.test.js tests/sessionRenameCoordinator.test.js
node scripts/run-tests.js tests/requestDiagnosticsScopes.test.js tests/requestDiagnosticsPersistence.test.js tests/browserOutputTiming.test.js tests/reliabilityEvalDataset.test.js
npm run benchmark:sidebar
npm run benchmark:ui
npm test
npm run eval:offline
npm run lint
npm run typecheck
npm run audit:functions -- --check
```

真实模型入口仅在单独确认后使用；桌面安装包/原生功能验收按用户要求留在本轮范围外。
