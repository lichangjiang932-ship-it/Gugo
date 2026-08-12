import { useEffect, useState } from 'react'
import { AlertTriangle, Check, CheckCheck, ChevronDown, ChevronRight, Terminal, FilePen, FileText, Globe, MousePointerClick, X } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'

const RISK_TONE = {
  high: { border: 'border-red-500/50', bg: 'bg-red-500/5', text: 'text-red-600', dot: 'bg-red-500' },
  medium: { border: 'border-amber-500/50', bg: 'bg-amber-500/5', text: 'text-amber-600', dot: 'bg-amber-500' },
  low: { border: 'border-ink-fade/50', bg: 'bg-paper-2', text: 'text-ink-fade', dot: 'bg-ink-fade' },
}

const TOOL_ICON = {
  bash_exec: Terminal,
  run_command: Terminal,
  run_test: Terminal,
  docker_exec: Terminal,
  write_file: FilePen,
  edit_file: FileText,
  apply_patch: FileText,
  patch_file: FileText,
  file_download: Globe,
  fetch_url: Globe,
  browser_click: MousePointerClick,
  browser_type: MousePointerClick,
  browser_select: MousePointerClick,
  browser_press: MousePointerClick,
}

const SHELL_TOOL_NAMES = new Set(['bash_exec', 'run_command', 'run_test', 'docker_exec'])

/** bash_exec 的命令、write_file 的路径 —— 一眼能看懂的主参数 */
function headline(name, args) {
  if (!args || typeof args !== 'object') return ''
  if (SHELL_TOOL_NAMES.has(name)) {
    const command = Array.isArray(args.command) ? args.command.join(' ') : args.command
    const envKeys = Array.isArray(args.env_keys) && args.env_keys.length > 0
      ? `\nenv_keys: ${args.env_keys.join(', ')}`
      : ''
    return `${String(command || '')}${envKeys}`
  }
  if (['write_file', 'edit_file', 'patch_file', 'file_download'].includes(name)) return String(args.path || '')
  if (name === 'fetch_url') return `${String(args.method || 'GET').toUpperCase()} ${String(args.url || '')}`
  if (name === 'browser_open_url' || name === 'browser_navigate') return String(args.url || '')
  if (['browser_click', 'browser_type', 'browser_select', 'browser_press'].includes(name)) return String(args.target || args.selector || '')
  return ''
}

function DiffPreview({ changes }) {
  if (!Array.isArray(changes) || !changes.length) return null
  return (
    <div className="mt-2 flex flex-col gap-2">
      {changes.slice(0, 8).map((change, i) => {
        const text = Array.isArray(change?.preview) ? change.preview.join('\n') : String(change?.preview || '')
        const lines = text.split('\n').slice(0, 40)
        return (
          <div key={`${change?.path || i}`} className="rounded border border-ink/15 overflow-hidden">
            <div className="px-2 py-1 bg-paper-2 font-mono text-[10px] text-ink-soft truncate">
              {change?.op ? `[${change.op}] ` : ''}{change?.path || '(未知路径)'}
            </div>
            <pre className="px-2 py-1.5 font-mono text-[10px] leading-relaxed overflow-x-auto max-h-40">
              {lines.map((line, li) => (
                <div
                  key={li}
                  className={
                    line.startsWith('+') ? 'text-emerald-700 bg-emerald-500/10'
                      : line.startsWith('-') ? 'text-red-700 bg-red-500/10'
                        : 'text-ink-soft'
                  }
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        )
      })}
      {changes.length > 8 && (
        <p className="font-mono text-[10px] text-ink-fade">…还有 {changes.length - 8} 个文件</p>
      )}
    </div>
  )
}

/**
 * 对话内联的工具审批卡。对齐 Claude Code:允许一次 / 总是允许 / 拒绝,
 * 就在对话流里做决定,不用切到别的页面。
 */
export default function ToolApprovalCard({ open, request, onDecide, busy }) {
  const { t } = useT()
  // 用 request 做 key 让 React 自然重置展开态,不必在 effect 里 setState
  const [expandedFor, setExpandedFor] = useState(null)
  const expanded = expandedFor === request

  useEffect(() => {
    if (!open || busy) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onDecide?.({ approved: false })
      // Claude Code 手感:回车 = 允许一次
      if (e.key === 'Enter' && !e.shiftKey) onDecide?.({ approved: true })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onDecide])

  if (!open || !request) return null

  const { name, args, risk, reason, preview } = request
  const tone = RISK_TONE[risk] || RISK_TONE.low
  const Icon = TOOL_ICON[name] || AlertTriangle
  const main = headline(name, args)
  const canRemember = !SHELL_TOOL_NAMES.has(name)

  return (
    <div className={`rounded-md border ${tone.border} ${tone.bg} p-3.5`} data-testid="tool-approval-card">
      <div className="flex items-start gap-2.5">
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${tone.text}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-ink">{t('toolApproval.title')}</span>
            <span className="font-mono text-[12px] text-ink">{name}</span>
            <span className={`inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider ${tone.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
              {t(`approvals.risk.${risk}`)}
            </span>
          </div>
          {reason && <p className="text-xs text-ink-soft mt-1">{reason}</p>}
          {main && (
            <pre className="mt-2 px-2.5 py-1.5 rounded bg-paper border border-ink/15 font-mono text-[11px] text-ink overflow-x-auto whitespace-pre-wrap break-all">
              {main}
            </pre>
          )}
          <DiffPreview changes={preview} />

          <button
            type="button"
            onClick={() => setExpandedFor(expanded ? null : request)}
            className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-ink-fade hover:text-ink-soft transition-colors"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t('toolApproval.viewArgs')}
          </button>
          {expanded && (
            <pre className="mt-1.5 px-2.5 py-1.5 rounded bg-paper border border-ink/15 font-mono text-[10px] text-ink-soft overflow-x-auto max-h-48">
              {JSON.stringify(args ?? {}, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide?.({ approved: true })}
          className="h-8 px-3 rounded-md bg-ember text-paper text-sm flex items-center gap-1.5 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" />
          {t('toolApproval.allowOnce')}
        </button>
        {canRemember && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide?.({ approved: true, remember: true })}
            className="h-8 px-3 border border-emerald-500/60 rounded-md text-sm text-emerald-700 hover:bg-emerald-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            {t('toolApproval.alwaysAllow')}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide?.({ approved: false })}
          className="h-8 px-3 border border-ink-fade/60 rounded-md text-sm text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" />
          {t('toolApproval.deny')}
        </button>
        <span className="font-mono text-[10px] text-ink-fade ml-auto">{t('toolApproval.hint')}</span>
      </div>
    </div>
  )
}
