# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.10.1] - 2026-08-06

### Changed

- Renamed the public project, repository, package, and desktop update source to Gugo.
- Published the Windows desktop installer through the public GitHub Releases channel.

### Added

- Access 中心新增 4 个官方 MCP 一键安装预设（Fetch / Sequential Thinking / Memory / Playwright），与既有 Chrome DevTools 预设并列，装完即可在对话中调用其工具。
- 新增系统内置技能 `connector-operator`（连接器操作员），指导 Agent 正确使用 Notion / GitHub / Slack / Google Drive / QQ 邮箱 / 受管浏览器等已连接服务，含未连接引导与写操作确认纪律。
- 恢复被误删的 `skill-packs/guizang-ppt` 技能包（歸藏网页 PPT，含 316KB 规范快照），并放宽技能导入单文件/系统提示词上限（96KB → 512KB）使其可正常导入。
- Access 连接弹窗在 OAuth 未配置时展示可折叠的"如何启用 OAuth"引导（环境变量 + 配置文档链接）。

### Changed

- Removed trademark-bearing and customer-specific presentation templates from
  the open-source distribution.
- Added an actionable welcome state for new conversations.
- Added automated production dependency license checks and third-party notices.
- Consolidated release documentation and tagged GitHub Release automation.

## [0.10.0] - 2026-07-31

### Added

- Server-owned chat turns with recovery, approvals, cancellation, and artifacts.
- Provider, MCP, memory, job, subagent, connector, and workspace tool support.
- Local-first single-user mode with optional multi-user authentication.

[Unreleased]: https://github.com/lichangjiang932-ship-it/Gugo/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.1
[0.10.0]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.0
