# 首轮 0＋1：实施与验收结果

**结论：代码、离线门禁及冻结全量回归通过；浏览器验收阻塞，整轮未标记为完全验收。**

基线 `648fd1b`；分支 `fix/isolated-web-agent-template`。只实施本次批准的隔离 Web 验证入口与 Agent 模板键盘语义，不实施后续路线。

## 实际修改

- 模板列表使用 li 内原生 button，保留原卡片样式和回调，增加选中语义。
- 关闭图标补共享中英文名称；继续复用原 Modal 和焦点陷阱。
- 新增显式隔离 Web build/preview 入口：白名单子进程环境、独立 HOME/配置/数据/工作区/缓存/输出，关闭项目手工及 Vite 自动 dotenv，仅监听 loopback。
- 内部 worker 必须经父进程 IPC 获取请求，导入 Vite 前检查完整环境及项目 cwd；直调拒绝，不清空调用者现有 dist。
- 补真实组件、合成 dotenv 对照、真实生产 CLI 构建及拒绝路径测试。

## 已通过的证据

| 验证 | 结果 |
|---|---|
| 定向回归 | 7 文件／46 项 PASS |
| 离线评测 | 71 项 PASS，无真实 Provider |
| lint | 全仓零 warning 门禁通过 |
| 类型 | 通过，18 个负向契约均被拒绝 |
| 债务／复杂度／双语／依赖 | 通过 |
| 隔离 Web 构建 | 退出 0，3413 modules；项目 CSS 146.59 kB，无 Tailwind content 缺失告警 |
| 最终冻结全量 | **1182 文件 PASS，退出 0，1108.623 秒** |
| 冻结一致性 | **3195 个源码／配置文件前后 SHA-256 一致** |

前两次全量失败来自验收启动环境误用 Web 默认值；业务源码与断言未改动。失败日志摘要及原冻结记录均保留，详见 [failed-runs.md](failed-runs.md)。最终全量是在独立最小测试环境下从头运行，不拼接定向结果或复用历史1180文件结论。

## 阻塞与未验收

- 预览工具三次把 `gugo-isolated-verification／5179` 请求替换为 `gugo-usage-panel／5175`，第三次在项目目录及设置重载后仍相同。三次自有启动均已立即停止，不再重试。
- 无浏览器原生 Tab／Enter／Space 或视觉验收证据；DOM click 不替代原生键盘默认行为。
- 错误 dev 配置的日志不能证明其启动期间完全未检查环境配置，不把它当作成功隔离预览。
- `DEBT-UI-002` 和 `DEBT-VERIFY-001` 保持 Open。静态 preview 不提供业务后端，不能单独证明认证后页面完整工作。
- 既有 ModalEscapeLayers 测试有 attachEvent/detachEvent 诊断但通过；不宣称测试日志零错误。
- 未验证原生 Electron、真实模型效果／成本、长期性能、POSIX 运行或 OS 沙箱。

## 保留边界

主布局、暖纸风格、品牌色及右上角四入口未改。普通 Vite 配置、包脚本、依赖锁、认证、owner、审批、目录授权与 CSP 未改。权限页、登录弹窗、性能优化、快照、MCP 扩展、后台 Agent 和 worktree 后续路线未实施。

**未主动读取真实密钥或用户数据库，未调用真实模型，未 stage／commit／push、创建 PR、打包或发版。** 浏览器工具异常的已知不确定性如上单独保留。

机器可读结果见 [verification.json](verification.json)，最终冻结见 [freeze-result.json](freeze-result.json)，源码清单见 [source-manifest.json](source-manifest.json)。原始日志存系统临时目录，可能被系统清理，不作为跨机器唯一证据。
