import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ChevronDown, Loader2 } from 'lucide-react'
import ToolCallCard from '../../../components/ToolCallCard.jsx'
import SubagentCard from '../../../components/SubagentCard.jsx'
import LiveElapsed from '../../../components/LiveElapsed.jsx'
import { useT } from '../../../i18n/I18nProvider.jsx'

export function ReasoningTrace({ text = '', streaming = false, label = '', testId }) {
  const { t } = useT()
  // Providers can stream very large private reasoning payloads. Rendering that
  // payload makes the answer harder to follow and can freeze long chats. Keep
  // only a compact live status; verified tool activity remains visible below.
  if (!streaming) return null
  return <div className="chat-thinking-line" role="status" aria-live="polite" data-testid={testId} data-has-reasoning={Boolean(text)}><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /><span>{label || t('chatMessages.reasoningActive')}</span><LiveElapsed className="chat-thinking-elapsed" /></div>
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

export function ToolCallTrace({ calls = [], artifacts = [], onOpenArtifact }) {
  const { t } = useT()
  const normalizedCalls = Array.isArray(calls) ? calls : []
  const [showAll, setShowAll] = useState(false)
  const reduceMotion = useReducedMotion()
  const visibleLimit = 4
  const hiddenCount = Math.max(0, normalizedCalls.length - visibleLimit)
  const startIndex = showAll ? 0 : hiddenCount
  const visibleCalls = showAll ? normalizedCalls : normalizedCalls.slice(startIndex)
  const running = normalizedCalls.some((call) => call.status === 'running')
  const failed = normalizedCalls.some((call) => call.status === 'error')
  const cancelled = normalizedCalls.some((call) => call.status === 'cancelled')

  if (normalizedCalls.length === 0) return null

  return (
    <section
      className="chat-run-timeline"
      data-status={running ? 'running' : failed ? 'error' : cancelled ? 'cancelled' : 'success'}
      aria-label={t('chatMessages.steps', { count: normalizedCalls.length })}
      aria-busy={running}
    >
      {hiddenCount > 0 && (
        <button
          type="button"
          className="chat-timeline-history"
          onClick={() => setShowAll((value) => !value)}
          aria-expanded={showAll}
        >
          <ChevronDown className={`h-3.5 w-3.5 ${showAll ? 'rotate-180' : ''}`} aria-hidden="true" />
          <span>{showAll ? t('chatMessages.collapse') : t('chatMessages.expand')}</span>
          <span>{t('chatMessages.steps', { count: showAll ? normalizedCalls.length : hiddenCount })}</span>
        </button>
      )}
      <motion.div className="chat-tool-list" role="list" layout={reduceMotion ? false : 'position'}>
        {visibleCalls.map((call, index) => {
          const stepNumber = startIndex + index + 1
          return (
            <motion.div
              key={call.id || `${call.name || 'tool'}-${stepNumber}`}
              className="chat-tool-step-motion"
              layout={reduceMotion ? false : 'position'}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.2, 0, 0, 1] }}
            >
              {call.name === 'Agent'
                ? <SubagentCard call={call} stepNumber={stepNumber} />
                : <ToolCallCard
                    call={call}
                    stepNumber={stepNumber}
                    artifacts={artifacts}
                    onOpenArtifact={onOpenArtifact}
                  />}
            </motion.div>
          )
        })}
      </motion.div>
    </section>
  )
}
