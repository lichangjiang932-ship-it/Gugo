/**
 * 全局快捷键纯函数：根据 KeyboardEvent 计算要触发的动作。
 *
 * 统一用 Alt（Mac 上 = Option）做修饰键，避开浏览器拦截：
 *   - Ctrl+N 开新窗口
 *   - Ctrl+L 选中地址栏
 *   - Ctrl+, 打开浏览器设置
 *   - Ctrl+B 切换收藏栏
 *   - Cmd+* 在 Mac 上也是浏览器命令
 * Alt+键 三大浏览器都没默认占用，跨平台一致。
 *
 * 抽到独立文件是为了在 node:test 里直接 import 测，
 * 不用拖 React / Vite SSR。
 */

/**
 * @param {{ key?: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean } | null | undefined} event
 * @returns {'new-session' | 'clear-session' | 'open-settings' | 'open-history' | null}
 */
export function matchShortcut(event) {
  if (!event || typeof event.key !== 'string') return null
  // 必须只按 Alt，同时按 Ctrl/Cmd/Shift 都不触发（避免和浏览器/系统组合撞车）
  if (!event.altKey) return null
  if (event.ctrlKey || event.metaKey || event.shiftKey) return null

  switch (event.key.toLowerCase()) {
    case 'n':
      return 'new-session'
    case 'l':
      return 'clear-session'
    case ',':
      return 'open-settings'
    case 'b':
      return 'open-history'
    default:
      return null
  }
}
