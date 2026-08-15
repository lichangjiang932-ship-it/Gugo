import { useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import ToolCallCard from '../../../components/ToolCallCard.jsx'
import SubagentCard from '../../../components/SubagentCard.jsx'
import LiveElapsed from '../../../components/LiveElapsed.jsx'

// Execution traces (reasoning status / tool timeline) use English technical
// labels regardless of UI language: they are technical facts.

export function ReasoningTrace({ text = '', streaming = false, label = '', testId }) {
  // Providers can stream very large private reasoning payloads. Rendering that
  // payload makes the answer harder to follow and can freeze long chats. Keep
  // only a compact live status; verified tool activity remains visible below.
  if (!streaming) return null
  return <div className="chat-thinking-line" role="status" aria-live="polite" data-testid={testId} data-has-reasoning={Boolean(text)}><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /><span>{label || 'Thinking…'}</span><LiveElapsed className="chat-thinking-elapsed" /></div>
}

export function ToolCallTrace({ calls = [], artifacts = [], onOpenArtifact }) {
  const normalizedCalls = Array.isArray(calls) ? calls : []
  const [showAll, setShowAll] = useState(false)
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
      aria-label={`${normalizedCalls.length} steps`}
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
          <span>{showAll ? 'Collapse' : 'Expand'}</span>
          <span>{`${showAll ? normalizedCalls.length : hiddenCount} steps`}</span>
        </button>
      )}
      {/* Static document flow (no transform animations): expanding argument or
          result details simply pushes the following content down, like the
          deepseek-harness tool display. */}
      <div className="chat-tool-list" role="list">
        {visibleCalls.map((call, index) => {
          const stepNumber = startIndex + index + 1
          return (
            <div
              key={call.id || `${call.name || 'tool'}-${stepNumber}`}
              className="chat-tool-step-motion"
            >
              {call.name === 'Agent'
                ? <SubagentCard call={call} stepNumber={stepNumber} />
                : <ToolCallCard
                    call={call}
                    stepNumber={stepNumber}
                    artifacts={artifacts}
                    onOpenArtifact={onOpenArtifact}
                  />}
            </div>
          )
        })}
      </div>
    </section>
  )
}
