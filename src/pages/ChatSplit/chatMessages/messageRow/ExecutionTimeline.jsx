import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import MarkdownRenderer from '../../../../components/MarkdownRenderer.jsx'
import { isPreExecutionFailure } from '../../../../lib/chatFlowGuards.js'
import { executionResultSummary } from '../../../../lib/executionResultSummary.js'
import { ToolCallTrace } from '../ActivityTraces.jsx'

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

export function ExecutionDisclosure({ children, hasExecution, msg, running, preserveNarration = false, t }) {
  const [expanded, setExpanded] = useState(running || preserveNarration)
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
  const label = [
    t('chatMessages.execution'),
    hasElapsedTime ? formatTaskDuration(elapsed, t) : '',
    toolCount > 0 ? t('chatMessages.executionToolCount', { count: toolCount }) : '',
  ].filter(Boolean).join(' · ')
  const resultSummary = !running && !expanded ? executionResultSummary(msg.meta?.toolCalls, t) : ''

  useEffect(() => {
    // Public narration is part of the conversation, not diagnostic detail.
    // Keep it readable after completion/cancellation. A tool-only history can
    // still fold once, and subsequent user disclosure choices remain intact.
    if (running && !wasRunning.current) setExpanded(true)
    if (!running && wasRunning.current && !preserveNarration) setExpanded(false)
    wasRunning.current = running
  }, [running, preserveNarration])

  if (!hasExecution) {
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
