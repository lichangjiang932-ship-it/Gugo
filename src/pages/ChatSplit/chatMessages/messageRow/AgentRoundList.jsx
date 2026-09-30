import { Fragment } from 'react'
import MarkdownRenderer from '../../../../components/MarkdownRenderer.jsx'
import { AGENT_ROUND_KIND } from '../../../../lib/agentRounds.js'
import { useUiContributions } from '../../../../plugins/uiContributionRegistry.js'
import { ToolStepRow } from '../ActivityTraces.jsx'
import FileWriteCard from './FileWriteCard.jsx'
import { extractFileOutcomes, isFileWriteCall } from '../../../../../shared/agentStepMetadata.js'

/**
 * The process as the loop it is: 思考 / 行动 / 观察, repeating, with the recorded
 * call and its real output sitting under the action that asked for it.
 *
 * A prose step is its label plus the sentence — shown outright, never collapsed
 * behind a chevron. Only a call opens, because what it opens onto is real code:
 * the command and its output, or the diff a file change produced.
 */
const LABEL_KEYS = Object.freeze({
  [AGENT_ROUND_KIND.THOUGHT]: 'agentReport.thought',
  [AGENT_ROUND_KIND.ACTION]: 'agentReport.action',
  [AGENT_ROUND_KIND.OBSERVATION]: 'agentReport.observation',
})

// A step's header takes its opening sentence and the body carries the rest, so
// the text is neither repeated on both levels nor lost between them. A step that
// is a single sentence has nothing to preview: the sentence simply is the row.
const GIST_MAX_LENGTH = 64

function clampGist(text) {
  return text.length > GIST_MAX_LENGTH ? `${text.slice(0, GIST_MAX_LENGTH)}…` : text
}

function splitStep(text) {
  const raw = String(text || '').trim()
  if (!raw) return { gist: '', body: '' }
  const [firstLine] = raw.split('\n')
  if (raw.includes('\n')) {
    const rest = raw.slice(firstLine.length).trim()
    // A first line too long to read in the header keeps the whole text below it,
    // so nothing shown in the header is only reachable by guessing its tail.
    return { gist: clampGist(firstLine.trim()), body: rest || (firstLine.trim().length > GIST_MAX_LENGTH ? raw : '') }
  }
  const sentences = raw.match(/^([\s\S]{1,200}?[。！？!?])\s*([\s\S]+)$/u)
  if (sentences) return { gist: clampGist(sentences[1]), body: sentences[2] }
  return { gist: '', body: raw }
}
function RoundRow({ label, text, t }) {
  const { gist, body } = splitStep(text)
  // Nothing at all to say: a placeholder is not information.
  if (!gist && !body) return null
  // A label with nothing beside it is a bare tag, and a column of them turns the
  // transcript into a form. When the step has no opening line to preview, the
  // prose simply stands on its own.
  return (
    <div className={`chat-round chat-round-${label}`} data-testid="agent-round" data-round-kind={label}>
      {gist && (
        <div className="chat-round-head" data-testid="agent-round-head">
          <span className="chat-round-label" data-testid="agent-round-label">{t(LABEL_KEYS[label] || 'agentReport.thought')}</span>
          <span className="chat-round-summary" data-testid="agent-round-summary">{gist}</span>
        </div>
      )}
      {body && (
        <div className="chat-round-body" data-testid="agent-round-body">
          <MarkdownRenderer className="chat-round-text">{body}</MarkdownRenderer>
        </div>
      )}
    </div>
  )
}

export default function AgentRoundList({ artifacts = [], onOpenArtifact, rounds = [], t, workspacePath = '' }) {
  const contributedToolViews = useUiContributions('tool-view')
  const list = Array.isArray(rounds) ? rounds : []
  if (list.length === 0) return null

  return (
    <div className="chat-rounds" data-testid="agent-rounds">
      {list.map((round, index) => {
        const tool = round.tool
        return (
          <Fragment key={`${round.kind}:${index}`}>
            {round.kind !== AGENT_ROUND_KIND.TOOL && <RoundRow label={round.kind} text={round.text} t={t} />}
            {/* The recorded call follows the action that asked for it; a call the
                narrative never mentioned keeps its place at the end. */}
            {tool && (
              <div className="chat-round-tool" data-testid="agent-round-tool" data-leftover={round.leftover ? 'true' : undefined}>
                {isFileWriteCall(tool.call) && extractFileOutcomes(tool.call).length > 0 ? (
                  // A file change is a card of its own: what changed, by how
                  // much, with the real metrics — not raw arguments. When the
                  // outcome cannot be read the card renders nothing, so the call
                  // falls back to its own row: a step the runtime really made must
                  // never disappear from the timeline.
                  <FileWriteCard call={tool.call} t={t} />
                ) : (
                  <ToolStepRow
                    call={tool.call}
                    artifacts={artifacts}
                    contributedToolViews={contributedToolViews}
                    onOpenArtifact={onOpenArtifact}
                    stepNumber={(tool.index ?? 0) + 1}
                    workspacePath={workspacePath}
                  />
                )}
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
