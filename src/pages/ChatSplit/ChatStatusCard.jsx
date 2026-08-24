import { useMemo } from 'react'
import { Gauge, ListTodo, X } from 'lucide-react'
import { estimateClientContextUsage } from '../../lib/contextUsage.js'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'
import { useT } from '../../i18n/I18nProvider.jsx'

function valueClass(extra = '') {
  return `mt-1 truncate text-[13px] font-medium text-ink ${extra}`
}

export default function ChatStatusCard({
  session,
  messages = [],
  tasks = [],
  model,
  contextWindow,
  toolSpecs,
  systemPrompt,
  approvalMode,
  onClose,
  onOpenTasks,
  onOpenContext,
}) {
  const { lang } = useT()
  const copy = getSlashActionCopy(lang).statusPanel
  const usage = useMemo(() => estimateClientContextUsage({
    messages,
    tools: toolSpecs,
    systemPrompt,
    contextWindow,
  }), [contextWindow, messages, systemPrompt, toolSpecs])
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

      <button type="button" onClick={onOpenContext} className="mt-3 block w-full rounded-xl bg-ink/[0.035] px-3 py-2.5 text-left hover:bg-ink/[0.055]">
        <div className="flex items-center justify-between text-xs text-ink-fade">
          <span>{copy.context}</span>
          <span className="font-mono">~{usage.estimatedTokens.toLocaleString()} / {usage.contextWindow.toLocaleString()} · {usage.percent}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
          <div className={`h-full rounded-full ${usage.percent >= 80 ? 'bg-danger' : usage.percent >= 60 ? 'bg-warning' : 'bg-ink/55'}`} style={{ width: `${Math.max(2, usage.percent)}%` }} />
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
