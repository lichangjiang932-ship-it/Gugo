# 模型入口与搜索焦点（2026-10-17）

基线 `648fd1b`，延续现有未提交工作树。保留主布局、“侧边栏／本次改动／预览／任务清单”、原配置与聊天记录；没有 stage/commit/push/PR/打包/发版。

## 用户可见结果

- **正常使用入口是 http://localhost:5175/#/chat**，启动配置名 `gugo-dev`。已把它恢复到 `.claude/launch.json` 首位，原启动参数和两个隔离配置保留。顺序不是宿主必然默认选中该项的保证，实际操作仍须核对配置名和端口。
- 用户截图的 `Offline verification permits local UI reads and local authentication only.` 是 **5181 `gugo-file-delivery-offline`** 的刻意拒绝，不是上游返回零模型。未删除其 guard，未将真实配置复制到临时数据库，未停止/刷新用户后起的5181页面或读取其表单密钥。
- 原有模型选择控件已经支持：获取后展示响应内全部候选、全选、全不选和逐项选择。本轮补强行为回归，没有重造控件或修改正常产品模型协议。取消选择只写 `enabled:false`，不删除候选或窗口元数据。
- 搜索弹窗现有行/input增加专用class，局部覆盖全局 `input:focus-visible`，取消输入框蓝色outline，以中性底部内阴影标示整行聚焦。不改尺寸/快捷键/Modal焦点陷阱，其他按钮全局焦点规则保留。规则位于pet-window独立样式切片之前。

## 定向回归

全部使用OS-only白名单环境、fresh HOME/配置/数据库/临时目录，`NODE_ENV=test`、`GUGO_LOAD_DOTENV=0`，项目 `scripts/run-tests.js`。

- 模型基线2文件/4项通过；增强后2文件/7项通过，近邻7文件/27项通过。32候选完整ID集合；全不选保留元数据；手选2项；全选；重探测去重、保留disabled、新候选合并；探测503保留Provider草稿/手工ID/选择；保存失败不发成功通知，重试成功才通知；已保存目录32→0→2→32→0→2，挂载聊天即时刷新且旧编辑表单不能恢复过期选择。
- 新增真实SessionSearchModal＋AppProvider＋Router＋I18n测试8项；搜索及Modal近邻5文件/21项通过。覆盖zh/en标签、打开自动focus、Ctrl/Cmd+K、本地合成搜索/高亮/无结果/清空、结果导航、Tab/ShiftTab边界环绕、背景focus拦回、Escape/close恢复焦点。
- 搜索样式近邻及lifecycle/source-order基线3文件/26项中25通过1失败：扫描器误判运行时事件indexOf比较；修复后26/26通过。改为drain回调断言lease/IPC保留，release回调断言drain已完成；保留server.close挂起检查，不改扫描器/baseline、不加豁免。
- 最终合并定向10文件/54项通过，exit0，日志根 `gugo-model-search-targeted-H58rBv`。既有ModalEscapeLayers等夹具仍打印React/JSDOM attachEvent/detachEvent诊断但runner通过；不声称测试日志零错误。新搜索测试要求DOM runtime error为空。

## 浏览器与构建

仅使用新建 `gugo-isolated-verification` 5179静态构建预览；不启动5175真实后端，不使用用户5181草稿。该静态host不提供API，auth bootstrap 404是预期限制，不能用于真实模型配置成功声明。

已在真实页面读取：纯白/暖纸聚焦搜索input的 `outline-style:none`、`box-shadow:none`；行高仍48px，行聚焦shadow分别为中性灰 `rgba(107,114,128,.6)` / `rgba(115,108,100,.6)`，无横向溢出。深色/窄屏页面可渲染、无横向溢出，聚焦时input outline也观察为none；宿主后台焦点/viewport变化导致部分后续检查的`:focus-within`不再匹配，**不宣称完整键盘原生Tab或三主题全部聚焦矩阵PASS**。合成KeyboardEvent不等于真实键盘模态；其他按钮ring以未改动的CSS及近邻行为测试为证，不谎称原生键盘视觉已验。

一次混合试验因已打开的斜杠命令弹层与搜索同时存在导致背景inert，读DOM确认后reload新静态页面、只打开单一搜索弹窗重验；不把该次无焦点样式当成功，也未顺手改共享Modal实现。[搜索弹窗截图](search-dark-browser.jpg)受宿主画布缩放影响，不用于证明精确CSS数值。隔离生产构建exit0（2.78秒），构建CSS包含搜索专用规则；本轮自有的两个5179预览实例已停止，用户后起5181未触碰。

## 全量与历史

本轮新冻结门禁已全部exit0。全量实际完成：**1188 个测试文件 PASS、退出 0、1272.565 秒**；但运行期间源码被本轮的真实实例链接修复改动（`artifactReferenceMarkdown.js`、`artifactReferencePath.js`、对应测试），前后哈希不一致。因此它只是“在该树上跑完并退出0”，**不是一致快照的最终冻结PASS**；当前树仍需从头新冻结。前置lint、类型（含18负例）、debt、函数复杂度、i18n/keys、依赖、许可及offline eval均exit0。

上一轮链接/字体冻结的全量FAIL已持久归档至相邻 `file-links-font-live/freeze-result-first-fail.json` 与 `source-manifest-first-fail.json`；3365项哈希前后一致、唯一最终失败为上文规范误报。未改写为当时PASS。

## 明确未验证

真实Provider模型目录获取、真实模型文件交付全链路、上游分页、Provider目标切换并发、Electron安装包、OS沙箱和长期性能。真实模型请求数0；之前真实绑定解析被权限拒绝后未绕过，正常5175本轮没有自动启动。
