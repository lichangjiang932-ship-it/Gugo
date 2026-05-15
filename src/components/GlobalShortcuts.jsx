import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppContext } from '../store/AppContext'

/**
 * 全局快捷键：
 *   ⌘/Ctrl + N  →  新会话（跳转到 chat）
 *   ⌘/Ctrl + L  →  清空当前会话
 *   ⌘/Ctrl + ,  →  设置
 *   ⌘/Ctrl + B  →  切换历史
 *   ⌘/Ctrl + /  →  快捷键帮助（toggle 提示）
 *   Esc        →  关闭右侧预览 (优先) / 否则广播 'app:escape' 让组件清理本地状态
 *
 * （⌘K 由各页面自己处理聚焦搜索框）
 *
 * 当焦点在输入框时不拦截大部分组合，但 ⌘N/⌘L/⌘, 仍生效。
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

      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault()
          dispatch({ type: 'NEW_SESSION' })
          navigate('/chat')
          break
        case 'l':
          // 仅 chat 页生效，其他页不拦截
          if (window.location.hash.includes('/chat')) {
            e.preventDefault()
            dispatch({ type: 'CLEAR_CURRENT_SESSION' })
          }
          break
        case ',':
          e.preventDefault()
          navigate('/settings')
          break
        case 'b':
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
