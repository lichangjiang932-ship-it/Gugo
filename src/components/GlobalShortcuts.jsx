import { useEffect } from 'react'
import { useNavigate } from '../lib/router.jsx'
import { useAppContext } from '../store/AppContext'
import { matchShortcut } from '../lib/shortcuts'

/**
 * 全局快捷键（统一用 Alt，避开浏览器拦截；Mac 上 Alt = Option）：
 *   Alt + N  →  新会话（跳转到 chat）
 *   Alt + L  →  清空当前会话
 *   Alt + ,  →  设置
 *   Alt + B  →  切换历史
 *   Esc      →  关闭右侧预览 (优先) / 否则广播 'app:escape' 让组件清理本地状态
 *
 * 之所以从 Ctrl/Cmd 改成 Alt：浏览器把 Ctrl+N（开新窗口）、Ctrl+L（地址栏）、
 * Ctrl+,（设置）、Ctrl+B（收藏栏）抢走，preventDefault 拦不住。Alt+键 全平台
 * 都没有冲突，且 Mac 上 Option 自然对应。
 *
 * （Cmd/Ctrl+K 由各页面自己处理聚焦搜索框，不在本组件管辖范围。）
 *
 * 当焦点在输入框时仍生效——Alt 组合不与文本输入冲突。
 */
export default function GlobalShortcuts() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()

  useEffect(() => {
    const onKey = (e) => {
      // ★ #25: 全局 Esc — 关闭预览;否则广播事件给监听的组件
      if (e.key === 'Escape') {
        if (state.previewArtifact) {
          e.preventDefault()
          dispatch({ type: 'CLOSE_PREVIEW_ARTIFACT' })
          return
        }
        // 让其它组件 (LeftRail 搜索框等) 听 'app:escape' 自行清理
        window.dispatchEvent(new CustomEvent('app:escape'))
        return
      }

      const action = matchShortcut(e)
      if (!action) return

      switch (action) {
        case 'new-session':
          e.preventDefault()
          dispatch({ type: 'NEW_SESSION' })
          navigate('/chat')
          break
        case 'clear-session':
          // 仅 chat 页生效,其他页不拦截.
          // 加确认:CLEAR_CURRENT_SESSION 不可撤销,误触一次损失整个对话.
          if (window.location.hash.includes('/chat')) {
            e.preventDefault()
            if (typeof window !== 'undefined' && window.confirm?.('清空当前会话?此操作不可撤销。')) {
              dispatch({ type: 'CLEAR_CURRENT_SESSION' })
            }
          }
          break
        case 'open-settings':
          e.preventDefault()
          navigate('/settings')
          break
        case 'open-history':
          e.preventDefault()
          navigate('/history')
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, dispatch, state.previewArtifact])

  return null
}
