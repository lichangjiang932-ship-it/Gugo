# GAP: your-model-atelier vs openhanako (HanaAgent)

> 生成时间：2026-05-25
> 数据源：`/tmp/yma-survey.md` + `/tmp/openhanako-survey.md`

## 前提：两个项目不是同一形态

| | yma | openhanako |
|---|---|---|
| 形态 | Web SPA + 单 Node + SQLite | Electron 桌面 + Hub 后台 + Server 进程 + WebSocket |
| 目标用户 | 个人/内网，懂浏览器 | 非 coder 桌面用户 |
| 安装 | 浏览器零安装 | .dmg / .exe / .AppImage |
| 多用户 | 内建（user_id 隔离） | 单用户本地优先 + LAN 共享 |
| 差异化亮点 | Artifact 实时预览 + Job 生命周期 + 知识图谱 + 3D 封面 + 多用户 + 积分 | Yuan 人格模板 + Skill Bundle + IM Bridge + OS 沙盒 + Marketplace |

**用户已明确否定**：转 Electron / 装 Claude Code / Manager+Hub+Bridge 三层架构 → 这些不在修复范围。下面只列 Web 形态可补的差距。

---

## Gap 分类（按性价比从高到低）

### S 级 · 高 ROI，差距明显，应该补

| # | 能力 | yma 现状 | openhanako 做法 | 修复建议 | 预估 |
|---|---|---|---|---|---|
| S1 | **多 Agent 协作 / channel / @ 委派** | 无（PROGRESS #4 待办） | channel-manager / dm / subagent 三 tool + ch_{id}.md 频道文件 + mentions 解析 + DeferredResultStore | 加 `channels` + `channel_agents` + `channel_messages` 表；`dm` 表；`@agent` 解析；复用现有 `subagentRuntime` 做后台委派；ChatSplit 加频道侧栏 | 4-6 天，多会话 |
| S2 | **Cron / 调度 / 心跳分层** | hub 进程 + jobRegistry 只跑 echo 示例（PROGRESS #5 待办） | scheduler v2：heartbeat（per-agent）+ studio cron（独立于 active agent）+ 三种调度（at/every/cron）+ 三种执行（agent_session / direct_notify / plugin_action） | 加 `cron_jobs` 表 + cronTool + cronRoutes；复用 hub 进程做执行器；heartbeat 单独一个 manager | 3-4 天 |
| S3 | **角色卡 zip 加 skills + avatar 二进制** | manifest + agent.md + memories/\*.md（v0.9 60% 完整度） | character card = manifest.json + 头像 + 可选 memories + skills（白名单字段） | 扩 `serializeAgentMarkdown` 写入 skills/ + avatar.png；`parseAgentMarkdown` 反向读；agentStore 加 avatar_blob 字段；前端 UI 加头像上传 | 1-2 天 |
| S4 | **prompt-template plugin 接 chat slash command** | plugin 已扫到但没接 ChatInput（PROGRESS #3 待办） | slash-command-dispatcher / slash-command-registry / rc-pending-handler | 抽 `SlashAutocomplete.jsx` 独立组件 + 注册中心；ChatInput 装载它；prompt-template plugin 自动注册 `/<name>` | 2 天（ChatInput 触面大） |

### A 级 · 中 ROI，能拉差距

| # | 能力 | yma 现状 | openhanako 做法 | 修复建议 | 预估 |
|---|---|---|---|---|---|
| A1 | **Skill 安装来源扩展（GitHub URL）** | 仅本地 zip + plugin-bundle | install_skill tool 支持 github_url + skill_content；star 门槛 + LLM 审查 | skillImport 加 `installFromGitHub({url, minStars})`；用 GitHub API + zip download；server 端 LLM 审查可选 | 2 天 |
| A2 | **i18n 扩 ja / ko / zh-TW** | 仅 zh + en（PROGRESS #10） | zh / en / ja / ko / zh-TW 五语言 + yuan-visuals 多语 | translations.js 扩三份；UI 加语言切换 | 1 天（机器翻译 + 校对） |
| A3 | **Yuan / 人格模板系统** | 仅 agent.md frontmatter，无 MOOD / Vibe / Sparks / Reflections / Will 强约束 | yuan/{hanako,butter,ming,kong} + en/ + ishiki 模板 | 加 `agent_templates/` 内置 4 套人格；buildAgentSystemBlock 注入 MOOD 区块 | 2 天 |
| A4 | **会话搜索 + 归档** | 无（PROGRESS #7） | conversations + session-jsonl 持久化 | jobStore 加 session 标签 + 全文搜索（SQLite FTS5） | 2 天 |
| A5 | **全屏媒体查看器** | 无 | 缩放/平移/+−0/箭头切换 | ArtifactPreview 加全屏 modal | 1 天 |
| A6 | **Notifications 系统** | 无统一通知层 | notifications gateway + first-run 向导 | 加 `notifications` 表 + 浮窗组件 | 1.5 天 |

