import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CheckCheck, ChevronDown, ChevronRight, Terminal, FilePen, FileText, Globe, MessageSquare, MousePointerClick, X } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import { toolCallLabel } from '../lib/toolCallPresentation.js'

const RISK_TONE = {
  high: { accent: 'border-l-danger', text: 'text-danger', dot: 'bg-danger' },
  medium: { accent: 'border-l-warning', text: 'text-warning', dot: 'bg-warning' },
  low: { accent: 'border-l-ink/25', text: 'text-ink-fade', dot: 'bg-ink-fade' },
}

const TOOL_ICON = {
  bash_exec: Terminal,
  run_code: Terminal,
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
const ONE_TIME_APPROVAL_TOOL_NAMES = new Set([...SHELL_TOOL_NAMES, 'run_code'])
const EDITABLE_TARGETS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]'
const INTERACTIVE_TARGETS = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"]'

function closestKeyboardTarget(target, selector) {
  const element = typeof target?.closest === 'function' ? target : target?.parentElement
  return element?.closest?.(selector) || null
}

function ignoreApprovalShortcut(event, card) {
  if (event.defaultPrevented || event.isComposing || event.repeat
    || Number(event.keyCode) === 229 || Number(event.which) === 229
    || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true
  const targets = [event.target, window.document.activeElement]
  if (targets.some((target) => closestKeyboardTarget(target, EDITABLE_TARGETS))) return true
  return targets.some((target) => {
    const control = closestKeyboardTarget(target, INTERACTIVE_TARGETS)
    // Enter belongs to the focused control's native activation, particularly
    // the deny/remember buttons. Escape only applies to this approval's own
    // controls, not another picker or toolbar elsewhere on the page.
    return control && (event.key === 'Enter' || !card.contains(control))
  })
}

/** bash_exec 的命令、write_file 的路径 —— 一眼能看懂的主参数 */
function headline(name, args) {
  if (!args || typeof args !== 'object') return ''
  if (name === 'run_code') {
    const description = String(args.description || '').trim()
    const code = String(args.code || '')
    return [description, code].filter(Boolean).join('\n')
  }
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

function DiffPreview({ changes, t }) {
  if (!Array.isArray(changes) || !changes.length) return null
  return (
    <div className="mt-2 flex flex-col gap-2">
      {changes.slice(0, 8).map((change, i) => {
        const text = Array.isArray(change?.preview) ? change.preview.join('\n') : String(change?.preview || '')
        const lines = text.split('\n').slice(0, 40)
        return (
          <div key={`${change?.path || i}`} className="overflow-hidden rounded-control border border-ink/10">
            <div className="truncate bg-paper-2 px-2.5 py-1 font-mono text-xs text-ink-soft">
              {change?.op ? `[${change.op}] ` : ''}{change?.path || `(${t('toolApproval.unknownPath')})`}
            </div>
            <pre className="max-h-48 overflow-x-auto py-1 font-mono text-xs leading-5">
              {lines.map((line, li) => (
                <div
                  key={li}
                  className={`px-2.5 ${
                    line.startsWith('+') ? 'bg-success/10 text-success'
                      : line.startsWith('-') ? 'bg-danger/10 text-danger'
                        : 'text-ink-soft'
                  }`}
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        )
      })}
      {changes.length > 8 && (
        <p className="text-xs text-ink-fade">
          {t('toolApproval.moreFiles', { count: changes.length - 8 })}
        </p>
      )}
    </div>
  )
}

/**
 * 对话内联的工具审批卡。对齐 Claude Code:允许一次 / 总是允许 / 拒绝,
 * 就在对话流里做决定,不用切到别的页面。拒绝时可以附一句"改成怎么做"，
 * 这句话会作为引导交给模型，和拒绝结果在同一轮读到。
 */
export default function ToolApprovalCard({ open, request, onDecide, busy }) {
  const { t } = useT()
  const approvalRef = useRef(null)
  // 用 request 做 key 让 React 自然重置展开态,不必在 effect 里 setState
  const [expandedFor, setExpandedFor] = useState(null)
  const expanded = expandedFor === request
  const [feedbackFor, setFeedbackFor] = useState(null)
  const [feedback, setFeedback] = useState('')
  const feedbackOpen = feedbackFor === request
  const submitFeedback = () => onDecide?.({ approved: false, feedback: feedback.trim() })

  useEffect(() => {
    if (!open || !request || busy) return undefined
    const onKey = (e) => {
      const card = approvalRef.current
      if (!card || !['Enter', 'Escape'].includes(e.key) || ignoreApprovalShortcut(e, card)) return
      e.preventDefault()
      onDecide?.({ approved: e.key === 'Enter' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, request, busy, onDecide])

  if (!open || !request) return null

  const { name, args, risk, reason, preview } = request
  const metadataSource = request.metadataSource === 'declared' ? 'declared' : 'fallback'
  const tone = RISK_TONE[risk] || RISK_TONE.low
  const Icon = TOOL_ICON[name] || AlertTriangle
  const main = headline(name, args)
  const canRemember = !ONE_TIME_APPROVAL_TOOL_NAMES.has(name)
  const toolLabel = toolCallLabel(name, t)

  return (
    <div ref={approvalRef} className={`rounded-card border border-ink/10 border-l-[3px] ${tone.accent} bg-surface p-3.5 shadow-sm`} data-testid="tool-approval-card">
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-control bg-ink/[0.05] ${tone.text}`}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-ink">{t('toolApproval.title')}</span>
            <span className="text-sm text-ink-soft">{toolLabel}</span>
            {toolLabel !== name && <span className="font-mono text-xs text-ink-fade">{name}</span>}
            <span className={`inline-flex items-center gap-1 rounded-pill bg-ink/[0.04] px-1.5 py-0.5 text-xs ${tone.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
              {t(`approvals.risk.${risk}`)}
            </span>
            <span
              data-testid="tool-risk-source"
              className="text-xs text-ink-fade"
            >
              {t('approvals.source.label')}: {t(`approvals.source.${metadataSource}`)}
            </span>
          </div>
          {reason && <p className="mt-1 text-xs leading-5 text-ink-soft">{reason}</p>}
          {main && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-control border border-ink/10 bg-[var(--code-bg)] px-2.5 py-1.5 font-mono text-xs leading-5 text-[var(--code-text)]">
              {main}
            </pre>
          )}
          <DiffPreview changes={preview} t={t} />

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedFor(expanded ? null : request)}
              className="inline-flex items-center gap-1 text-xs text-ink-fade transition-colors hover:text-ink-soft"
            >
              {expanded ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
              {t('toolApproval.viewArgs')}
            </button>
            <button
              type="button"
              data-testid="tool-approval-suggest"
              aria-expanded={feedbackOpen}
              disabled={busy}
              onClick={() => { setFeedbackFor(feedbackOpen ? null : request); setFeedback('') }}
              className="inline-flex items-center gap-1 text-xs text-ink-fade transition-colors hover:text-ink-soft disabled:opacity-50"
            >
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              {t('toolApproval.suggestOther')}
            </button>
          </div>
          {expanded && (
            <pre className="mt-1.5 max-h-48 overflow-x-auto rounded-control border border-ink/10 bg-[var(--code-bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--code-text)]">
              {JSON.stringify(args ?? {}, null, 2)}
            </pre>
          )}
          {feedbackOpen && (
            <form
              className="mt-2 flex items-end gap-2"
              data-testid="tool-approval-feedback"
              onSubmit={(event) => { event.preventDefault(); if (feedback.trim()) submitFeedback() }}
            >
              <textarea
                autoFocus
                rows={2}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter breaks the line, Escape folds the box
                  // away — and none of them reach the card's own shortcuts.
                  if (event.key === 'Escape') { event.preventDefault(); setFeedbackFor(null); return }
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    if (feedback.trim()) submitFeedback()
                  }
                }}
                aria-label={t('toolApproval.feedbackLabel')}
                placeholder={t('toolApproval.feedbackPlaceholder')}
                className="min-h-[2.5rem] min-w-0 flex-1 resize-none rounded-control border border-ink/15 bg-paper px-2.5 py-1.5 text-xs leading-5 text-ink outline-none placeholder:text-ink-fade focus:border-focus"
              />
              <button
                type="submit"
                disabled={busy || !feedback.trim()}
                className="h-8 shrink-0 rounded-control bg-ink px-3 text-xs font-medium text-paper disabled:opacity-40"
              >
                {t('toolApproval.sendFeedback')}
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/[0.06] pt-3">
        <span
          data-testid="tool-approval-hint"
          className="mr-auto text-xs text-ink-fade"
        >
          {t('toolApproval.hint')}
        </span>
        <div
          data-testid="tool-approval-actions"
          className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2"
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide?.({ approved: false })}
            className="flex h-8 items-center gap-1.5 rounded-control border border-ink/15 px-3 text-sm text-ink-soft transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('toolApproval.deny')}
          </button>
          {canRemember && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide?.({ approved: true, remember: true })}
              className="flex h-8 items-center gap-1.5 rounded-control border border-ink/15 px-3 text-sm text-ink-soft transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {t('toolApproval.alwaysAllow')}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide?.({ approved: true })}
            className="flex h-8 items-center gap-1.5 rounded-control bg-ink px-3 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t('toolApproval.allowOnce')}
          </button>
        </div>
      </div>
    </div>
  )
}
