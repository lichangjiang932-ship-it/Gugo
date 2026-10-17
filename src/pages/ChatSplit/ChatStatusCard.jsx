import { useMemo } from 'react'
import { Gauge, ListTodo, X } from 'lucide-react'
import { buildPendingContextUsage } from '../../lib/contextMeter.js'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'
import { useT } from '../../i18n/I18nProvider.jsx'

function valueClass(extra = '') {
  return `mt-1 truncate text-[0.8125rem] font-medium text-ink ${extra}`
}

export default function ChatStatusCard({
  session,
  messages = [],
  tasks = [],
  model,
  contextWindow,
  contextWindowEstimated = false,
  contextWindowKnown = null,
  contextWindowSource = '',
  toolSpecs,
  systemPrompt,
  approvalMode,
  onClose,
  onOpenTasks,
  onOpenContext,
}) {
  const { lang, t } = useT()
  const copy = getSlashActionCopy(lang).statusPanel
  const usage = useMemo(() => buildPendingContextUsage({
    messages,
    tools: toolSpecs,
    systemPrompt,
    contextWindow,
    contextWindowAuthoritative: contextWindowKnown === true && contextWindowEstimated !== true,
    contextWindowEstimated,
    contextWindowKnown,
    contextWindowSource,
  }), [contextWindow, contextWindowEstimated, contextWindowKnown, contextWindowSource, messages, systemPrompt, toolSpecs])
  const meter = usage.meter
  const windowKnown = meter.contextWindowKnown === true
  const percent = meter.percent === null ? 0 : Math.max(0, Math.min(100, meter.percent))
  const scopedTasks = tasks.filter((task) => !task.sessionId || task.sessionId === session?.id)
  const running = scopedTasks.filter((task) => task.status === 'running').length
  const pending = scopedTasks.filter((task) => task.status === 'pending').length
  const modeLabel = copy[approvalMode] || approvalMode || copy.normal

  return (
    <section
      data-testid="slash-status-card"
      role="status"
      aria-label={copy.title}
      className="rounded-[18px] border border-ink/[0.12] bg-paper px-4 py-3.5 shadow-[0_12px_34px_rgb(var(--color-ink-rgb)/0.11)]"
    >
      <div className="flex items-center gap-2.5">
        <Gauge className="h-[18px] w-[18px] text-ink-soft" strokeWidth={1.8} />
        <h2 className="flex-1 text-sm font-medium text-ink">{copy.title}</h2>
        <button type="button" onClick={onClose} title={copy.close} aria-label={copy.close} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-fade hover:bg-ink/[0.05] hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>

      <button
        type="button"
        onClick={onOpenContext}
        data-window-state={!windowKnown ? 'unknown' : meter.contextWindowEstimated ? 'estimated' : 'exact'}
        className="mt-3 block w-full rounded-xl bg-ink/[0.035] px-3 py-2.5 text-left hover:bg-ink/[0.055]"
      >
        <div className="flex items-center justify-between text-xs text-ink-fade">
          <span>{copy.context}</span>
          <span className="font-mono">
            ~{meter.usedTokens.toLocaleString()}
            {windowKnown
              ? <> / {meter.contextWindowEstimated ? '≈' : ''}{meter.contextWindow.toLocaleString()} · {meter.contextWindowEstimated ? '≈' : ''}{Math.round(percent)}%</>
              : <> · {t('chat.contextUsage.windowUnknown')}</>}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
          {windowKnown && (
            <div className={`h-full rounded-full ${percent >= 80 ? 'bg-danger' : percent >= 60 ? 'bg-warning' : 'bg-ink/55'}`} style={{ width: `${Math.max(2, percent)}%` }} />
          )}
        </div>
      </button>

      <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
        <div className="min-w-0"><div className="text-xs text-ink-fade">{copy.chatId}</div><div title={session?.id} className={valueClass('font-mono')}>{session?.id || copy.noChat}</div></div>
        <div className="min-w-0"><div className="text-xs text-ink-fade">{copy.model}</div><div title={model} className={valueClass()}>{model || '—'}</div></div>
        <div className="min-w-0"><div className="text-xs text-ink-fade">{copy.messages}</div><div className={valueClass()}>{messages.length}</div></div>
        <div className="min-w-0"><div className="text-xs text-ink-fade">{copy.approval}</div><div className={valueClass()}>{modeLabel}</div></div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-ink/[0.08] pt-2.5">
        <div className="flex items-center gap-2 text-xs text-ink-fade"><ListTodo className="h-4 w-4" /><span>{copy.tasks}</span><span className="text-ink-soft">{running} {copy.running} · {pending} {copy.pending}</span></div>
        <button type="button" onClick={onOpenTasks} className="rounded-lg px-2.5 py-1.5 text-xs text-ink-soft hover:bg-ink/[0.05] hover:text-ink">{copy.openTasks}</button>
      </div>
    </section>
  )
}
