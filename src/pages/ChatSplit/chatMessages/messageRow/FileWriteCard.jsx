import { useState } from 'react'
import { ChevronDown, FilePenLine } from 'lucide-react'
import { extractFileOutcomes } from '../../../../../shared/agentStepMetadata.js'

/**
 * A file change as a card, not as prose: what was written, how much changed,
 * and the real metrics behind it — one line the reader can scan, opening onto
 * the detail (bytes, digest, tool result) only when asked.
 */
export function FileWriteCard({ call, t }) {
  const [open, setOpen] = useState(false)
  const outcomes = extractFileOutcomes(call)
  if (outcomes.length === 0) return null
  const primary = outcomes[0]
  // A patch may land several files; the head shows the count and the body
  // lists each one with its own metrics.
  const changeCount = outcomes.reduce((total, item) => total + (item.changed || 0), 0)
  const detailId = `file-write-detail-${String(primary.path).replace(/[^\w.-]+/gu, '-')}`
  return (
    <div className="chat-file-card" data-testid="file-write-card" data-status={call?.status || undefined}>
      <button
        type="button"
        className="chat-file-card-head"
        data-testid="file-write-card-toggle"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
      >
        <FilePenLine className="chat-file-card-icon" aria-hidden="true" />
        <span className="chat-file-card-title">{t('agentReport.fileWrote')}</span>
        <code className="chat-file-card-path" data-testid="file-write-card-path">
          {outcomes.length > 1 ? t('agentReport.fileMany', { count: outcomes.length }) : primary.path}
        </code>
        {changeCount > 0 && (
          <span className="chat-file-card-badge" data-testid="file-write-card-badge">+{changeCount}</span>
        )}
        <ChevronDown className={`chat-file-card-chevron ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="chat-file-card-body" id={detailId} data-testid="file-write-card-body">
          {outcomes.map((outcome) => (
            <div className="chat-file-card-row" key={outcome.path}>
              <code className="chat-file-card-path">{outcome.path}</code>
              {outcome.changed != null && (
                <span className="chat-file-card-meta" data-testid="file-write-metrics">
                  {t('agentReport.fileChanges', { count: outcome.changed })}
                </span>
              )}
              {outcome.bytes != null && (
                <span className="chat-file-card-meta">{t('agentReport.fileBytes', { count: outcome.bytes })}</span>
              )}
              {outcome.additions != null && (
                <span className="chat-file-card-meta">{t('agentReport.fileAdditions', { count: outcome.additions })}</span>
              )}
              {outcome.deletions != null && (
                <span className="chat-file-card-meta">{t('agentReport.fileDeletions', { count: outcome.deletions })}</span>
              )}
              {outcome.sha256 && (
                <span className="chat-file-card-meta chat-file-card-digest" title={outcome.sha256}>
                  sha256 {outcome.sha256.slice(0, 12)}…
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default FileWriteCard
