# Changelog

本项目所有显著变更记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号采用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.10.0] - 2026-05-27

### Added
- DB v12: `integrations` 表 — per-user 第三方账号凭据（feishu/wechat_official/wechat_personal/dingtalk/qq/discord/telegram/slack/lark_bot/webhook）
- 视觉副驾（vision assist）：无视觉能力的模型自动调副驾把图片转文本描述
- `/api/integrations` REST 全套：CRUD + 测试连通性 + 启用/禁用
- 前端「设置 → 集成」页 + IntegrationsPanel 组件
- 频道空状态从纯文字升级为图文 CTA（含「新建频道」主按钮）
- i18n 五语补齐（zh/en/ja/ko/zh-TW）

### Security
- Hooks runHttp 加 SSRF allowlist + 强制 https
- `/api/health` 公开版瘦身；`/api/health/full` 鉴权
- Cron prompt 用户输入包定界符 + Trigger source 标记

### Changed
- `modelProxy` Unprocessable Content 拒绝改为：先尝试 vision assist 副驾，失败/未配置才返回 Unprocessable Content
- 响应头透出 `X-Vision-Assist-Count` / `X-Vision-Assist-Failures` 供前端调试

### Fixed
- `visionAssist.js` 未使用的 `eslint-disable` 注释

### Added (Phase 1 补 openhanako gap)
- **S3 角色卡 zip v0.2** — `export.zip` 多了 `?avatar=0/?skills=0` query；data-URL avatar 内嵌为 `avatar.<ext>`（限 2MB）；skills/<id>/ 打包当前 user 非系统 skill；import 反向回灌 avatar data-URL + `resolveImportedSkillId` 全库 dedup 装入新 user；manifest v0.1 老卡完全兼容
- **A2 i18n 扩三语** — `translations.js` 加 `ja/ko/zh-TW` 完整词典；`SUPPORTED_LANGUAGES` 升到 5 项；SettingsView 现有 `<select>` 自动亮出三个新选项
- **A5 全屏媒体查看器** — `src/components/FullscreenMediaModal.jsx`，鼠标滚轮缩放、拖拽平移、Esc/+/-/0/←/→，framer-motion 深入，接 ArtifactPreview 点击图片触发
- **B6 per-job AbortController** — `POST /api/jobs/:id/abort` 需登录 + user_id 校验；jobRuntime 在每个 step 间 check `signal.aborted` 触发后标 `cancelled` 退出；job 完成/失败时 cleanup map
- **原 Skill-Bundle 全链路** — `POST /api/plugins/:id/install-as-skill` + `installPluginAsSkill` + SkillsMarket “从 Plugin”按钮弹层，本轮同步梳理完成

### Stats
- 测试基线：572/572 全绿
- lint 0 error（2 warning 历史遗留）、build OK
- commits：`0026d2c` i18n · `c622b27` agent-card zip v0.2 · `cdbd5ba` job abort · `c1c543b` fullscreen modal

### Notes
- Phase 1 中 S3/A2/A5/B6 全交付；B4 first-run 向导推到下轮与 Settings 页结合重设
- 下一阶段 (Phase 2)：S2 cron/调度、S4 prompt-template slash command、A1 skill GitHub URL 安装、A3 Yuan 人格模板、A6 Notifications
- 路线图看 [PROGRESS.md](./PROGRESS.md) 、完整 gap 表看 [GAP_VS_OPENHANAKO.md](./GAP_VS_OPENHANAKO.md)

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
