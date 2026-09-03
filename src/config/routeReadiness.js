// T7: 路由 readiness map —— 标记每个前端路由的完成度
//
// 三档：
//   - 'stable'   : 功能闭环、有完整 i18n、有真实数据 / 持久化，可以推荐给用户用
//   - 'preview'  : 主体能跑但表单/反馈较粗，未完成 i18n 或缺少错误提示，建议谨慎使用
//   - 'wip'      : 仅为骨架/雏形，业务流程残缺，慎入
//
// 判定依据（一次性人工评估，避免运行期遍历组件源码）：
//   1. 是否有完整 zh / en i18n（useT）
//   2. 是否有真实后端数据 / 增删改查闭环
//   3. 是否含 'TODO' / 硬编码 '暂不可用' 等字样
//   4. 行数 < 200 且仅为静态展示 → 偏 preview
//
// 新增 / 改路由时同步更新这个 map；tests/config/routeReadiness.test.js 会守门。

export const ROUTE_READINESS = Object.freeze({
  // ---- stable: 完整功能 + zh/en i18n + 持久化 ----
  '/': 'stable',              // Redirects directly to ChatSplit
  '/chat': 'stable',          // ChatSplit
  '/skills': 'stable',        // SkillsMarket
  '/permissions': 'stable',   // PermissionsDashboard
  '/task': 'stable',          // TaskRunPanel
  '/history': 'stable',       // HistoryView
  '/settings': 'stable',      // SettingsView
  '/memory': 'stable',        // MemoryView
  '/desk': 'stable',          // DeskView
  '/agents': 'stable',        // AgentList
  '/channels': 'stable',      // ChannelsPage
  '/access': 'stable',        // AccessView
  '/mcp': 'stable',           // McpServersView
  '/mobile-keys': 'stable',   // MobileKeysView
  '/approvals': 'stable',     // ApprovalsInbox

  // ---- preview: 主流程能跑，但 i18n / UX 还粗糙 ----
  '/reasonix': 'preview',     // ReasonixWorkspace：记忆/TODO 雏形
})

// 渲染用：
//   - stable → null（不显示角标）
//   - preview / wip → 角标文案 key（去 i18n 查）
export const READINESS_LABEL = Object.freeze({
  stable: null,
  preview: 'Preview',
  wip: 'WIP',
})

export const READINESS_LEVELS = Object.freeze(['stable', 'preview', 'wip'])

/**
 * 给定 path 返回 banner 类型（'preview' | 'wip' | null）。
 * null = stable 或未注册路由，不需要顶部 banner。
 *
 * 纯函数，方便 unit test。
 */
export function getBannerKindForPath(path) {
  if (!path || typeof path !== 'string') return null
  const level = ROUTE_READINESS[path]
  if (level === 'preview' || level === 'wip') return level
  return null
}

/**
 * 给定 path 返回角标文案（'Preview' / 'WIP' / null）。
 * null = stable 或未注册，导航不显示角标。
 */
export function getBadgeLabelForPath(path) {
  const level = ROUTE_READINESS[path]
  return READINESS_LABEL[level] ?? null
}
