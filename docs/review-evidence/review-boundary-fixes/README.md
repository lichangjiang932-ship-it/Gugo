# Claude Code 复审问题修复与验收

## 范围

用户确认修复 Provider 状态隔离、托管交付相对路径、URL 来源边界、搜索工作量/焦点、离线验收 Host 的 WS/凭证投影问题；跨回合可信文件索引只登记债务。本轮不提交、推送、打包，不修改真实 5175 实例、模型配置或用户会话。保留 Claude Code 已有未提交改动；开工快照位于外部 `gugo-review-fixes-dbRp3x/snapshot/`，index 未动，`.claude/launch.json` 未编辑。

## 逐项结果

1. **Provider 串用：修复。** 目录目标或目录/自定义模式变化时清空旧 Key、Base URL、候选、待添加 ID 和提示；相同 Provider 重点不丢草稿。自定义 Provider ID 变化也清空前一个身份的数据。已保存 Provider 的身份锁定。操作进行时禁用目标控制及端点/凭据输入；操作令牌在卸载/替换目标后失效，迟到探测/保存回调不能更新新目标。凭据只在内存表单中，不为保留草稿新增持久化。
2. **仅托管交付的相对路径：修复。** 当前回合已登记的托管引用没有本地绝对路径时，可用全局唯一 basename 将相对提及指向它原有 URL。已有本地收据仍必须匹配绝对路径/相对后缀；不因同名而把错误目录映射到本地文件。行内代码链接与隐藏卡片使用同一解析；未链接的行内代码、歧义和代码块中的伪链接不隐藏唯一交付入口。
3. **外部 URL 解析成本地文件：修复。** 不仅新快照函数，原普通匹配也曾只看 pathname。普通匹配现在保留 URL origin，快照替换只接受 path-only 或明确浏览器同源的 URL；协议相对/外部来源不能冒充。scheme（包括编码后的 scheme）不再规范成相对路径。受保护外链的阻止策略不放宽。
4. **跨回合引用：本轮不实施。** 没有本轮可信引用时不猜路径、不扫描正文补公开文件。登记 `DEBT-LINK-001`，后续需单独定义 backend/owner/session 隔离、回执、撤销、失效和重载规则。
5. **搜索逐键扫描：修复当前触发问题。** 本地扫描移入同一 250ms 防抖及取消生命周期，关闭/过期查询不扫描。保留服务端与未同步本地消息的合并和失败回退，不因已有 token 而删掉本地结果。单次无匹配扫描仍可能 O(N)，登记 `DEBT-SEARCH-001`，不声称已实现增量索引或恒定时间检索。
6. **搜索焦点对比：修复局部提示。** 使用不透明 ink-soft 中性底线，保留输入框无蓝框及既有尺寸。三套声明 token 的非文本对比度测试均达到 3:1；浏览器另记录实际 box-shadow、背景、焦点和溢出。不把该局部检查写成全站 WCAG 验收。并补 IME Escape/229 不关闭搜索的回归。
7. **验收 Host WS 旁路：修复。** 不再导入/挂载 Turn WebSocket 消费者。HTTP 与升级拒绝通过同一个离线 transport plugin 安装，全部升级返回 403；HTTP 只读/本地 bootstrap 白名单保留。真实本机 HTTP Server/原始升级请求测试覆盖不同路径，普通读取仍工作。
8. **凭据环境投影：删除。** 删除未使用的 `projectVerificationModelEnvironment` 导出及旧正向测试；替换为不存在该导出的回归。live CLI 和直接 modelBinding 入口仍在加载运行时之前拒绝，没有接通真实凭证/模型。

## 验证

- 原 8 个相关测试文件通过，但新边界未覆盖；已用新增失败用例独立复现后修复。
- 定向 15 文件/166 项通过；覆盖新 Provider 切换/迟到结果、自定义身份切换、托管引用/歧义/外部 URL、scheme、搜索防抖/取消/合并/IME、数值对比度和真实 WS 升级拒绝。
- lint、类型（18 个负例均拒绝）、debt、函数复杂度、i18n 形状/键、依赖、生产包许可通过；离线 71 项通过；使用 `verify-isolated-web.mjs --build` 完成关闭自动 dotenv 的隔离构建。
- 最终浏览器使用独立 HOME/GUGO_HOME、SQLite、Edge profile、5197/9297 和显式 `envDir:false` 的临时开发 Host；探测、凭据保存及搜索回应由客户端合成夹具截获，未调用真实 Provider。Provider A→B 的第二次 payload 只含 B 的地址/协议/合成凭据与候选。1440/360 × 三主题的真实焦点/中性样式通过，等待 computed style 达到目标 token 后才截图，避免过渡帧冒充主题结果。
- 实际 MarkdownRenderer 将托管相对行内代码渲染为链接并调用其已登记 URL；同名外部快照 URL 保持阻止。该 fixture 验证渲染和回调，不声称读取或打开了真实文件内容。
- 原生 CDP Escape 关闭搜索，JS composition Escape 保持打开；未宣称 OS 输入法候选窗真机验收。

初始浏览器脚本复用了早期临时启动器，缺少显式 envDir，且首次同 URL 导航未进入新文档，预注入未生效；合成保留域名 probe 失败。停止旧启动后改为显式 envDir:false，并强制新文档、先确认夹具安装，再完成最终复验。早期过程不纳入最终证据，未因此放宽生产认证或 guard。修正优化 React 模块的 default 导出适配后重验，未使用第二份 React。

## 冻结全量

最终从头 **1191 文件 PASS / 退出 0 / 1143.632 秒**；运行前后 4250 个源码/配置/资源文件的 SHA-256 清单一致（排除 docs、.agent、.claude 及敏感/运行时路径），没有在运行中改源码。之前 `bcmcv4mqu` 的 1188 文件 exit 0 / 1272.565 秒但 hashesUnchanged:false 仍保留为非冻结历史，不改写为最终 PASS。

当前持久证据：`verification.json`、`browser-verification.json`、`screens/`。原始红/绿测试、完整日志、快照和校验清单在 `C:/Users/21161/AppData/Local/Temp/gugo-review-fixes-dbRp3x`，临时文件可能被系统清理。没有使用旧轮次 PASS 替代本轮。

## 后续修订（2026-10-17）

用户随后明确要求：自定义 Provider ID 只改 ID，不要自动清空 API Key、Base URL、显示名、协议或模型候选。当前实现已移除逐字符 `resetDraft`；catalog 条目/模式切换仍作为明确目标切换清空，pending/editing 锁保留。上面第 1 项和 `tests/unit/ModelConfigurationFlow.test.jsx` 中旧“改 ID 清空”的行为是当时已验证的历史，不改写；当前行为和证据见 `docs/review-evidence/direct-fixes/`。

