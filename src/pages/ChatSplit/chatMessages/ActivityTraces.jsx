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

const PROGRESS_PHASE_KEYS = {
  tool_completed: 'chatMessages.progressPhaseToolCompleted',
  batch_completed: 'chatMessages.progressPhaseBatchCompleted',
  verify: 'chatMessages.progressPhaseVerify',
  editing: 'chatMessages.progressPhaseEditing',
}

function readablePhase(phase, t) {
  const value = String(phase || '').trim()
  if (!value) return ''
  const key = PROGRESS_PHASE_KEYS[value]
  return key ? t(key) : value.replace(/[_-]+/g, ' ')
}

export function ProgressTrace({ progress = null }) {
  const { t } = useT()
  if (!progress || typeof progress !== 'object') return null

  const details = []
  if (progress.phase) {
    details.push({
      key: 'phase',
      label: t('chatMessages.progressPhase', { phase: readablePhase(progress.phase, t) }),
      title: String(progress.phase),
    })
  }
  if (nonNegativeInteger(progress.completed) && nonNegativeInteger(progress.total)) {
    details.push({ key: 'steps', label: t('chatMessages.progressSteps', { completed: progress.completed, total: progress.total }) })
  } else if (nonNegativeInteger(progress.completed)) {
    details.push({ key: 'completed', label: t('chatMessages.progressCompleted', { completed: progress.completed }) })
  } else if (nonNegativeInteger(progress.total)) {
    details.push({ key: 'total', label: t('chatMessages.progressTotal', { total: progress.total }) })
  }
  if (nonNegativeInteger(progress.iteration)) {
    details.push({ key: 'iteration', label: t('chatMessages.progressIteration', { iteration: progress.iteration }) })
  }
  if (nonNegativeInteger(progress.filesChanged)) {
    details.push({ key: 'files', label: t('chatMessages.progressFiles', { count: progress.filesChanged }) })
  }
  if (nonNegativeInteger(progress.additions) || nonNegativeInteger(progress.deletions)) {
    details.push({
      key: 'changes',
      label: t('chatMessages.progressChanges', {
        additions: nonNegativeInteger(progress.additions) ? progress.additions : 0,
        deletions: nonNegativeInteger(progress.deletions) ? progress.deletions : 0,
      }),
    })
  }
  if (!details.length) return null

  return (
    <div data-testid="turn-progress" className="chat-progress-trace" role="status" aria-live="polite">
      <span className="chat-progress-label">{t('chatMessages.progressLabel')}</span>
      <div className="chat-progress-chips">
        {details.map((detail) => (
          <span key={detail.key} className={`chat-progress-chip chat-progress-chip-${detail.key}`} title={detail.title}>
            {detail.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function ToolCallTrace({ calls = [] }) {
  const { t } = useT()
  const normalizedCalls = Array.isArray(calls) ? calls : []
  const [expanded, setExpanded] = useState(() => normalizedCalls.some((call) => call.status === 'running'))
  const panelId = useId()
  if (normalizedCalls.length === 0) return null

  const failed = normalizedCalls.filter((call) => call.status === 'error').length
  const running = normalizedCalls.filter((call) => call.status === 'running').length
  const completed = normalizedCalls.length - running
  const StatusIcon = running > 0 ? Loader2 : failed > 0 ? XCircle : CheckCircle2
  const statusClass = running > 0 ? 'text-ember animate-spin' : failed > 0 ? 'text-red-600' : 'text-emerald-600'
  const stateLabel = running > 0
    ? t('chatMessages.runningSteps', { count: running })
    : failed > 0
      ? t('chatMessages.failedSteps', { count: failed })
      : t('chatMessages.steps', { count: normalizedCalls.length })

  return (
    <section className="chat-activity-panel" aria-label={t('chatMessages.execution')}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={t('chatMessages.executionToggle', {
          state: expanded ? t('chatMessages.collapse') : t('chatMessages.expand'),
          completed,
          total: normalizedCalls.length,
        })}
        className="chat-activity-summary"
      >
        <StatusIcon className={`chat-activity-status h-4 w-4 ${statusClass}`} aria-hidden="true" />
        <span className="chat-activity-title">{t('chatMessages.execution')}</span>
        <span className="chat-activity-state" data-status={running > 0 ? 'running' : failed > 0 ? 'error' : 'success'}>
          {stateLabel}
        </span>
        <span className="chat-activity-count">{t('chatMessages.executionSummary', { completed, total: normalizedCalls.length })}</span>
        <ChevronDown className={`chat-activity-chevron h-3.5 w-3.5 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
      </button>
      {expanded && (
        <div id={panelId} className="chat-tool-list" role="list">
          {normalizedCalls.map((call, index) => call.name === 'Agent'
            ? <SubagentCard key={call.id} call={call} stepNumber={index + 1} />
            : <ToolCallCard key={call.id} call={call} stepNumber={index + 1} />)}
        </div>
      )}
    </section>
  )
}
