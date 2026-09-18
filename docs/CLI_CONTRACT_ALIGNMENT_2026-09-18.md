# CLI 契约与输入生命周期复核（2026-09-18）

## 范围与依据

用户提供 `C:\Users\21161\WorkBuddy\2026-09-16-23-05-22\gugo-agent-gap-review-2026-09-17.md` 及新审查要点，授权结合实际代码修复。已完整读该文档、最新 AGENTS.md、git status 和上轮执行记录；保留既有 dirty 改动，不修改 Pi、真实配置/凭据，不调用模型服务、不提交推送。

Pi 交互进程存活，但对应会话最后实际消息仍为 2026-09-17 assistant/stop，此后只有设置事件，无执行子进程；没有抢占 Pi 当前修改回合。

## 已确认的当前缺陷与决策

1. 旧 `modelCatalogCache.js` 及 `localDefaultModelNames` 只剩旧测试消费，真实 chat 已使用 `interactiveModelCatalog`。清理前备份源码，不删除用户磁盘缓存或历史报告。
2. `assertModelCatalog` 的旧方法形状不匹配真实目录且未接线。按真实 `list/entries/diagnostics/refresh/select/close` 对齐，在 chat 装配处校验，测试消费真实实现和装配失败路径。
3. 报告把 readline 并发描述为“排队”并不准确：当前实现是直接覆盖单个 `pending` 回调，可能让第一问永远等待。统一为一个待回答问题，重入 `CLI_INPUT_BUSY`。
4. 单问 `{ signal }`、全局 signal、EOF、clear、suspend 和 close 要有同一行为契约；单问取消后可继续，EOF/close 后不可重开。EOF 不提交半行但允许既有完整行队列排空；显式 close/全局取消清队列。丢弃未提交草稿，保留已接收完整行与审批输入隔离。
5. `auto` 明确作为旧配置的 readline 别名，不引入尚未验收的自动 Ink 切换。合法的主要模式是 readline/ink；帮助、错误与文档说明兼容别名。
6. React/DOM 19.2.6、Ink 7.1.1、string-width 8.2.2 已精确声明；现有 useEffectEvent、字素及宽度修复不重做，不升级依赖。

## 补充报告的历史结论校准

报告包含多天的基线、实施和自我修订，不能将早期所有条目视作当前缺陷。当前已有最终 wire 诊断、`trace --export otel` 的 OTLP/JSON spans、completion policy 元数据、v120 词法索引与 embedding 空间重建、managed 附件及真实模型验收。它们不等于实时 OTLP Collector、跨 Turn 指标时序或 ANN，但也不再是“零实现”。

loop 显式类型覆盖、更少的控制耦合、ANN/rerank/大库评测、跨 Turn 缓存指标与更完整的独立进化验证仍是后续工作；不因文件数、catch 数或 Pi 的更小功能范围，直接删除权限/未知结果恢复策略或降低工程门禁。

## 实现与定向验证