### B 级 · 低 ROI / 选做

| # | 能力 | yma 现状 | openhanako 做法 | 是否做 |
|---|---|---|---|---|
| B1 | **Plugin Marketplace（远程仓库）** | 仅本地 `plugins/` 目录 | OH-Plugins 仓库 + SemVer + sha256 + 安装记录 + 备份回滚 | **推迟** — yma 单用户场景没需求，等社区有人用再做 |
| B2 | **Two-level plugin trust（restricted / full-access）** | plugin 是纯数据不跑代码（0 风险） | 两级 trust + capability whitelist | **不做** — 形态不同没意义 |
| B3 | **FreshCompact 日级编译** | 有 compaction 但不是日级 | 四块独立编译 + 指纹缓存 | **推迟** — 当前 compactionService 已够用 |
| B4 | **First-run 向导** | settings 里手动配 provider | 选语言/名字/provider+三模型 | **可选** — 1 天，提升首次体验 |
| B5 | **deep-memory + memory-search** | memoryStore 有 listMemories 但无语义搜索 | memory-search 模块 | **推迟** — 等向量库决型再做 |
| B6 | **AbortController per-job + per-step lock** | jobStore 有 status 但无 per-step 锁 | per-job AbortController + lock | **小幅补强** — 半天 |

### N 级 · 不做（明确否定）

| # | 能力 | 原因 |
|---|---|---|
| N1 | Electron 桌面化 | 用户 2026-05-23 明确否定 |
| N2 | OS 级沙盒（Seatbelt/Bubblewrap/Win32 sandbox-helper） | Web 形态，浏览器自带沙盒 |
| N3 | macOS 签名公证 | 不做桌面 |
| N4 | IM Bridge（Telegram/飞书/QQ/微信 adapter） | 内网 Web 形态用不上，且 wechat-ilink 加密风险高 |
| N5 | Mobile PWA 专版 | 现有响应式 React SPA 够用 |
| N6 | Manager+Hub+Bridge 三层架构 | 单进程定位不符 |
| N7 | Pi SDK / pi-coding-agent | 已有自己的 jobRuntime + subagentRuntime |
| N8 | Yuan-visuals（人格可视化） | A3 文本模板够用，可视化是装饰 |

---

## 推荐执行顺序（按依赖 + ROI）

```
┌─ Phase 1: 单兵能补（1-2 周）
│  S3 角色卡 zip 加 skills + avatar (1-2 天)
│  A2 i18n 扩三语 (1 天)
│  A5 全屏媒体查看器 (1 天)
│  B4 First-run 向导 (1 天，可选)
│  B6 per-job AbortController (0.5 天)
│
├─ Phase 2: 结构性补强（2-3 周）
│  S2 Cron / 调度 / 心跳分层 (3-4 天)
│  S4 prompt-template slash command (2 天)
│  A1 Skill 从 GitHub 安装 (2 天)
│  A3 Yuan 人格模板 (2 天)
│  A6 Notifications 系统 (1.5 天)
│
├─ Phase 3: 重投入（4-6 周）
│  S1 多 Agent channel + @ 委派 (4-6 天，需 DB schema 变更 + UI 大改)
│  A4 会话搜索 + FTS5 (2 天)
│
└─ Phase 4: 选做（按需）
   B1 Plugin Marketplace
   B3 FreshCompact 日级
   B5 deep-memory + 语义搜索
```

**单会话内能干完的**：S3 / A2 / A5 / B4 / B6 这五个相互独立、触面小，可在一两个会话内陆续推完。

**需独立 worktree 多会话的**：S1（DB schema 变更） / S4（ChatInput 改造）。

---

## 已确认不做（避免重复讨论）

- Electron / 桌面客户端
- OS 沙盒 / PathGuard 升级
- IM Bridge 跨平台
- Pi SDK 接入
- Mobile 专版
- Plugin 远程 Marketplace（v1.0 前推迟）

---

## 下一步建议

如果你回 "**phase 1 全做**" → 我开干 S3 + A2 + A5 + B6（这一会话能塞完）；
如果你回 "**S1**" → 我先写 plan，开 worktree，多会话推进；
如果你想换顺序 → 直接列序号。
