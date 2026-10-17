# 直接修复：搜索、Provider 草稿、上下文事件、发送依赖与凭据顺序（2026-10-17）

基线 `648fd1b`，基于当前已通过 1193 文件冻结全量的工作树。只修复上一轮复审中“可直接落地”的问题；跨回合文件索引、本地搜索索引、写后验收、真实 Provider 矩阵和桌面分发不在本轮范围。保留主布局、右上角四入口、暖纸风格、原模型配置和聊天记录。未调用真实模型，未提交/推送/打包/发版。

## 用户决定

用户明确要求：**修改自定义 Provider ID 时只改 ID，不要自动清空 API Key、Base URL、显示名、协议、模型候选等字段。** 因此本轮移除了逐字符清空；catalog 条目/模式切换仍是一次明确的目标切换，继续清空，避免把 A 的凭据/候选直接用于 B。改 ID 后保存会把当前草稿绑定到新 ID；这是用户选择的行为，不使用非破坏性提示以外的自动清理。

## 实现

1. **搜索流式饥饿与空态闪烁**
   - `useSessionSearchResults.js` 用 ref 保存最新 `getLocalResults/localResults`，effect 只依赖 `open/trimmedQuery/t`；流式 token 更新不再因为 getter 身份变化而清理 250ms 计时器。
   - 用 `settledQuery` 派生 `loading`，非空查询从第一帧就是 loading，结果与“没有匹配”只在结算后显示；关闭/改 query/过期响应继续通过 `cancelled` 与 cleanup 取消。
2. **Provider ID 只编辑**
   - `AddProviderPanel.jsx` 删除 `changeCustomId` 的 `resetDraft`，自定义 ID 输入直接 `patch({ id })`；保留 catalog/tab 目标切换的重置、pending 探测/保存锁和 editing 身份锁。
3. **上下文持久事件降频**
   - `observeContextTextDeltas` 默认 `minInterval` 从 200ms 提高到 **1000ms**；`wire_prepared`、`prepared`、`completed`、`retained` 锚点不变，客户端 `createStreamingContextAnchor` 继续用可见文本平滑圆环。非持久 activity 通道不在本轮。
4. **发送回调依赖**
   - `useChatSendFlow.js` 回调开头从 `currentStateRef.current` 读取当前 state；依赖数组移除整个 `state`，保留发送锁、旧 ACK/旧 owner 保护和 session 创建语义。
5. **保存顺序**
   - `AddProviderPanel.submit` 先 `saveLlmProvider`，成功后再保存非空凭据；provider 失败不发 credential，credential 失败时 provider 已存在但无 key，可重试，不调用 `onSaved`。

## 验证

- **红/绿**：初始定向运行 `gugo-direct-fix-red-EFJHIL` 得到 2 个预期失败（旧 200ms 上下文时序、旧“改 ID 清空”断言）；修复后 `gugo-direct-fix-green4-Vzenlp` 的 7 个搜索/Provider/发送/上下文文件全部 PASS。近邻 `gugo-direct-fix-neighbors-h33ICH` 12 文件 PASS（含 turnEngine、turnEventEmitter、LiveContextPipeline、contextMeter、ModelConfigurationLiveCatalog）。
- **门禁**：`gugo-direct-fix-gates2-LhF2Wu` 的 lint、类型（含 18 负例）、debt、函数复杂度、i18n/keys、依赖、许可、offline eval（71 项）、隔离 Web 构建和 `git diff --check` 全部 exit 0。
- **全量冻结**：`gugo-direct-fix-full2-82YDTA` 从临时 HOME/DB/artifact/tmp、OS-only 环境、`NODE_ENV=test`、`GUGO_LOAD_DOTENV=0` 从头运行，**1193 文件 PASS / 退出 0 / 约 1503 秒**；冻结的 4254 个源码/配置/资源文件前后 SHA-256 完全一致（`aggregateBefore == aggregateAfter`），运行期间无源码改动。测试日志已输出 `final result: PASS` 后，外层 Node 包装进程因等待 lingering child handle 未自行退出，已停止包装并独立重算 4254 文件哈希，结果仍一致；测试 runner 本身的终态是 PASS。清单和结果见 [frozen-source.json](frozen-source.json)、[freeze-result.json](freeze-result.json)。
- **未做浏览器视觉验收**：搜索 loading、Provider 字段保留等以真实组件测试断言；没有修改 5175 真实配置/会话，也没有调用真实 Provider。完整 Electron 包、OS 沙箱、真实模型质量和长期压力未验收。

## 明确限制

- **Provider ID 改后保存**：按用户要求保留当前草稿，Key/候选会随新 ID 保存；不自动清理旧 ID 下已保存的凭据。
- **上下文 1000ms**：中间态持久事件约变为原来的 1/5，但不是零持久化；若长流测量仍超预算，再单独评估非持久 activity 通道（需要协议改动与单独批准）。
- **跨回合文件索引**（DEBT-LINK-001）、**本地搜索最坏 O(N)**（DEBT-SEARCH-001）、**写后验收/敏感清单**（DEBT-VERIFY-003）、**真实 Provider**（DEBT-VERIFY-002）、**桌面签名/OS 隔离**（DEBT-RELEASE-001/002、DEBT-NET-002）继续开放，不在本轮宣称解决。
- 旧 `review-evidence/review-boundary-fixes` 中“改自定义 ID 清空”的记录是当时行为；本页和 `CURRENT_STATE` 记录后续用户决定与当前行为，不改写旧验证结果。