- 旧模块/旧专用测试删除前逐字节比对 SHA256。恢复备份位于 `C:\Users\21161\AppData\Local\Temp\gugo-cli-contract-alignment-8dda2c25d3cc42c5b5588a542b331f27\removed-source`，其中 README 记录源路径和哈希；未删除磁盘缓存。生产及测试中旧模块/`localDefaultModelNames` 引用为零。
- 新 ModelCatalog 契约先得到 8 个红例，修复后契约/装配 11/11；关联目录、模型绑定和会话 6 文件 65/65。主线整合真实 cache 行为另跑 5 文件 26/26；实际 Node20 的契约/装配 11/11。
- 删除旧测试没有丢弃有效验证：新增 `interactiveModelCatalogCache.test.js` 针对真实目录覆盖并发刷新去重、同步内存快照、坏/跨作用域/过期/未来缓存拒绝、离线缓存只展示、写盘失败不阻断有效本地选择，3/3 通过。旧的“空刷新保留已删除名字”行为没有迁移回生产。
- 输入生命周期先复现 29 项中的 11 个失败；修复后 Node22 相关 12 文件 123/123，实际 Node20 纯输入 4 文件 48/48（Ink renderer 注入，真实 Ink 仍要求 Node22+）。EOF 提交队列的兼容规则由既有真实 stream 会话测试及新增反例共同保护，没有删除原断言。
- 两种输入路径现在均拒绝覆盖 pending 的并发 question，处理 request/session signal，清理监听器/终端所有权，丢弃未提交草稿与交接期间的原始缓冲。Ink wrapper 只让明确的 keyboard cancel 参与两次 Ctrl-C；EOF、signal、暂停和意外 renderer 退出不会当成 Ctrl-C 自动重挂。键位模型和 CJK/字素行为未改。
- 帮助输出先红后绿（2/2）：canonical 模式为 readline/ink，auto 为明确的 readline 旧配置别名，错误文案、HELP、`.env.example` 和 CLI.md 一致。
- main 在 Windows 真 PTY 对 readline 和 Ink 分别执行：busy guard → 输入中文/emoji 草稿 → Ctrl-C 驱动单问 AbortSignal → 下一问空草稿 → 提交 `AFTER-CANCEL-CLI` → 重复 close → 后续 null/rawMode=false/exit0。没有数据库或模型。Ink 的“文本＋回车同批输入”按粘贴保留换行，因此以独立 Enter 验证提交；没有把粘贴语义当作回归改掉。
- lint 零 warning；typecheck（14 反向 fixture）、依赖 manifest、AST 复杂度（0 违规/0 parse error）、debt 13/13 已通过。

离线评测已通过 61/61。日志根：`C:\Users\21161\AppData\Local\Temp\gugo-cli-contract-alignment-8dda2c25d3cc42c5b5588a542b331f27`。

交叉复核另找到一处实际启动清理遗漏：无效输入模式在 reader 创建时抛错，但目录刷新已经启动且未进入 finally，探针得到 `refreshes=1, closes=0`。已将已有 finally 扩到输入/history/setup 装配边界，刷新延后到输入与 setup 成功后；清理即使一层失败仍执行后续 reader/catalog/附件队列释放。5 个红例转绿，Node22 关联 66 通过、1 个 Node20 专属跳过，实际 Node20 assembly 9/9；2 文件 lint 与差异检查通过。

这项清理是在全量运行期间的晚发现补丁，因此主线额外枚举并运行 `tests/cli` 全部 45 个测试文件，单独记录最新代码的 CLI 整包结果，不把早先的全量时间点混为同一次冻结。

## 最终整合结果

- `npm test`：**994 个测试文件 PASS**（9 个普通批次与隔离 UI 阶段均完成），见 `full-test.log`。
- 最后启动清理补丁后，显式枚举并运行全部 **45 个 CLI 测试文件**：**336 passed / 1 skipped / 0 failed**，见 `all-cli-final.log`。跳过项仅在实际 Node20 验证 Ink 版本前置失败，该分支已由 Node20.19.0 assembly **9/9** 实测覆盖。
- 最新全仓 lint 零 warning，见 `lint-final.log`；typecheck、依赖清单、AST 复杂度与 debt 门禁全部通过；离线评测 **61/61**。
- 两份死代码/旧专用测试已备份移除，生产及测试零旧引用；模型目录装配失败会立即以稳定契约错误拒绝，不开始刷新、模型调用或接管输入。
- 真 Windows PTY 的 readline 与 Ink 均 exit 0，busy/取消/空草稿继续/永久 close/raw-mode 清理结果见 `terminal-probe-results.json`；没有假装测过真实模型或实体键盘矩阵。
- 本轮未改依赖版本、权限边界、DB schema、网页样式、Pi 或真实配置，也未提交/推送/重新打包。上轮 R2 不包含这次新增源码修复，不能标作本轮最新产物。

## 边界

- 本轮仅修改 CLI 契约、输入生命周期及必要测试/说明，无模型、权限、DB schema、依赖版本或网页外观变更。没有调用真实模型服务。
- 真 PTY 不等于所有实体键盘、IME、终端和 OS 矩阵均覆盖；Node20 纯输入测试不等于 Node20 原生 SQLite/真实 Ink 验收。
- 之前 R2 ZIP 是上轮快照，本轮不拿旧包冒充最新源码；没有重新打包、提交、推送或发布。
