import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * SettingsDrawer · P0 最小设置抽屉
 *
 * 取代了顶部 nav tabs(记忆 / 插件 / 模板 / Agent / MCP / Hook 等),
 * 全部塞进这里。从左栏齿轮按钮触发。
 *
 * 现有页面路由保留(/memory /agents 等),这里只做"入口收纳"。
 */
const ITEMS = [
  { path: '/memory', label: '记忆管理', hint: '会话长期记忆 / 角色档案' },
  { path: '/skills', label: '技能市场', hint: 'PPT / 编码 / 写作 等' },
  { path: '/agents', label: 'Agents', hint: '自定义 agent 卡' },
  { path: '/mcp', label: 'MCP Servers', hint: 'Model Context Protocol' },
  { path: '/hooks', label: 'Hooks', hint: '事件钩子' },
  { path: '/permissions', label: '权限', hint: '工具调用允许列表' },
  { path: '/history', label: '历史', hint: '所有会话回放' },
  { path: '/settings', label: '账户与偏好', hint: '登录 / 主题 / 语言' },
  { path: '/task', label: '任务面板', hint: '后台任务运行状态' },
]

export default function SettingsDrawer({ open, onClose }) {
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-40 flex"
      role="dialog"
      aria-modal="true"
      aria-label="设置抽屉"
    >
      <button
        type="button"
        aria-label="关闭设置"
        onClick={onClose}
        className="flex-1 bg-black/20"
      />
      <aside
        className="h-full overflow-y-auto"
        style={{
          width: 360,
          background: 'var(--p0-card)',
          borderLeft: '1px solid var(--p0-border)',
          fontFamily: 'var(--p0-font-sans)',
        }}
      >
        <header
          className="flex items-center justify-between"
          style={{ padding: 'var(--p0-gap-md) var(--p0-gap-lg)', borderBottom: '1px solid var(--p0-border)' }}
        >
          <h2 className="text-[15px]" style={{ color: 'var(--p0-text-primary)', fontWeight: 500 }}>
            设置
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="w-7 h-7 inline-flex items-center justify-center rounded"
            style={{ color: 'var(--p0-text-secondary)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <ul style={{ padding: 'var(--p0-gap-sm) 0' }}>
          {ITEMS.map((it) => (
            <li key={it.path}>
              <button
                type="button"
                onClick={() => { onClose?.(); navigate(it.path) }}
                className="w-full text-left transition-colors"
                style={{
                  padding: 'var(--p0-gap-sm) var(--p0-gap-lg)',
                  color: 'var(--p0-text-primary)',
                  fontSize: 13,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ fontWeight: 500 }}>{it.label}</div>
                <div style={{ color: 'var(--p0-text-secondary)', fontSize: 11, marginTop: 2 }}>
                  {it.hint}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <footer
          style={{
            padding: 'var(--p0-gap-md) var(--p0-gap-lg)',
            borderTop: '1px solid var(--p0-border)',
            color: 'var(--p0-text-tertiary)',
            fontSize: 11,
          }}
        >
          your model atelier · 本地工作台
        </footer>
      </aside>
    </div>
  )
}
