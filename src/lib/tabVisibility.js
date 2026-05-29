// 纯函数：根据 active / archived / all 数量决定 archive filter tab 的可见性。
//
// 规则（与 T12 任务一致）：
//   1. archived.length === 0 且 all.length === active.length  →  只显示 ['active']
//      （归档为空且 all 与 active 完全一致，多余的 tab 全部隐藏）
//   2. archived.length === 0 且 all.length !== active.length  →  显示 ['active', 'all']
//      （归档为空，但 all 还包含别的东西，仍然给个总览入口）
//   3. archived.length > 0  →  显示 ['active', 'archived', 'all']
//
// 入参允许给数字（length）或数组，统一规范化。
function toLength(value) {
  if (value == null) return 0
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (Array.isArray(value)) return value.length
  if (typeof value.length === 'number') return Math.max(0, value.length)
  return 0
}

export function visibleTabs({ active, archived, all } = {}) {
  const activeLen = toLength(active)
  const archivedLen = toLength(archived)
  const allLen = toLength(all)

  if (archivedLen > 0) return ['active', 'archived', 'all']
  if (allLen === activeLen) return ['active']
  return ['active', 'all']
}

export default visibleTabs
