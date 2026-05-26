import {
  Download,
  Minimize2,
  RotateCcw,
  LayoutList,
  MoreHorizontal,
  Users,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

// P1 reskin: 在 .p0-shell 作用域下走 p0 token；仍保留原有 props/事件。
// 只保留三件：agent 名 / 模型选择器 / ⋯ 折叠菜单（其他按钮塞进 ⋯ 菜单）。

const AGENT_MODES = [
  { id: 'chat', label: 'Chat' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
]

export default function ChatHeader({
  activeSession,
  messages,
  lastFailedPrompt,
  modelOptions,
  selectedModel,
  hasTasks,
  agentMode = 'chat',
  onAgentModeChange,
  onExport,
  onCompress,
  onRetry,
  onModelChange,
  onNavigateTask,
  activeAgent,
  agents,
  onAgentChange,
}) {
  // ⋯ 菜单
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const triggerRef = useRef(null)
  useEffect(() => {
    if (!menuOpen) return undefined
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // P2: 打开后焦点落到首项
  useEffect(() => {
    if (!menuOpen) return
    queueMicrotask(() => {
      const items = menuRef.current?.querySelectorAll('[role^="menuitem"]:not([disabled])')
      items?.[0]?.focus()
    })
  }, [menuOpen])

  // P2: 菜单内键盘 ArrowDown/Up 循环 + Escape 关闭 + Enter 触发
  const onMenuKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setMenuOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(
      menuRef.current?.querySelectorAll('[role^="menuitem"]:not([disabled])') || []
    )
    if (!items.length) return
    e.preventDefault()
    const cur = document.activeElement
    let idx = items.indexOf(cur)
    if (e.key === 'Home') idx = -1
    if (e.key === 'End') idx = items.length
    if (e.key === 'ArrowDown' || e.key === 'Home') idx = (idx + 1) % items.length
    else if (e.key === 'ArrowUp' || e.key === 'End') idx = (idx - 1 + items.length) % items.length
    items[idx]?.focus()
  }

  // 关闭菜单后执行某个动作
  const close = (fn) => () => { setMenuOpen(false); fn?.() }

  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: '12px 20px',
        background: 'var(--p0-card)',
        borderBottom: '1px solid var(--p0-border)',
        color: 'var(--p0-text-primary)',
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        {/* agent 名（左） */}
        {Array.isArray(agents) && agents.length > 0 ? (
          <label
            className="inline-flex items-center gap-1.5 h-7 px-2 transition-colors"
            style={{
              borderRadius: 'var(--p0-radius-pill)',
              border: '1px solid var(--p0-border)',
              background: 'var(--p0-card)',
              fontSize: 12,
              color: 'var(--p0-text-primary)',
            }}
            title={`当前 Agent: ${activeAgent?.name || '默认'}`}
          >
            <Users className="w-3.5 h-3.5" style={{ color: 'var(--p0-text-secondary)' }} />
            <select
              value={activeAgent?.id || ''}
              onChange={(e) => onAgentChange?.(e.target.value)}
              className="bg-transparent outline-none cursor-pointer max-w-[140px] truncate"
              style={{ fontSize: 12, color: 'var(--p0-text-primary)' }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.isDefault ? ' (default)' : ''}</option>
              ))}
            </select>
          </label>
        ) : (
          <span
            className="truncate"
            style={{ fontSize: 14, color: 'var(--p0-text-primary)', fontWeight: 500 }}
          >
            {activeSession?.title || '新对话'}
          </span>
        )}
      </div>

      <div className="flex items-center" style={{ gap: 8 }}>
        {/* 模型选择器（中） */}
        {modelOptions.length > 0 && (
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="outline-none transition-colors cursor-pointer"
            style={{
              height: 28,
              padding: '0 10px',
              borderRadius: 'var(--p0-radius-pill)',
              border: '1px solid var(--p0-border)',
              background: 'var(--p0-card)',
              fontSize: 12,
              color: 'var(--p0-text-primary)',
            }}
            title="选择后端允许的模型"
          >
            {modelOptions.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name} · x{model.multiplier}
              </option>
            ))}
          </select>
        )}

        {/* 失败重试（条件） */}
        {lastFailedPrompt && (
          <button
            onClick={onRetry}
            className="inline-flex items-center h-7 px-2.5 transition-colors gap-1"
            style={{
              borderRadius: 'var(--p0-radius-pill)',
              border: '1px solid var(--p0-accent-line)',
              color: 'var(--p0-accent)',
              background: 'var(--p0-accent-soft)',
              fontSize: 12,
            }}
            title="重试上一条失败消息"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            重试
          </button>
        )}

        {/* 任务进行中（条件） */}
        {hasTasks && (
          <button
            onClick={onNavigateTask}
            className="inline-flex items-center h-7 px-2.5 transition-colors gap-1.5"
            style={{
              borderRadius: 'var(--p0-radius-pill)',
              border: '1px solid var(--p0-accent-line)',
              color: 'var(--p0-accent)',
              background: 'var(--p0-accent-soft)',
              fontSize: 12,
            }}
          >
            <LayoutList className="w-3.5 h-3.5" />
            任务进行中
          </button>
        )}

        {/* ⋯ 菜单（右） */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            ref={triggerRef}
            aria-label="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex items-center justify-center transition-colors"
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--p0-radius-btn)',
              color: 'var(--p0-text-secondary)',
              background: menuOpen ? 'var(--p0-accent-soft)' : 'transparent',
            }}
            onMouseEnter={(e) => { if (!menuOpen) e.currentTarget.style.background = 'var(--p0-accent-soft)' }}
            onMouseLeave={(e) => { if (!menuOpen) e.currentTarget.style.background = 'transparent' }}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>

          {menuOpen && (
            <div
              role="menu"
              onKeyDown={onMenuKeyDown}
              className="absolute right-0 z-20"
              style={{
                marginTop: 6,
                minWidth: 220,
                background: 'var(--p0-card)',
                border: '1px solid var(--p0-border)',
                borderRadius: 'var(--p0-radius-card)',
                boxShadow: 'var(--p0-shadow-pop)',
                padding: 6,
                fontSize: 13,
                color: 'var(--p0-text-primary)',
              }}
            >
              {/* agent mode 三段 */}
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--p0-text-tertiary)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  padding: '6px 8px 4px',
                }}
              >
                模式
              </div>
              <div className="flex" style={{ padding: '0 6px 6px', gap: 4 }}>
                {AGENT_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    role="menuitemradio"
                    aria-checked={agentMode === mode.id}
                    onClick={close(() => onAgentModeChange?.(mode.id))}
                    className="flex-1 transition-colors"
                    style={{
                      height: 26,
                      borderRadius: 'var(--p0-radius-btn)',
                      fontSize: 12,
                      background: agentMode === mode.id ? 'var(--p0-accent)' : 'transparent',
                      color: agentMode === mode.id ? '#FFFFFF' : 'var(--p0-text-primary)',
                      border: agentMode === mode.id ? 'none' : '1px solid var(--p0-border)',
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <MenuDivider />

              <MenuItem onClick={close(() => onExport?.('json'))} icon={<Download className="w-3.5 h-3.5" />}>
                导出 JSON（备份）
              </MenuItem>
              <MenuItem onClick={close(() => onExport?.('md'))} icon={<Download className="w-3.5 h-3.5" />}>
                导出 Markdown
              </MenuItem>

              <MenuDivider />

              <MenuItem
                onClick={close(onCompress)}
                disabled={messages.length <= 8}
                icon={<Minimize2 className="w-3.5 h-3.5" />}
              >
                压缩较早上下文
              </MenuItem>

              <MenuItem onClick={close(onNavigateTask)} icon={<LayoutList className="w-3.5 h-3.5" />}>
                任务面板
              </MenuItem>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MenuItem({ onClick, icon, children, disabled }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2 transition-colors text-left"
      style={{
        padding: '8px 10px',
        borderRadius: 'var(--p0-radius-btn)',
        background: 'transparent',
        color: disabled ? 'var(--p0-text-tertiary)' : 'var(--p0-text-primary)',
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 13,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--p0-accent-soft)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ color: 'var(--p0-text-secondary)' }}>{icon}</span>
      <span className="flex-1 truncate">{children}</span>
    </button>
  )
}

function MenuDivider() {
  return <div style={{ height: 1, background: 'var(--p0-border)', margin: '4px 6px' }} />
}
