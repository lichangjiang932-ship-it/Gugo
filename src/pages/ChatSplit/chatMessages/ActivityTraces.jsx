import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ChevronDown, Loader2 } from 'lucide-react'
import ToolCallCard from '../../../components/ToolCallCard.jsx'
import SubagentCard from '../../../components/SubagentCard.jsx'

// ★ 执行过程(推理状态/进度条/工具时间线)按用户要求使用全英文技术标签,
// 与界面语言无关:执行轨迹属于技术事实,不随 UI 语言翻译。

export function ReasoningTrace({ text = '', streaming = false, label = '', testId }) {
  // Providers can stream very large private reasoning payloads. Rendering that
  // payload makes the answer harder to follow and can freeze long chats. Keep
  // only a compact live status; verified tool activity remains visible below.
  if (!streaming) return null
  return <div className="chat-thinking-line" role="status" aria-live="polite" data-testid={testId} data-has-reasoning={Boolean(text)}><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /><span>{label || 'Thinking…'}</span></div>
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

const PROGRESS_PHASE_LABELS_EN = {
  tool_completed: 'Tool completed',
  batch_completed: 'Batch completed',
  verify: 'Verifying',
  editing: 'Editing',
}

function readablePhase(phase) {
  const value = String(phase || '').trim()
  if (!value) return ''
  return PROGRESS_PHASE_LABELS_EN[value] || value.replace(/[_-]+/g, ' ')
}

export function ProgressTrace({ progress = null }) {
  if (!progress || typeof progress !== 'object') return null

  const details = []
  if (progress.phase) {
    details.push({
      key: 'phase',
      label: `Phase: ${readablePhase(progress.phase)}`,
      title: String(progress.phase),
    })
  }
  if (nonNegativeInteger(progress.completed) && nonNegativeInteger(progress.total)) {
    details.push({ key: 'steps', label: `Step ${progress.completed}/${progress.total}` })
  } else if (nonNegativeInteger(progress.completed)) {
    details.push({ key: 'completed', label: `${progress.completed} completed` })
  } else if (nonNegativeInteger(progress.total)) {
    details.push({ key: 'total', label: `${progress.total} total` })
  }
  if (nonNegativeInteger(progress.iteration)) {
    details.push({ key: 'iteration', label: `Iteration ${progress.iteration}` })
  }
  if (nonNegativeInteger(progress.filesChanged)) {
    details.push({ key: 'files', label: `${progress.filesChanged} files` })
  }
  if (nonNegativeInteger(progress.additions) || nonNegativeInteger(progress.deletions)) {
    details.push({
      key: 'changes',
      label: `+${nonNegativeInteger(progress.additions) ? progress.additions : 0} / -${nonNegativeInteger(progress.deletions) ? progress.deletions : 0}`,
    })
  }
  if (!details.length) return null

  return (
    <div data-testid="turn-progress" className="chat-progress-trace" role="status" aria-live="polite">
      <span className="chat-progress-label">Progress</span>
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
      {/* ★ 展开 参数/结果 是纯文档流:去掉 layout 位移动画,否则展开时
          兄弟卡片会被 framer 做 transform 位移,与下方内容瞬态重叠。 */}
      <div className="chat-tool-list" role="list">
        {visibleCalls.map((call, index) => {
          const stepNumber = startIndex + index + 1
          return (
            <motion.div
              key={call.id || `${call.name || 'tool'}-${stepNumber}`}
              className="chat-tool-step-motion"
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
      </div>
    </section>
  )
}
