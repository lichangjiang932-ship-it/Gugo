# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.10.19] - 2026-08-12

### Added

- Added first-class `run_command`, `patch_file`, `run_test`, `docker_exec`,
  `file_download`, and `git_write` tools, including real Python and Node.js
  execution, structured test results, atomic downloads, and complete Git write
  workflows.
- Added browser navigation, click, type, select, and key-press tools backed by
  the existing snapshot references for interactive E2E testing and debugging.

### Changed

- Enabled the complete coding-agent tool loop by default while preserving
  explicit user disables, directory grants, approval modes, and deployment
  locks.
- Made command execution durable across context compaction, task checkpoints,
  retries, cancellation, output truncation, directory authorization, and
  post-write verification.

### Security

- Isolated permissions for every public tool alias, required explicit approval
  for downloads and Git mutations, and prevented hidden legacy switches from
  silently granting write access.
- Added allowlisted credential injection by environment-variable name with
  permanent blocking of Gugo model/auth secrets, exact output redaction, and
  log minimization for credential-bearing commands.
- Hardened Docker command quoting and missing-runtime errors, download atomicity,
  process-tree termination, and approval-card secret handling.

## [0.10.18] - 2026-08-11

### Added

- Added path-based image inspection and transforms, FFmpeg-powered audio/video
  probing and editing, positioned PDF text extraction with CJK-safe transforms,
  and large-file archive workflows for ZIP plus RAR4/RAR5 listing/extraction.
- Added ZIP creation, archive previews, directory-aware batch renaming, exact
  duplicate manifests, and first-run workspace onboarding for file, Shell, and
  Git execution capabilities.

### Changed

- Strengthened the execution harness to call exposed `write_file`, `bash_exec`,
  `pdf_transform`, and related tools directly, recover from structured errors,
  and verify written outputs instead of returning copy-paste instructions.
- Long user messages now collapse into an accessible preview and can be expanded
  or folded again without hiding attachments or skill-command context.

### Fixed

- Prevented length-truncated tool calls from reaching approval or execution while
  preserving protocol pairing and retry checkpoints for safe regeneration.
- Hardened media parameter validation, PDF Unicode font embedding, archive path
  and expansion checks, atomic writes, cancellation rollback, and approval risk
  classification for destructive transforms.

## [0.10.17] - 2026-08-10

### Added

- Added ordered multi-API web search profiles with per-provider enable controls,
  presets, and automatic failover while keeping credentials server-side.

### Changed

- Reworked execution activity into a compact numbered timeline with structured
  progress and independently collapsible arguments and results.

### Fixed

- Generated file names now open directly in the right workbench, and every
  emitted artifact stays synchronized with the Related Files sidebar.

## [0.10.16] - 2026-08-10

### Fixed

- Restored `write_file`, `edit_file`, and `bash_exec` after read-write directory
  authorization, including across suspended background Job checkpoints.
- Bound Job directory resumes to the active verified grant so authorization
  continues the same task without repeated prompts or stale wait recovery.
- Preserved execution intent when a source PDF must remain unchanged while a
  filled copy and PNG previews are created and verified.

## [0.10.15] - 2026-08-10

### Added

- Added guarded local code execution for explicitly authorized read-write
  directories, including Python runtime discovery and real PDF/image workflows.
- Added managed chat attachments plus durable turn leases, checkpoints, recovery,
  steering, cancellation, and structured tool progress events.

### Changed

- Tool loops now repair safe truncated JSON, validate schemas, retry eligible
  read-only failures, schedule parallel reads, reflect on repeated failures, and
  require real execution and verification evidence before claiming completion.
- Chat activity now separates narrative, tool calls, results, and measured file
  progress while keeping send and stop on one primary composer button.

### Fixed

- Inline directory authorization now opens reliably and resumes the same turn
  automatically with the authorized read, write, listing, and execution tools.
- Hardened Windows absolute-path parsing, authorization propagation, turn replay,
  provider streaming compatibility, and final mutation-verification guards.

## [0.10.14] - 2026-08-08

### Added

- Added pinned conversations and six configurable web-search provider templates
  with connection testing and server-side secret handling.

### Changed

- Generated files are now linked directly in assistant narration, open in the
  right workbench, and suppress duplicate artifact cards below the response.
- Session snapshots now restore persisted artifacts so HTML, Office, and other
  supported files remain available after streaming completes or a chat reloads.

