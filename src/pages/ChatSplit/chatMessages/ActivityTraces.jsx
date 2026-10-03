import { useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import ToolCallCard from '../../../components/ToolCallCard.jsx'
import { groupKindCounts, groupToolCalls } from '../../../lib/toolStepKinds.js'
import SubagentCard from '../../../components/SubagentCard.jsx'
import LiveElapsed from '../../../components/LiveElapsed.jsx'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { UiContributionRenderer, useUiContributions } from '../../../plugins/uiContributionRegistry.js'

export function ReasoningTrace({ text = '', streaming = false, completed = false, label = '', detail = '', startedAt, testId }) {
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
      <span className="chat-thinking-copy">
        <span>{label || (streaming ? t('chatMessages.reasoningActive') : t('chatMessages.reasoningCompleted'))}</span>
        {streaming && detail && <span className="chat-thinking-detail" data-testid="model-activity-detail">{detail}</span>}
      </span>
      {streaming && <LiveElapsed className="chat-thinking-elapsed" startedAt={startedAt} title={startedAt ? t('toolActivity.requestElapsed') : undefined} />}
    </div>
  )
}

/**
 * One recorded call as a row. Shared by the run timeline and by the ReAct loop
 * view, so a step looks and behaves the same wherever it appears — including
 * whatever a plugin contributes for that tool.
 */
export function ToolStepRow({
  call, artifacts = [], contributedToolViews = [], expanded, onOpenArtifact, onToggle, stepNumber, workspacePath = '',
}) {
  // The run timeline drives one open row at a time from above. The ReAct loop
  // renders rows on their own, so an uncontrolled row keeps its own state —
  // without it the row had nothing to open with and the call could not be
  // inspected at all.
  const [selfExpanded, setSelfExpanded] = useState(false)
  const controlled = typeof onToggle === 'function'
  const isExpanded = controlled ? expanded === true : selfExpanded
  const toggle = controlled ? onToggle : () => setSelfExpanded((value) => !value)
  const defaultView = call?.name === 'Agent'
    ? <SubagentCard call={call} />
    : <ToolCallCard
        call={call}
        stepNumber={stepNumber}
        artifacts={artifacts}
        onOpenArtifact={onOpenArtifact}
        expanded={isExpanded}
        onToggle={toggle}
        workspacePath={workspacePath}
      />
  const contributedView = contributedToolViews.find((entry) => entry.toolNames.includes(call?.name))
  return (
    <div className="chat-tool-step-motion" data-ui-plugin={contributedView?.pluginId}>
      {contributedView
        ? <UiContributionRenderer
            contribution={contributedView}
            context={{ artifacts, call, expanded: isExpanded, onOpenArtifact, onToggle: toggle, stepNumber }}
            fallback={defaultView}
          />
        : defaultView}
    </div>
  )
}

export function ToolCallTrace({ calls = [], stepOffset = 0, artifacts = [], onOpenArtifact, workspacePath = '' }) {
  const { t } = useT()
  const normalizedCalls = Array.isArray(calls) ? calls : []
  const contributedToolViews = useUiContributions('tool-view')
  const [showAll, setShowAll] = useState(false)
  const [expandedCallKey, setExpandedCallKey] = useState(null)
  // Groups start open. The whole run already sits inside one collapsed
  // disclosure after the turn ends, so a second wall of closed drawers inside it
  // would hide exactly the working-out that makes the run trustworthy.
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
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

  const renderCall = ({ call, index: callIndex }) => {
    const stepNumber = stepOffset + callIndex + 1
    const callKey = stableCallKey(call, normalizedCalls, callIndex)
    const toggle = () => {
      if (expandedCallKey === callKey) {
        setExpandedCallKey(null)
        return
      }
      setExpandedCallKey(callKey)
    }
    return (
      <ToolStepRow
        key={callKey}
        call={call}
        artifacts={artifacts}
        contributedToolViews={contributedToolViews}
        expanded={expandedCallKey === callKey}
        onOpenArtifact={onOpenArtifact}
        onToggle={toggle}
        stepNumber={stepNumber}
        workspacePath={workspacePath}
      />
    )
  }

  // Consecutive same-family calls read as one phase of work ("查阅 · 2 搜索,
  // 2 文件"); a lone call is just its own row. Which calls these are is decided
  // by the recorded tool names only — see lib/toolStepKinds.js.
  //
  // Groups are built from every call so a row keeps its original index, then
  // trimmed to the visible slice: the compact history limit still holds inside a
  // group, and the group header describes what is actually on screen.
  const groups = groupToolCalls(normalizedCalls)
  const visibleIndexes = new Set(visibleEntries.map((entry) => entry.index))
  const visibleGroups = groups
    .map((group) => ({ ...group, members: showAll ? group.calls : group.calls.filter((entry) => visibleIndexes.has(entry.index)) }))
    .filter((group) => group.members.length > 0)

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
        {visibleGroups.map((group) => {
          const first = group.members[0]
          if (group.members.length === 1) return renderCall(first)
          const groupKey = `${first.index}:${group.family}`
          const groupOpen = !collapsedGroups.has(groupKey)
          const counts = groupKindCounts({ calls: group.members })
            .map(({ kind, count }) => t('toolActivity.kindCount', { count, label: t(`toolActivity.count${kindLabelSuffix(kind)}`) }))
            .join(t('toolActivity.kindCountSeparator'))
          return (
            <div className="chat-tool-group" key={groupKey} data-family={group.family}>
              <button
                type="button"
                className="chat-tool-group-head"
                data-testid="tool-group-toggle"
                aria-expanded={groupOpen}
                onClick={() => setCollapsedGroups((current) => {
                  const next = new Set(current)
                  if (next.has(groupKey)) next.delete(groupKey)
                  else next.add(groupKey)
                  return next
                })}
              >
                <span className="chat-tool-group-label">{t(`toolActivity.family${familyLabelSuffix(group.family)}`)}</span>
                <span className="chat-tool-group-counts" data-testid="tool-group-counts">{counts}</span>
                <ChevronDown className={`chat-tool-group-chevron ${groupOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
              {groupOpen && <div className="chat-tool-group-body">{group.members.map(renderCall)}</div>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function kindLabelSuffix(kind) {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
}

function familyLabelSuffix(family) {
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}`
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
