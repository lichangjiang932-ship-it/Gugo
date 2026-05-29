// 纯工具函数：通知铃铛相关。提到 .js 模块以便 node:test 直接 import（不需要 JSX transform）。

// 格式化未读徽章数字。
// - 0 / 负数 / 非数字 / NaN / null / undefined → '' （不渲染徽章）
// - 1..99 → 具体数字字符串
// - >99 → '99+'
// - 接受字符串数字 / 小数（小数走 floor）
export function formatUnreadBadge(count) {
  const n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n > 99) return '99+'
  return String(Math.floor(n))
}

// 把通知映射成 toast 类型。
// - kind ∈ {success, error, warn} → 直接透传
// - kind === 'job' + data.status 映射：completed→success, failed→error, cancelled→warn
// - 其它（含 null/undefined）→ null （不弹 toast）
export function toastTypeForNotification(notification) {
  if (['success', 'error', 'warn'].includes(notification?.kind)) return notification.kind
  if (notification?.kind === 'job') {
    const status = notification.data?.status
    if (status === 'completed') return 'success'
    if (status === 'failed') return 'error'
    if (status === 'cancelled') return 'warn'
  }
  return null
}