### Fixed

- Hardened HTML and Office preview routing while preserving the selected file
  across turn updates and session recovery.
- Stabilized desktop-pet dragging by ignoring synthetic stationary movement,
  preserving fixed transparent-window bounds, and releasing pointer capture.

## [0.10.13] - 2026-08-08

### Added

- Added branded Gugo icons to the desktop app, floating pet window, Windows
  executable, NSIS installer, and uninstaller.
- Added a complete Web release archive with the server, runtime data, locked
  production dependencies, setup instructions, and an isolated health check.

### Changed

- Release builds now wait for the full Linux/Windows test, coverage, dependency,
  secret-scan, and Docker CI matrix before publishing.
- GitHub Release publishing is now safely repeatable and replaces partial or
  stale assets when a workflow is rerun.
- Desktop updates accept stable releases only and explicitly disallow downgrades.

### Security

- Moved build-only Tailwind typography packages out of the production runtime
  dependency graph and pinned the fixed Nano ID release.
- Added a strict production audit gate for the two currently unpatched,
  unreachable `image-size` advisories inherited from PPTXGenJS; exceptions are
  version-locked and expire automatically on 2026-11-06.

## [0.10.12] - 2026-08-08

### Added

- Added unified right-pane previews for PDF, images and SVG, HTML, Markdown,
  text and code, JSON, XML, CSV/TSV, DOCX, XLS/XLSX/ODS, PPTX, audio, and
  video files, with an independent download fallback.

### Changed

- Generated artifacts now use readable semantic filenames with safe numeric
  suffixes for duplicates.
- Generated-file links in assistant narration now open the persisted file in
  the right pane without repeating the same file card below the response.
- Simplified conversation history rows to retain titles and time groups without
  per-session timestamps, message counts, or aggregate totals.

### Fixed

- Made the full composer surface focus the text input while preserving model,
  permission, attachment, voice, and send controls.
- Kept fast desktop-pet drags alive across Electron window movement and reliably
  released pointer input after dragging, hiding, or losing focus.
- Added inline, range-aware, Unicode-safe artifact responses and explicit MIME
  types for current browser and media formats.

## [0.10.11] - 2026-08-08

### Fixed

- Removed the remaining top-right affordance from skill cards while preserving
  full-card keyboard and pointer access to skill details.

## [0.10.10] - 2026-08-07

### Changed

- Redesigned the skill library with consistent semantic icons, concise localized
  descriptions, uniform cards, and a single unobtrusive details action.
- Reworked the left sidebar around a compact Codex-style hierarchy with a
  persistent collapsed mode, grouped conversation history, clearer active
  states, and improved session metadata.
- Refined generated-file references and the right workbench so file output keeps
  its narrative context and opens consistently without preview-state resets.

### Fixed

- Restored conversation history immediately on the first desktop launch.
- Improved session context-menu dismissal and keyboard interaction.
- Fixed desktop-pet pointer capture, dragging, interaction, and right-click close
  behavior outside the main application window.
- Reduced visual noise in reasoning metadata and ordinary HTML previews.

## [0.10.9] - 2026-08-07

### Added

- Added a compact transparent desktop-pet window that stays visible outside the
  main application, follows task status, supports custom pets, and reacts to
  clicks and dragging.
- Added inline generated-file references that open supported files directly in
  the right workbench.

### Changed

- Simplified and organized the built-in skill library while preserving user
  installed and user-created skills.
- Improved right-workbench resizing, scrolling, and artifact-specific actions.

### Fixed

- Fixed desktop-pet white space and animation flicker.
- Fixed session action menus remaining open after clicking elsewhere.
- Removed presentation-only export actions from ordinary HTML previews.

## [0.10.2] - 2026-08-06

### Fixed

- Made the connector skill frontmatter test accept both LF and CRLF checkouts on Windows runners.

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

[Unreleased]: https://github.com/lichangjiang932-ship-it/Gugo/compare/v0.10.19...HEAD
[0.10.19]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.19
[0.10.18]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.18
[0.10.17]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.17
[0.10.16]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.16
[0.10.15]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.15
[0.10.14]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.14
[0.10.13]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.13
[0.10.12]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.12
[0.10.11]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.11
[0.10.10]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.10
[0.10.9]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.9
[0.10.2]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.2
[0.10.1]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.1
[0.10.0]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.0
