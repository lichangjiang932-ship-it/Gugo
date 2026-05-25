# Changelog

本项目所有显著变更记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号采用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- `POST /api/plugins/:id/install-as-skill` — 将 `type=skill-bundle` 的 plugin 安装为当前用户 skill（需登录）
- `server/services/pluginToSkill.js` `installPluginAsSkill({pluginId,userId,existingIds})` — 底座函数，纯函数风格 + realpath 守 symlink + ALLOWED_EXTS=.md/.txt/.json + MAX_FILES=64/256KB
- `server/plugins/pluginManifest.js` `PLUGIN_TYPES` 加 `'skill-bundle'`
- `server/services/skillStore.js` `listAllSkillIds()` — 全库 ID dedup，避免不同 user 装同一 skill-bundle 撞 SQLite PRIMARY KEY
- `plugins/example-skill-bundle/` 示例 plugin
- `src/pages/SkillsMarket.jsx` 上添“从 Plugin”按钮 + 弹层列 skill-bundle plugin + 一键安装
- `src/lib/pluginClient.js` `installPluginAsSkillApi(pluginId)`

### Notes
- 测试 422 → 433（+11 ：pluginSkillBundle 7 + pluginRoutes 新增 5、原 POST 405 用例被替换）
- lint 0 error（保留 2 个历史 warning）、build OK
- 路线图看 [PROGRESS.md](./PROGRESS.md) 。

## [0.9.0] · 2026-05-25

### Added
- Agent 角色卡 zip 导出/导入（对齐 openhanako 角色卡概念）
  - `GET /api/agents/:id/export.zip[?memories=0]` — 打包 `manifest.json` + `agent.md` + `memories/*.md`
  - `POST /api/agents/import.zip[?overrideName=X]` — 10MB 上限，agent.md 缺失返 400，撞名返 409 走 overrideName retry
  - UI：AgentList 加 Package 图标按钮（与既有 `.agent.md` 单文件导出并列）

### Notes
- zip 只打包 agent 专属记忆（不含 global）；导入端绑定到新 agent
- 角色卡 v0.1 格式：`format: 'yma-agent-card'`，未来加 `skills/*` + `avatar.png` 见 PROGRESS #2

## [0.8.0] · 2026-05-25

### Added
- Memory 管理视图加 agent 绑定 UI
  - filter chip Users 下拉 + list item agent badge + editor select
  - `handleNew` 智能继承当前 filter（在 agent X 视图下新建直接绑 X）
- `selectActiveMemoriesForInjection({agentId})` 注入路径返回 "global + 专属"
- `listMemories({agentFilter})` 管理路径只返指定 agent 专属；`__global__` 只看 `agent_id IS NULL`

### Notes
- 管理视图 vs 注入视图的 agent filter 语义不同，不能合并

## [0.7.0] · 2026-05-25

### Added
- 跨标签页 storage 同步（活跃 agent 在多 tab 间一致）
- Templates 弹层 preview
- import 撞名重命名 UX

### Fixed
- **`STORAGE_KEY = '***'` 串台 bug** — v0.5 被 secret-redaction 工具误改成字面量 `'***'`，导致全用户活跃 agent 串到同一 key
- activeAgent 从 effect setState 改为 useMemo 派生，消除 cascade re-render
- react-refresh/only-export-components lint — Context Provider + useContext hook 拆两文件（`ActiveAgentProvider.jsx` + `activeAgentContext.js`）

## [0.6.0] · 2026-05-25

### Added
- DB schema v6：`memories` 表加可选 `agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`
- session sticky agent（会话粘住选定 agent）
- ChatHeader agent 切换器
- 体积治理 + Agent 差异化（详见 `docs/RELEASE_NOTES_v0.6.0.md`）

## [0.5.0] · 2026-05-25

### Added
- Plugin SDK 真消费（manifest 校验 → registry → loader 三件套）
- Plugin 类型：`ppt-theme` / `prompt-template` / `asset-pack` / `agent-template`
- 示例 plugin：`example-agent-coach` / `example-greeting-prompt` / `example-warm-ppt-theme`
- agent-template plugin 类型（agent 角色模板可被打成 plugin 安装）

---

[Unreleased]: https://github.com/lichangjiang932-ship-it/your-model-atelier/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/lichangjiang932-ship-it/your-model-atelier/releases/tag/v0.9.0
[0.8.0]: https://github.com/lichangjiang932-ship-it/your-model-atelier/releases/tag/v0.8.0
[0.7.0]: https://github.com/lichangjiang932-ship-it/your-model-atelier/releases/tag/v0.7.0
[0.6.0]: https://github.com/lichangjiang932-ship-it/your-model-atelier/releases/tag/v0.6.0
[0.5.0]: https://github.com/lichangjiang932-ship-it/your-model-atelier/releases/tag/v0.5.0
