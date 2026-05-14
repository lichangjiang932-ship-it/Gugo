# Your Model Atelier 优化计划

## 执行阶段

### Phase 1: 安全加固（最紧迫）
1. ✅ 后端 rate limit（验证码发送限制、错误尝试锁定）
2. ✅ Session Token TTL + 刷新机制
3. ✅ 数据加密（邮箱、token）
4. ✅ XSS 防护（DOMPurify）
5. ✅ CORS / 安全头

### Phase 2: 架构升级
1. ✅ JSON → SQLite (better-sqlite3)
2. ✅ 统一错误处理
3. ✅ 输入校验 (zod)
4. ✅ 健康检查 /api/health
5. ✅ 优雅关闭

### Phase 3: 功能增强
1. ⏳ 流式输出 SSE
2. ⏳ Markdown 渲染 + 代码高亮
3. ⏳ 消息编辑/重发
4. ⏳ 会话标题自动总结

### Phase 4: 代码质量
1. ⏳ 拆分 ChatSplit 超大组件
2. ⏳ TypeScript 类型
3. ⏳ Docker 配置

### 不动项
- 假充值逻辑保持原样
