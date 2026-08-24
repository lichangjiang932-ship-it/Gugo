import { useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import ToolCallCard from '../../../components/ToolCallCard.jsx'
import SubagentCard from '../../../components/SubagentCard.jsx'
import LiveElapsed from '../../../components/LiveElapsed.jsx'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { UiContributionRenderer, useUiContributions } from '../../../plugins/uiContributionRegistry.js'

export function ReasoningTrace({ text = '', streaming = false, completed = false, label = '', testId }) {
  const { t } = useT()
  // Providers can stream very large private reasoning payloads. Rendering that
  // payload makes the answer harder to follow and can freeze long chats. Keep
  // a compact status after completion without exposing private chain-of-thought.
  if (!streaming && !completed) return null
  return (
    <div
      className="chat-thinking-line"
      role={streaming ? 'status' : undefined}
      aria-live={streaming ? 'polite' : undefined}
      data-state={streaming ? 'running' : 'complete'}
      data-testid={testId}
      data-has-reasoning={Boolean(text)}
    >
      {streaming
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
      <span>{label || (streaming ? t('chatMessages.reasoningActive') : t('chatMessages.reasoningCompleted'))}</span>
      {streaming && <LiveElapsed className="chat-thinking-elapsed" />}
    </div>
  )
}

export function ToolCallTrace({ calls = [], stepOffset = 0, artifacts = [], onOpenArtifact }) {
  const { t } = useT()
  const normalizedCalls = Array.isArray(calls) ? calls : []
  const contributedToolViews = useUiContributions('tool-view')
  const [showAll, setShowAll] = useState(false)
  const [expandedCallKey, setExpandedCallKey] = useState(null)
  const visibleLimit = 4
  const collapsedEntries = (() => {
    const visibleIndexes = new Set()
    for (let index = Math.max(0, normalizedCalls.length - visibleLimit); index < normalizedCalls.length; index += 1) {
      visibleIndexes.add(index)
    }
    // Never hide an active operation behind newer completed siblings. If
    // more than four calls are still running, showing all of them is more
    // important than enforcing the compact history limit.
    normalizedCalls.forEach((call, index) => {
      if (call?.status === 'running') visibleIndexes.add(index)
    })
    return [...visibleIndexes].sort((left, right) => left - right)
      .map((index) => ({ call: normalizedCalls[index], index }))
  })()
  const visibleEntries = showAll
    ? normalizedCalls.map((call, index) => ({ call, index }))
    : collapsedEntries
  const hiddenCount = Math.max(0, normalizedCalls.length - collapsedEntries.length)
  const running = normalizedCalls.some((call) => call.status === 'running')
  const failed = normalizedCalls.some((call) => call.status === 'error')
  const cancelled = normalizedCalls.some((call) => call.status === 'cancelled')
  if (normalizedCalls.length === 0) return null

  return (
    <section
      className="chat-run-timeline"
      data-status={running ? 'running' : failed ? 'error' : cancelled ? 'cancelled' : 'success'}
      aria-label={t('chatMessages.toolCalls', { count: normalizedCalls.length })}
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
          <span>{t('chatMessages.toolCalls', { count: showAll ? normalizedCalls.length : hiddenCount })}</span>
        </button>
      )}
      {/* Static document flow (no transform animations): expanding argument or
          result details simply pushes the following content down, like the
          deepseek-harness tool display. */}
      <div className="chat-tool-list" role="list">
        {visibleEntries.map(({ call, index: callIndex }) => {
          const stepNumber = stepOffset + callIndex + 1
          const callKey = stableCallKey(call, normalizedCalls, callIndex)
          const toggle = () => {
            if (expandedCallKey === callKey) {
              setExpandedCallKey(null)
              return
            }
            setExpandedCallKey(callKey)
          }
          const defaultView = call.name === 'Agent'
            ? <SubagentCard call={call} stepNumber={stepNumber} />
            : <ToolCallCard
                call={call}
                stepNumber={stepNumber}
                artifacts={artifacts}
                onOpenArtifact={onOpenArtifact}
                expanded={expandedCallKey === callKey}
                onToggle={toggle}
              />
          const contributedView = contributedToolViews.find((entry) => entry.toolNames.includes(call.name))
          return (
            <div
              key={callKey}
              className="chat-tool-step-motion"
              data-ui-plugin={contributedView?.pluginId}
            >
              {contributedView
                ? <UiContributionRenderer
                    contribution={contributedView}
                    context={{
                      artifacts,
                      call,
                      expanded: expandedCallKey === callKey,
                      onOpenArtifact,
                      onToggle: toggle,
                      stepNumber,
                    }}
                    fallback={defaultView}
                  />
                : defaultView}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function stableCallKey(call, calls, index) {
  if (call?.id != null && String(call.id).trim()) return String(call.id)
  const signature = `${call?.name || 'tool'}\u0000${String(call?.arguments || '')}`
  let occurrence = 0
  for (let cursor = 0; cursor < index; cursor += 1) {
    const candidate = calls[cursor]
    if (`${candidate?.name || 'tool'}\u0000${String(candidate?.arguments || '')}` === signature) occurrence += 1
  }
  let hash = 2166136261
  for (let cursor = 0; cursor < signature.length; cursor += 1) {
    hash ^= signature.charCodeAt(cursor)
    hash = Math.imul(hash, 16777619)
  }
  return `legacy-${(hash >>> 0).toString(36)}-${occurrence}`
}
