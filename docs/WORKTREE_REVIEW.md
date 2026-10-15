# 工作树审查与分域落地

此文档维护当前拆分规则，状态入口见 CURRENT_STATE.md。它不是自动提交授权。

## 现场保护

治理开始时 HEAD 为 b5698be、main 分支、暂存区为空；90 个已跟踪修改、123 个展开后的未跟踪文件。先将 213 个代码/测试/文档/证据文件复制到外部临时目录，记录逐文件 SHA-256 与 tracked binary patch。排除凭据、环境文件、运行数据库、node_modules、构建/发布目录，不复制 .git。

快照：系统临时目录 `gugo-contracts-9kILeD/snapshot/`。这是本次会话的恢复证据，不是永久备份承诺。没有 reset、stash、覆盖用户未提交文件，也没有因通过测试自动 commit/push。

## 可重复盘点

```bash
node scripts/review-worktree.mjs > review.json
```

只读输出：候选分组、依赖顺序、共享文件的逐块审查要求，以及已修改文件对新文件的跨批相对导入。它不会读凭据、改 index 或操作远程。

分组只是候选，不是独立通过的 commits。AST 只查静态相对导入，不声称覆盖动态加载、CSS、运行时服务注册或所有语义依赖。

收尾对 208 个符合范围的改动文本做了不输出值的凭据模式筛查：唯一命中是 HEAD 已有的 `git_commit refuses credential filenames the repository never ignored` 测试中的 PEM 标签，不是本轮新增凭据。未读取真实环境/密钥文件。模式扫描不等于完整密钥审计，PNG 等二进制证据仍需人工决定是否适合入库。

## 候选顺序

1. artifact-policy：产物拒绝作用域、恢复计数及回归。
2. foundation-ui：共用操作控件与输入法事件工具。
3. session-and-sidebar：删除/重命名/本机连接/侧栏，与必要基础控件一起验证。
4. usage-ledger：读取覆盖率、累计账本、来源归因。
5. request-context-protocol：共享 DTO、发布/存储/水合、请求/编译/上下文观测。生产者与消费者必须成组。
6. workbench-details：文件名、抽屉、局部阅读样式；不影响作品排版。
7. acceptance-and-stage-contracts：本轮显式目标契约、自定义检查与窄阶段。
8. evaluation-and-types：受控任务、外部判定器、严格调用和负向类型用例。
9. docs-and-evidence：权威文档入口、债务进度与各批证据，不重复写一份当前规范。

共享文件（例如 LeftRail、turnEvents、turnEventDispatch、sessionSnapshot、turnLoopExecutionRuntime、ChatSplitView、package.json）不能按文件夹盲拆。保留跨批新导入清单，逐 hunk 审查并连同消费者落地；没有得到提交权限前不修改原 index。

## 已做隔离验证

通过 git archive 取得 b5698be 的受限源代码副本，仅叠加快照中的产物策略组：

- server/services/loop/artifactFormatRejections.js
- server/services/loop/runtime-createOutcomeRecorder.js
- server/services/loop/runtime-initializeArtifacts.js
- server/services/loop/runtime-initializeExecution.js
- 对应 4 个 artifactFormat/Checkpoint 测试

在独立目录使用现有依赖的 junction 与隔离测试环境，4 个文件/10 项通过。原仓库的分支、index、原文件均未更改。

这是该组的定向依赖边界证据，不是所有候选组都可独立提交的证明。其余组仍需共享文件 hunk 闭包审查与各自回归，不将通篇工作树全绿冒充每个中间 commit 全绿。

## 落地条件

- 授权本地提交后：为各候选创建隔离 staging/index 或副本，逐批检查导入闭包、测试与构建，再形成原子提交。
- 未授权推送时不改远程，不使用会话中暴露的令牌。使用本机凭据存储准备认证，不把新令牌写入报告或仓库。
- 强目标验收、剩余源码断言、依赖袋与全仓类型安全属于持续工作，不以“已分类”宣布技术债务全部消失。
