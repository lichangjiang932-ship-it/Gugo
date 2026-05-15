# Your Model Atelier 优化计划

> 状态字典：✅ 已落地 · 🚧 部分落地 · ⏳ 待办 · 🚫 不动项

## 执行阶段

### Phase 1: 安全加固（最紧迫）
1. ✅ 后端 rate limit（验证码发送限制、错误尝试锁定）
2. ✅ Session Token TTL + 刷新机制
3. ✅ 数据加密（邮箱、token）
4. ✅ XSS 防护（DOMPurify）
5. ✅ CORS / 安全头（含 CSP / HSTS / Permissions-Policy）
6. ✅ SSRF guard（IPv4/IPv6 私网 + DNS rebinding） — batch2 (#3)
7. ✅ 工具沙箱 + 出口域限制 — batch2 (#3)
8. ✅ 工具接口 per-IP rate limit — batch2 (#3)

### Phase 2: 架构升级
1. ✅ JSON → SQLite (better-sqlite3)
2. ✅ 统一错误处理
3. 🚧 输入校验 (zod) — 仅 server middleware 校验登录/billing；模型流 chunk、工具 args、消息结构、导入 schema 待覆盖（批 C）
4. ✅ 健康检查 /api/health
5. ✅ 优雅关闭

### Phase 3: 功能增强
1. ✅ 流式输出 SSE — `callModelThroughProxyStream`
2. ✅ Markdown 渲染 + 代码高亮 — `ChatMessages.jsx` 已用 react-markdown + DOMPurify + highlight.js
3. 🚧 消息编辑/重发 — 编辑 (`handleEditMessage`) 已落地；重发待加（批 B #9）
4. ⏳ 会话标题自动总结 — 仍是 `slice(0,15)` 截断；走 `/api/model/proxy?purpose=title` 异步总结（批 C #8）
5. ⏳ 单条消息删除 + 整消息复制（artifact 路径）— 批 B #10/#11
6. ⏳ 跨会话消息搜索 `Ctrl+K` — 批 C #12
7. ⏳ 多格式导出（Markdown/HTML/PDF/Word）— 当前仅 JSON，批 C #13
8. ⏳ 导入 settings 合并/覆盖开关 — 批 C #26
9. ⏳ 工具调用失败指数退避重试 — 批 D #24
10. ⏳ 附件超 8 个 toast 提示 — 批 D #25
11. ⏳ 左侧会话最后消息预览 — 批 D #21
12. ⏳ 未读 / 新消息标记 — 批 D #22
13. ⏳ `/` 快捷指令最近使用置顶 — 批 D #23

### Phase 4: 代码质量
1. ✅ 拆分 ChatSplit 超大组件 — 现已拆为 ChatHeader/ChatSidebar(LeftRail)/ChatMessages/ChatComposer/ChatTaskPanel/RightPreviewPane/ArtifactPreview
2. ⏳ artifact 双路径合并（`buildArtifactPreview` vs `shouldOfferPptxExport/OfficeExport`）— 批 B #19
3. ⏳ TypeScript 全量迁移 — 单独立项，本轮不做（#16）
4. ⏳ Docker 配置
5. 🚧 schema 版本化导入导出框架 — `b7130c2` 已搭骨架（`exportSchema.js`），待补 Markdown/HTML/PDF/Word（批 C #13）

### Phase 5: 数据层（已完成）
1. ✅ 状态枚举常量 `taskStatus.js` — batch3 (#4)
2. ✅ `buildToolSpecs` 接受 iterable + Set 去重 — batch3 (#4)
3. ✅ schema 版本化导入导出 + 老格式兼容 — batch3 (#4)
4. ✅ localStorage SecurityError 防护 — batch3 (#4)

### Phase 6: UX polish（已完成）
1. ✅ ChatTaskPanel 状态枚举 + 图标方向修正 + activeTask 仅取 RUNNING — batch4 (#5)
2. ✅ ChatMessages 滚到底（贴底阈值 80px）+ 浮动「回到底部」按钮 — batch4 (#5)
3. ✅ 切会话保留输入草稿（`sessionDrafts` map + PERSIST_KEYS）— batch4 (#5)
4. ✅ 流式中断（AbortController + Composer 暂停按钮）— batch4 (#5)

### 不动项
- 🚫 假充值逻辑保持原样
- 🚫 TypeScript 全量迁移（#16）— 工程量过大，单独立项

---

## 进行中批次

| 批次 | 范围 | 状态 |
|------|------|------|
| **批 A** P0+文档 | #3 文档 / #27 deps 收紧 / #28 Bing Referer | 🚧 进行中 |
| **批 B** 消息操作 | #9 重发 / #10 删单条 / #11 artifact 复制 / #19 双路径合并 | ⏳ |
| **批 C** 数据/导出/搜索 | #8 标题 AI / #12 跨会话搜索 / #13 多格式导出 / #26 合并/覆盖 / #18 zod 扩展 | ⏳ |
| **批 D** UX polish | #21 列表预览 / #22 未读 / #23 / 最近 / #24 工具重试 / #25 附件 toast | ⏳ |
