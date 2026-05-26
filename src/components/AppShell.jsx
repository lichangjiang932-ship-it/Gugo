import { useNavigate } from 'react-router-dom'

/**
 * AppShell · P0 三列主壳
 *
 * 这是 IA 重做的纯布局 primitive。**不放业务逻辑**,只提供:
 *   - 三列 grid (240 / 1fr / 260)
 *   - p0-shell 主题(暖灰底)
 *   - 左/右列可塌缩预留(目前不收 prop,后续 P1 加)
 *
 * 当前 ChatSplit 仍直接组合 LeftRail + 中栏 + RightPreviewPane;
 * AppShell 作为新组件先放在这里被测试覆盖,P1 再把 ChatSplit 迁过来。
 */
export default function AppShell({ left, center, right, className = '' }) {
  return (
    <div
      data-testid="app-shell"
      className={`p0-shell h-screen flex overflow-hidden ${className}`}
      style={{ background: 'var(--p0-bg)' }}
    >
      <aside
        data-testid="app-shell-left"
        className="shrink-0 border-r"
        style={{
          width: 240,
          borderColor: 'var(--p0-border)',
          background: 'var(--p0-bg)',
        }}
      >
        {left}
      </aside>

      <main
        data-testid="app-shell-center"
        className="flex-1 flex flex-col min-w-0"
        style={{ background: 'var(--p0-bg)' }}
      >
        {center}
      </main>

      <aside
        data-testid="app-shell-right"
        className="shrink-0 border-l"
        style={{
          width: 260,
          borderColor: 'var(--p0-border)',
          background: 'var(--p0-bg)',
        }}
      >
        {right}
      </aside>
    </div>
  )
}

/**
 * 默认导出辅助:左栏底部齿轮 + 折叠控件
 * 拿出来给 LeftRail / SettingsDrawer 共用
 */
export function LeftRailFooter({ onOpenSettings, onCollapse }) {
  const navigate = useNavigate?.() ?? null
  void navigate // 保留引用,P1 拓展时用
  return (
    <div
      className="flex items-center justify-between px-3 py-2 border-t"
      style={{ borderColor: 'var(--p0-border)' }}
    >
      <span
        className="text-[12px]"
        style={{ color: 'var(--p0-text-secondary)' }}
      >
        对话
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="打开设置"
          title="设置"
          className="w-7 h-7 inline-flex items-center justify-center rounded transition-colors"
          style={{ color: 'var(--p0-text-secondary)' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {/* gear icon SVG */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="折叠左栏"
          title="折叠"
          className="w-7 h-7 inline-flex items-center justify-center rounded transition-colors"
          style={{ color: 'var(--p0-text-secondary)' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
