import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import MarkdownRenderer from '../../../../components/MarkdownRenderer.jsx'
import { isPreExecutionFailure } from '../../../../lib/chatFlowGuards.js'
import { executionResultSummary } from '../../../../lib/executionResultSummary.js'
import { ToolCallTrace } from '../ActivityTraces.jsx'
import { modelContextDiagnosticsSchema } from '../../../../../shared/modelContextDiagnostics.js'
import { modelWireDiagnosticsSchema } from '../../../../../shared/modelWireDiagnostics.js'
import { completionPoliciesSchema } from '../../../../../shared/turnFailureSchemas.js'
import { normalizeModelUsage } from '../../../../../shared/modelUsage.js'

function safeRecallSummary(recall) {
  if (!recall) return '—'
  const code = /^(?:MEMORY|SQLITE)_[A-Z0-9_]{1,80}$/u.test(recall.code || '') ? recall.code : ''
  const coverage = recall.truncated ? 'partial'
    : ['full', 'complete', 'partial', 'unknown', 'unavailable', 'disabled', 'skipped'].includes(recall.coverage) ? recall.coverage : '—'
  return [coverage, recall.scanned, code].filter((value) => value !== '').join(' / ')
}

function ExecutionDiagnostics({ meta = {}, t }) {
  const context = modelContextDiagnosticsSchema.safeParse(meta.modelContextDiagnostics)
  const wire = modelWireDiagnosticsSchema.safeParse(meta.modelWireDiagnostics)
  const policyResult = completionPoliciesSchema.safeParse(meta.serverFailure?.completionPolicies)
  const policies = policyResult.success ? policyResult.data || [] : []
  if (!context.success && !wire.success && !policies.length) return null
  const usage = normalizeModelUsage(meta.modelUsage)
  const requestId = typeof meta.modelRequestId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(meta.modelRequestId)
    ? meta.modelRequestId : null
  const attempt = Number.isSafeInteger(meta.modelPhysicalAttempt) && meta.modelPhysicalAttempt > 0 ? meta.modelPhysicalAttempt : '—'
  const memory = context.success ? context.data.memory : null
  return (
    <section data-testid="execution-diagnostics" aria-label={t('chatMessages.executionDiagnostics')} className="text-xs text-ink-fade">
      <p>{t('chatMessages.executionDiagnostics')}</p>
      <ul>
        {requestId && <li>{t('chatMessages.diagnosticRequest', { id: requestId, attempt })}</li>}
        {context.success && <li>{t('chatMessages.diagnosticContext', { messages: context.data.messageCount, tools: context.data.toolCount })}</li>}
        {wire.success && <li>{t('chatMessages.diagnosticFingerprint', { fingerprint: wire.data.prefixFingerprint?.slice(0, 12) || '—' })}</li>}
        {(context.success || wire.success) && <li>{usage?.cacheHitTokens === undefined
          ? t('chatMessages.diagnosticCacheUnknown') : t('chatMessages.diagnosticCacheReported', { count: usage.cacheHitTokens })}</li>}
        {memory && <li>{t('chatMessages.diagnosticMemory', { count: memory.linkedCount,
          semantic: memory.failed ? t('chatMessages.memoryLoadFailed') : safeRecallSummary(memory.semantic),
          lexical: memory.failed ? t('chatMessages.memoryLoadFailed') : safeRecallSummary(memory.lexical) })}</li>}
        {policies.map((policy) => <li key={policy.id} data-exhausted={policy.exhausted || undefined}>
          {t('chatMessages.diagnosticPolicy', { id: policy.id, attempts: policy.attempts, limit: policy.limit ?? '—' })}
        </li>)}
      </ul>
    </section>
  )
}

export function TimelineSegments({ artifacts, onLinkClick, onOpenArtifact, segments, streaming }) {
  return segments.map((segment, index) => segment.kind === 'tools' ? (
    <ToolCallTrace
      key={segment.key}
      calls={segment.calls}
      stepOffset={segment.stepOffset}
      artifacts={artifacts}
      onOpenArtifact={onOpenArtifact}
    />
  ) : (
    <MarkdownRenderer
      key={segment.key}
      artifactReferences={artifacts}
      streaming={streaming && index === segments.length - 1}
      onLinkClick={onLinkClick}
    >
      {segment.text}
    </MarkdownRenderer>
  ))
}

function finiteOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function ExecutionDisclosure({ children, hasExecution, msg, running, t }) {
  const [expanded, setExpanded] = useState(running)
  const wasRunning = useRef(running)
  const contentId = useId()
  const [fallbackStartedAt] = useState(() => Date.now())
  const storedLatency = finiteOptionalNumber(msg.meta?.latency)
  const storedStartedAt = finiteOptionalNumber(msg.meta?.turnStartedAt)
  const storedCompletedAt = finiteOptionalNumber(msg.meta?.turnCompletedAt)
  const hasStoredLatency = storedLatency !== null
  const hasStoredInterval = storedStartedAt !== null && storedCompletedAt !== null
  const hasElapsedTime = msg.meta?.executionStarted !== false
    && !isPreExecutionFailure(msg)
    && (running || hasStoredLatency || hasStoredInterval)
  const derivedLatency = hasStoredInterval
    ? Math.max(0, storedCompletedAt - storedStartedAt)
    : null
  const elapsedMs = !running
    ? hasStoredLatency ? Math.max(0, storedLatency) : derivedLatency ?? 0
    : null
  const startedAt = storedStartedAt ?? finiteOptionalNumber(msg.timestamp) ?? fallbackStartedAt
  const elapsed = useElapsedMilliseconds({ elapsedMs, running, startedAt })
  const elapsedLabel = hasElapsedTime ? t('chatMessages.elapsed', { value: formatTaskDuration(elapsed, t) }) : ''
  const toolCount = Array.isArray(msg.meta?.toolCalls) ? msg.meta.toolCalls.length : 0
  const hasReasoningSummary = Boolean(String(msg.meta?.reasoning || '').trim())
  const processLabel = toolCount > 0
    ? t('chatMessages.execution')
    : running || hasReasoningSummary
      ? t(running ? 'chatMessages.reasoningActive' : 'chatMessages.reasoningCompleted')
      : t('chatMessages.execution')
  const label = [
    processLabel,
    hasElapsedTime ? formatTaskDuration(elapsed, t) : '',
    toolCount > 0 ? t('chatMessages.executionToolCount', { count: toolCount }) : '',
  ].filter(Boolean).join(' · ')
  const resultSummary = !running && !expanded ? executionResultSummary(msg.meta?.toolCalls, t) : ''

  useEffect(() => {
    // Keep live work visible, then fold the process exactly once when that
    // turn completes so the final answer becomes the visual focus. A later
    // manual expansion is preserved because completed rerenders do not touch
    // the state again.
    if (running && !wasRunning.current) setExpanded(true)
    if (!running && wasRunning.current) setExpanded(false)
    wasRunning.current = running
  }, [running])

  const hasDiagnostics = Boolean(msg.meta?.modelContextDiagnostics || msg.meta?.modelWireDiagnostics
    || msg.meta?.serverFailure?.completionPolicies?.length)
  if (!hasExecution && !hasDiagnostics) {
    return elapsedLabel
      ? <div className="chat-task-duration" data-testid="task-duration-header">{elapsedLabel}</div>
      : null
  }

  return (
    <section className="chat-execution-disclosure" data-running={running || undefined}>
      <button
        type="button"
        className="chat-execution-toggle"
        data-testid="execution-toggle"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span data-testid="task-duration-header">{label}</span>
        {resultSummary && <span className="chat-execution-result" data-testid="execution-result-summary"> · {resultSummary}</span>}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {expanded && <div id={contentId} className="chat-execution-content" data-testid="execution-content">
        {children}
        <ExecutionDiagnostics meta={msg.meta} t={t} />
      </div>}
    </section>
  )
}

function useElapsedMilliseconds({ elapsedMs, running, startedAt }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || elapsedMs !== null) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [elapsedMs, running])
  return elapsedMs !== null ? elapsedMs : Math.max(0, now - startedAt)
}

function formatTaskDuration(milliseconds, t) {
  const normalizedMilliseconds = Math.max(0, Number(milliseconds) || 0)
  if (normalizedMilliseconds < 1000) return t('chatMessages.durationLessThanSecond')
  const totalSeconds = Math.floor(normalizedMilliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0
    ? t('chatMessages.durationMinutesSeconds', { minutes, seconds })
    : t('chatMessages.durationSeconds', { seconds })
}
