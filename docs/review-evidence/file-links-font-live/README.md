# Agent 文件链接、宿主字体与模型验收边界（2026-10-17）

基线 `648fd1b`；包含上一轮尚未提交的隔离 Web/Agent 模板改动，不覆盖其历史证据。本轮不提交、推送、建 PR、打包或发版。

## 已实现

- **Agent 输出文件链接**：完成报告的交付 fallback 按真正可见正文去重，不再被折叠步骤中的文件名抑制；展开步骤沿用可信引用和原工作台打开回调；首行有可信 Markdown/裸文件名引用时保留完整 Markdown，不裁成普通摘要。
- **授权不变**：未选中的 managed artifact 不自动公开，本地文件仍要求已有 verified/retained 证据；不删除 Markdown 的受保护 URL guard、不新增文件入口。
- **字体**：锁定 `@fontsource-variable/noto-sans-sc@5.3.1`，宿主采用自托管 `Noto Sans SC Variable`。保留等宽 token、字号/行高/密度、暖纸配色和主布局；同页 DOCX 降级正文/XLSX 内容继续使用原默认字体栈，HTML/忠实 DOCX/PPT iframe 不注入宿主字体。
- **分发**：生产构建输出 98 个去重 WOFF2、4,491,296 字节，CSS 全部引用；包自身 101 个字体文件。完整 OFL-1.1 随 public/licenses 分发（4314 字节，SHA-256 `18aabf190848725e2576eefb5c29ba06aac1029d02132252a7f312eac2e50cf3`）。正式静态服务新增 `font/woff2`，缺失字体返回404，不回退 SPA HTML。

## 离线与浏览器证据

- 链接 TDD：新组合场景修复前出现10项失败；修复后定向13文件/141项通过。覆盖折叠/展开、首行摘要、裸文件名、重复链接和可信文件边界。
- 字体定向17文件/142项通过；许可门禁407 production packages通过；依赖锁仅增加该字体。
- 宿主限制端口近邻10文件/189项通过（新host19项），验证 schema 只减不增、真实dispatcher拒绝不产生unknown副作用、共享12次synthetic fetch预算、redirect/并发/后台请求、普通宿主transport identity兼容。
- 真实浏览器在独立HOME/DB/workspace后端验证：`document.fonts.load/check` 对400/500/600/650/700均成功；中文“文”和Latin分别从127.0.0.1返回原始 `wOF2` 字节、HTTP200和`font/woff2`。Canvas中英混排测宽与monospace不同，650等可变字重有实际差异。不是只读computed font-family。
- 已检查浅色14px/紧凑、纯白16px/舒适、深色18px/宽松代表组合，以及375×812深色设置和1440×960桌面设置；无页面横向溢出。**未完成27/54组合穷举**；一次使用requestAnimationFrame等待的矩阵工具调用超时，后续读取确认页面已恢复，不计作矩阵PASS。
- 浏览器console/server error检查无错误；网络中看到设置切换中止的approval SSE（HTTP200后ERR_ABORTED），不宣称所有请求零失败。Resource Timing缓冲已丢弃早期字体记录，字体证明采用显式同源请求＋FontFaceSet＋Canvas。
- [浅色聊天截图](font-light-browser.jpg)、[深色窄屏设置截图](font-dark-mobile-browser.jpg)。预览宿主画布缩放影响截图留白和清晰度，不用截图证明精确字体大小。

## 真实模型：受阻，未完成

用户已要求使用现有配置模型，但本轮通过可信broker只读解析默认绑定的动作被权限策略以PII Data Handling拒绝，动作未执行。没有改用其他工具、子代理或preview live绕过；真实模型请求数为 **0**，未取得实际公开模型标识，未读取真实密钥/会话/数据库。

新broker仅以合成settings/credential/vault测试只读单模型绑定；host restriction是默认未配置的进程级减权端口，普通产品启动不安装。脚本的CLI `--live`在读取配置之前返回 `FILE_DELIVERY_LIVE_UNAVAILABLE`；直接compose/IPC传非null modelBinding也在环境赋值和runtime导入前拒绝。**这不是已可用的live runner**。

后续重新启用前必须完成：三个任务各一次的admission、每任务最小工具集合、取消/审批拒绝/unknown事件到stop的闭环、画像的有效环境覆盖投影和取消/超时验收。不得只删除fail-closed guard即宣称安全启用。12次预算测试是合成transport证据，不是已花费12次真实请求。

尚未证明真实模型生成→receipt/artifact→消息持久化→聊天DOM链接→点击打开/下载→刷新后再打开全链路。离线MessageRow点击测试不替代真实模型浏览器验收，也不伪造最终消息或receipt制造成功。

## 失败历史和范围

- 首轮静态门禁：lint/类型/负例/复杂度/i18n/依赖/离线评测通过，但turnToolSpecs新增接线后601行超过600限制。通过合并单用途中间变量到既有投影流水线修复，未删空行规避或提高门槛；债务13项复验通过。
- 验收host首次浏览器冷启动出现 `$RefreshSig$ is not defined`：仅对独立验收host关闭HMR，避免production环境和dev React刷新插件错配；第二次渲染成功。普通产品Vite配置未改。
- live入口封闭/IPC环境测试先9通过3失败，再修实现；首轮绿色复验有1个夹具错误（将process.env特殊原型与plain object直接deepEqual），改为两侧plain快照后6文件合并回归通过，未改产品权限消红。
- 宿主生命周期和offline HTTP探测旁路由独立审查提出，按真实consumer补合成回归：新增lifecycle21项、HTTP guard4项，合并近邻5文件/70项通过。close幂等并在finally清理lease/监听/IPC，构造或监听失败也rollback。offline宿主默认拒API，仅保留精确本地UI读取和auth bootstrap，普通产品不改。
- 最终guard后重新启动隔离浏览器，首页和新字体正常；用合成请求验证 `/api/llm/probe`、`/api/model/providers/discover`、`/api/system/diagnostics?check=1` 均403且返回 `FILE_DELIVERY_OFFLINE_HTTP_DENIED`。该受限宿主也有意拒绝sessions/agents/approvals等非验收API，产生预期403 console记录，不宣称最终console零错误，也不能拿该host验真实聊天链路。所有自有preview服务均已停止。

原生Electron/安装包、OS级沙箱、长期性能、完整作品浏览器对比、真实模型效果/费用均未验。本轮所有测试与构建使用临时根、独立最小环境；不读取.env来证明dotenv未加载，沿用合成哨兵测试。

首次最终冻结已经结束，**全量FAIL**：所有前置静态门禁和offline eval通过，full exit1（975.99秒），唯一最终失败是source-order规范扫描器把lifecycle测试中的运行时事件indexOf比较误认为源码顺序断言。3365项清单前后哈希一致，无测试中改动。原始结果为[freeze-result-first-fail.json](freeze-result-first-fail.json)、[source-manifest-first-fail.json](source-manifest-first-fail.json)，摘要见[verification.json](verification.json)。后续修复和新需求的新冻结结果另行记录，不改写本次失败。
