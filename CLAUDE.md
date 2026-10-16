# CLAUDE.md

> 同 `AGENTS.md`。Claude Code 也读这一份，避免双份维护。

请打开并完整读 [`AGENTS.md`](./AGENTS.md) —— 那里有项目结构、分层红线、commit/PR 约定、i18n 规则、prompt compiler 注入路径、常见踩坑、和给 AI 助手的硬规则。

读完再动手。

## 当前交接入口

接手本地项目时，接着阅读 [`docs/CLAUDE_CODE_HANDOFF.md`](./docs/CLAUDE_CODE_HANDOFF.md) 和 [`docs/CURRENT_STATE.md`](./docs/CURRENT_STATE.md)。交接页说明最新本地实现提交、已验收行为、剩余边界、测试入口及下一轮计划；旧报告的“未提交”标记是验收当时状态，以 Git 和最新交接页为准。

先只读核对目录、Git 状态和用户下一项需求，不自动延续旧 TODO，不自动推送或打包。不要改动现有“侧边栏／本次改动／预览／任务清单”的入口和主布局。
