import { AGENT_SECTION_KINDS } from '../../../../../shared/agentReportSections.js'
import MarkdownRenderer from '../../../../components/MarkdownRenderer.jsx'

/**
 * Renders the parsed ReAct trajectory (Thought / Action / Observation) that the
 * model wrote as plain text.
 *
 * This is deliberately a plain list, not a second accordion: it is placed
 * *inside* the existing execution disclosure so a completed turn has exactly
 * one collapsed area holding every intermediate step, in the order it happened.
 */
const LABEL_KEYS = Object.freeze({
  [AGENT_SECTION_KINDS.THOUGHT]: 'agentReport.thought',
  [AGENT_SECTION_KINDS.ACTION]: 'agentReport.action',
  [AGENT_SECTION_KINDS.OBSERVATION]: 'agentReport.observation',
})

export default function TrajectoryEntries({ entries = [], t }) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.text) : []
  if (list.length === 0) return null
  return (
    <ol className="chat-trajectory" data-testid="trajectory-entries">
      {list.map((entry, index) => (
        <li
          // Position is the identity here: the same section can repeat, and the
          // list is replaced wholesale when the message updates.
          key={`${entry.kind}:${index}`}
          className={`chat-trajectory-step chat-trajectory-step-${entry.kind}`}
          data-testid="trajectory-entry"
          data-trajectory-kind={entry.kind}
        >
          <span className="chat-trajectory-label" data-testid="trajectory-entry-label">
            {t(LABEL_KEYS[entry.kind] || 'agentReport.thought')}
          </span>
          <div className="chat-trajectory-body">
            <MarkdownRenderer>{entry.text}</MarkdownRenderer>
          </div>
        </li>
      ))}
    </ol>
  )
}
