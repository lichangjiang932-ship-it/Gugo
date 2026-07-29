import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, ShieldAlert, Eye, Zap, ChevronUp } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'

const MODES = [
  { id: 'normal', icon: ShieldCheck, tone: 'text-ink-soft' },
  { id: 'acceptEdits', icon: Zap, tone: 'text-amber-600' },
  { id: 'plan', icon: Eye, tone: 'text-cyan' },
  { id: 'bypass', icon: ShieldAlert, tone: 'text-red-600' },
]

/**
 * 权限档位切换器。对齐 Claude Code:随时能改「我要被问到什么程度」,
 * 而不是把审批堆到一个单独页面里。Shift+Tab 循环切换。
 */
export default function PermissionModeSwitcher({ mode = 'normal', onChange, disabled }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const current = MODES.find((m) => m.id === mode) || MODES[0]
  const Icon = current.icon

  useEffect(() => {
    if (!open) return undefined
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onEsc)
    }
  }, [open])

  // Shift+Tab 循环切档(Claude Code 手感)
  useEffect(() => {
    if (disabled) return undefined
    const onKey = (e) => {
      if (e.key !== 'Tab' || !e.shiftKey) return
      const tag = String(e.target?.tagName || '').toLowerCase()
      const typing = tag === 'input' || tag === 'select' || e.target?.isContentEditable
      // textarea 里也允许切档 —— 聊天输入框就是 textarea,不放行就等于没有快捷键
      if (typing) return
      e.preventDefault()
      const idx = MODES.findIndex((m) => m.id === mode)
      onChange?.(MODES[(idx + 1) % MODES.length].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onChange, disabled])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={t(`approvals.mode.${current.id}Hint`)}
        className={`h-7 px-2 rounded-md border border-ink-fade/50 hover:border-ink-fade transition-colors flex items-center gap-1.5 text-xs disabled:opacity-50 ${current.tone}`}
      >
        <Icon className="w-3.5 h-3.5" />
        <span>{t(`approvals.mode.${current.id}`)}</span>
        <ChevronUp className={`w-3 h-3 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 z-40 w-72 rounded-md border border-ink/20 bg-paper shadow-lg overflow-hidden">
          {MODES.map((m) => {
            const MIcon = m.icon
            const active = m.id === mode
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange?.(m.id); setOpen(false) }}
                className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors ${
                  active ? 'bg-paper-2' : 'hover:bg-paper-2/60'
                }`}
              >
                <MIcon className={`w-4 h-4 mt-0.5 shrink-0 ${m.tone}`} />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">
                    {t(`approvals.mode.${m.id}`)}
                    {active && <span className="ml-1.5 font-mono text-[9px] text-ember">●</span>}
                  </span>
                  <span className="block text-xs text-ink-soft mt-0.5">{t(`approvals.mode.${m.id}Hint`)}</span>
                </span>
              </button>
            )
          })}
          <div className="px-3 py-1.5 border-t border-ink/10 font-mono text-[9px] text-ink-fade">
            Shift + Tab
          </div>
        </div>
      )}
    </div>
  )
}
