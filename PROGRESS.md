# PROGRESS.md · your-model-atelier

> 最后更新：2026-05-25 by wx 主会话（v0.9.0 发布日）
> 跨会话项目状态入口。代码跟本文件冲突时**以 git 为准**，回头修本文件。

---

## 已完成

- [x] **v0.5** — plugin SDK 真消费 + agent-template（commit `93a5242` 合并）
- [x] **v0.6** — agent-MEMORY DB v6（memories.agent_id FK）+ session sticky agent + ChatHeader 切换器（`db376dc`）
- [x] **v0.7** — 跨标签页 storage 同步 + Templates 弹层 preview + import 撞名重命名 + activeAgent useMemo 派生 + 修复 `STORAGE_KEY='***'` 串台 bug（`c6ea049` / `14c00c2`）
- [x] **v0.8** — Memory 管理视图加 agent 绑定 UI（filter chip Users 下拉 + list item agent badge + editor select + handleNew 智能继承）（`4f21db4` / `8da0058`）
- [x] **v0.9** — Agent 角色卡 zip 导出/导入（`GET /api/agents/:id/export.zip` + `POST /api/agents/import.zip`，manifest.json + agent.md + memories/*.md，10MB 上限，撞名→409+overrideName retry）（`3dc01bb` / `106b149`）
- [x] **基线** — 测试 422/422 全过 · lint 0 error · build OK

---

## 进行中

（无 — 等下个会话推进列表）

---

## 待办（按 ROI 排序）

### 高 ROI · Web 形态能补的（1-3 天每项）

1. [ ] **Skills 安装机制** — plugin manifest 加 `skill-bundle` type；server 端用 `skillImport.installValidatedSkillPack` 处理 zip 解析；UI 加"从 plugin 安装为 skill"按钮。预估 1 天。
   - 涉及：`server/plugins/pluginManifest.js`（加 type）、`server/plugins/pluginLoader.js`（识别 skill-bundle）、新建 `server/services/pluginToSkill.js`（桥接）、`tests/pluginSkillBundle.test.js`
   - 触面小，不动 UI 也能交付 server 通路

2. [ ] **角色卡 zip 加 skills/avatar 二进制** — v0.9 只到 60%，差 skills + 头像。预估 0.5 天。
   - 涉及：`server/routes/agentRoutes.js` export.zip/import.zip 加 `avatar.png` + `skills/*.json`
   - 依赖 #1（先有 skill-bundle 概念）

3. [ ] **prompt-template plugin 接 chat slash command** — `/template-name` 触发自动补全。预估 1-2 天。
   - 涉及：`src/components/ChatInput.jsx`（核心多人改文件，触面大）、`src/lib/pluginClient.js`、新建 `src/components/SlashAutocomplete.jsx`
   - 风险：ChatInput 是核心组件，按"独立模块策略"先抽 SlashAutocomplete 独立组件再 mount

### 中 ROI · 结构性升级（2-5 天每项）

4. [ ] **多 agent 频道 / 委派** — channel.agents=[a,b,c]，user @某 agent，agent 间 @ 互调。预估 3-5 天。
   - 涉及：DB schema（channels 表 + channel_agents 关联）、消息路由层、UI（频道侧栏 + agent 标签）
   - 结构性升级，建议独立 worktree + 多会话推进

5. [ ] **Cron / 调度层** — 轻提醒（每 30 min 心跳） vs 重任务（精确定时）。预估 2-3 天。
   - 涉及：新建 `server/services/scheduler.js`、`server/routes/cronRoutes.js`、DB 表 `cron_jobs`
   - 参 MEMORY §4 heartbeat-vs-cron 决策表

6. [ ] **PPT 视觉升级** — cover/section gradient 背景 + stacked/area/scatter chart + htmlSlidesToPptx 接 pptCore + PR 自动 vision audit。预估 2-4 天。
   - 涉及：`src/lib/presentationExport.js`（3572 行，触面大）、`src/lib/htmlSlidesToPptx.js`（349 行）
   - 风险：presentationExport 是单文件大块，改前先拆 fixture 测试基线

### 中 ROI · 易跑的小件

7. [ ] **会话搜索 + 归档** — 现有 sessions 列表加搜索框 + archive 状态字段
8. [ ] **选中文本 → 引用卡片** — chat 区选中后弹按钮"引用"，自动塞 markdown blockquote
9. [ ] **全屏媒体查看器** — 图片/视频点开 lightbox
10. [ ] **i18n 扩 ja + ko + zh-TW** — 现有 zh/en 已通

### 低 ROI / 方向不匹配 · 不做

- ~~Electron 沙盒 PathGuard~~ — Web 形态不需要
- ~~macOS 签名公证~~ — Web 形态不需要
- ~~Plugin 两级权限模型~~ — 现在 plugin 纯数据不执行代码，0 风险
- ~~Manager+Hub+Bridge 三层架构~~ — 跟 yma 单进程定位不符
- ~~装 Claude Code / 转 Electron~~ — 用户 2026-05-23 明确否定

---

## 已知问题 / 已推迟

- **本地 main 领先 origin 34 commits 未推送** — `git fetch` 报"could not read Username"，需 source `.secrets/github.env` 后用 token URL push（见 TOOLS.md GitHub 推送章）。**下个会话推送主线 + 打 v0.9.0 GitHub Release**
- **CHANGELOG.md 之前没建** — 本会话已补，但 v0.5-v0.8 是回溯描述，不是 commit-by-commit
- **eslint 2 个 warning** — 历史遗留，未阻塞 lint，下次顺手清
- **secret-redaction 工具会误改字面量** — v0.5 把 `STORAGE_KEY = 'yma:activeAgentId'` 替成 `'***'`，跨 tab 全用户串台。教训：commit hook 前加 `git diff | grep "= '\*\*\*'"` 一道扫描（hook 还没加）

---

## 冲突以代码为准

本文件跟 git 不一致时，**代码是唯一事实源**，以 git 为准、回头修本文件。
