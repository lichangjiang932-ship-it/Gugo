# 记忆：MD 经验累积 → 抽象化 → 分流（长期 / 项目 / Skills）

2026-09-18。可行性评审 + 落地方案。

## 结论

**可行，且推荐按此做。** 关键是把 Markdown 定位成**唯一手写源（write-ahead journal）**，
数据库 / 向量索引只是它的派生缓存：

```
经验写入（append-only md）
   │  阈值触发（条目数 / 字节 / 轮次 / 时间）
   ▼
抽象化（一次模型调用，输出结构化 JSON lessons）
   │  去重 · 合并 · 消解冲突 · 保留出处
   ▼
分流 ──▶ 长期记忆（用户级，跨项目）
     ──▶ 项目记忆（工作区级，docs/ + workspace instructions）
     ──▶ Skills（可复用能力，含触发条件）
```

MD 之所以是最佳载体：人可读可手改（抽象化出错时用户直接改文档就是纠错）、git 可版本与
回滚、离线可用（本项目 local-first）、模型原生理解、进程崩溃后仍完整。DB 里存的是"md 的
结构化视图"，任何时候都可以从 md 重建（v117/v119 embeddings 与 v120 检索索引都是派生物）。

## 阶段与落点（现有代码）

| 阶段 | 做什么 | 落点 |
|---|---|---|
| ① 累积 | 任务结束追加一条经验到 `experiences.md`（用户级）或 `<workspace>/docs/experience.md`（项目级）；条目带结构化 front-matter（`when / topic / lesson / evidence`） | 复用 loop 完成钩子（completionPolicy 判定完成后追加）；`evidence` 复用 goalPlan 的 evidence 概念 |
| ② 阈值 | 条目数 ≥ N（建议 20）或文档 ≥ 32KB 或距上次抽象化 ≥ 7 天 → 触发抽象化 job | 复用后台 job/budget 机制 |
| ③ 抽象化 | 模型读全量条目，输出结构化 JSON：`{longTerm: [...], project: [...], skills: [...]}`；要求每条带 `sources: [entryIds]` | 新服务 `experienceAbstractionService.js`（输出 schema 校验，复用 zod 边界风格） |
| ④ 分流 | 长期 → `memoryStore`（写入后由 `memoryEmbeddingIndexer` 建向量）；项目 → `workspaceInstructions` 合并段 + 项目 md；Skills → skill 目录生成/更新 `SKILL.md` | `memoryStore.selectActiveMemoriesForInjection`（双路召回已就绪）、`server/services/workspaceInstructions.js`、skillCatalog |
| ⑤ 归档 | 抽象化消费过的条目移入 `experiences.archive.md`，journal 保持薄 | 纯文件操作，保留 `sources` 反向链接 |

抽象化后**必须**失效派生索引：被改写的长期记忆走 v120 `memory_search_pending` 失效触发器；
语义向量重跑 `reindexUserMemoryEmbeddings`（已有 scope/space 报告）。

## 风险与对策

1. **无界增长**：阈值抽象化 + 归档；journal 只保留未消化条目（目标 < 32KB）。
2. **重复 / 自相矛盾**：抽象化 prompt 强制"合并同义条目"；冲突时**新条目覆盖旧条目**，
   但旧条目不删除（归档可追溯）；注入时按 recency 排序。
3. **幻觉经验**：抽象化产物每条必须带 `sources`（指向真实条目/evidence），无 sources 的条目
   拒收（与 goalPlan evidence 同一立场：存在 ≠ 被证明）。Skills 写入需用户确认（与 goal 计划
   一样不给 agent 直接批准权）。
4. **注入膨胀**：长期记忆注入走现有预算（`selectActiveMemoriesForInjection` 已有上限）；
   经验条目默认压缩为一行 lesson，展开阅读放记忆页。
5. **隐私**：全部本地文件，无云调用；BYOK 的模型调用只发送抽象化所需的条目文本。

## 建议 schema（journal 条目）

```yaml
---
id: exp-20260918-004
when: 2026-09-18
topic: pptx-verification
scope: user | project
lesson: "python-pptx 校验必须做二进制 readback"
evidence: { turnId: "…", files: ["out/probe.pptx"] }
status: pending | digested
---
```

抽象化输出（结构化 JSON，非 md）：

```json
{ "longTerm": [{"lesson": "…", "scope": "user", "sources": ["exp-…-004"]}],
  "project":  [{"lesson": "…", "path": "docs/experience.md", "sources": ["exp-…-007"]}],
  "skills":   [{"name": "pptx-verify", "trigger": "…", "steps": "…", "sources": ["exp-…-004"]}] }
```

## 分阶段落地（估点）

1. `record_experience` 工具（append-only，front-matter 校验）＋记忆页只读展示 —— 0.5d
2. 阈值触发器 + 抽象化 job（schema 校验 + 失败重试一次）—— 1d
3. 分流写入（长期/项目/Skills，Skills 需确认）+ 索引失效/重嵌入 —— 1d
4. 回放评测：拿最近 20 个真实任务做"注入前后"对照（复用离线 eval 61 项的框架）—— 0.5d
