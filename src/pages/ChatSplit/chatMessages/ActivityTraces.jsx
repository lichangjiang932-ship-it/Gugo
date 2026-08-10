import { useId, useState } from 'react'
import { CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react'
import ToolCallCard from '../../../components/ToolCallCard.jsx'
import SubagentCard from '../../../components/SubagentCard.jsx'
import { useT } from '../../../i18n/I18nProvider.jsx'

export function ReasoningTrace({ text = '', streaming = false }) {
  const { t } = useT()
  // Providers can stream very large private reasoning payloads. Rendering that
  // payload makes the answer harder to follow and can freeze long chats. Keep
  // only a compact live status; verified tool activity remains visible below.
  if (!text || !streaming) return null
  return <div className="mb-2 inline-flex items-center gap-2 rounded-md bg-paper-2/70 px-2.5 py-1.5 text-xs text-ink-soft" role="status" aria-live="polite"><Loader2 className="h-3.5 w-3.5 animate-spin text-cyan" aria-hidden="true" /><span>{t('chatMessages.reasoningActive')}</span></div>
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

export function ProgressTrace({ progress = null }) {
  const { t } = useT()
  if (!progress || typeof progress !== 'object') return null

  const details = []
  if (progress.phase) details.push(t('chatMessages.progressPhase', { phase: progress.phase }))
  if (nonNegativeInteger(progress.completed) && nonNegativeInteger(progress.total)) {
    details.push(t('chatMessages.progressSteps', { completed: progress.completed, total: progress.total }))
  } else if (nonNegativeInteger(progress.completed)) {
    details.push(t('chatMessages.progressCompleted', { completed: progress.completed }))
  } else if (nonNegativeInteger(progress.total)) {
    details.push(t('chatMessages.progressTotal', { total: progress.total }))
  }
  if (nonNegativeInteger(progress.iteration)) {
    details.push(t('chatMessages.progressIteration', { iteration: progress.iteration }))
  }
  if (nonNegativeInteger(progress.filesChanged)) {
    details.push(t('chatMessages.progressFiles', { count: progress.filesChanged }))
  }
  if (nonNegativeInteger(progress.additions) || nonNegativeInteger(progress.deletions)) {
    details.push(t('chatMessages.progressChanges', {
      additions: nonNegativeInteger(progress.additions) ? progress.additions : 0,
      deletions: nonNegativeInteger(progress.deletions) ? progress.deletions : 0,
    }))
  }
  if (!details.length) return null

  return (
    <div data-testid="turn-progress" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink/10 pt-2 font-mono text-[10px] leading-4 text-ink-fade" role="status" aria-live="polite">
      <span className="font-sans font-medium uppercase tracking-wide text-ink-soft">{t('chatMessages.progressLabel')}</span>
      {details.map((detail) => <span key={detail}>{detail}</span>)}
    </div>
  )
}

export function ToolCallTrace({ calls = [] }) {
  const { t } = useT()
  const [expanded, setExpanded] = useState(() => calls.some((call) => call.status === 'running'))
  const panelId = useId()
  const failed = calls.filter((call) => call.status === 'error').length
  const running = calls.filter((call) => call.status === 'running').length
  const completed = calls.length - running
  const StatusIcon = running > 0 ? Loader2 : failed > 0 ? XCircle : CheckCircle2
  const statusClass = running > 0 ? 'text-ember animate-spin' : failed > 0 ? 'text-red-600' : 'text-emerald-600'
  return <div className="chat-activity-panel mb-2 overflow-hidden"><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={panelId} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-paper-2/55"><StatusIcon className={`h-3.5 w-3.5 shrink-0 ${statusClass}`} /><span className="text-xs font-medium text-ink-soft">{t('chatMessages.execution')}</span><span className="min-w-0 flex-1 truncate text-xs text-ink-fade">{running > 0 ? t('chatMessages.runningSteps', { count: calls.length }) : t('chatMessages.steps', { count: calls.length })}{failed > 0 && <span className="ml-1.5 text-red-600">{t('chatMessages.failedSteps', { count: failed })}</span>}</span><span className="text-[10px] tabular-nums text-ink-fade">{completed}/{calls.length}</span><ChevronDown className={`h-3 w-3 shrink-0 text-ink-fade transition-transform ${expanded ? '' : '-rotate-90'}`} /></button>{expanded && <div id={panelId} className="chat-tool-list px-1 py-1">{calls.map((call) => call.name === 'Agent' ? <SubagentCard key={call.id} call={call} /> : <ToolCallCard key={call.id} call={call} />)}</div>}</div>
}
