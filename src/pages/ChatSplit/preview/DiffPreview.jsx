import { FileDiff } from 'lucide-react'

const LINE_CLASS = Object.freeze({ removed: 'text-danger', added: 'text-success' })

function linesOf(edit) {
  return [
    ...(Array.isArray(edit?.removed) ? edit.removed : []).map((line) => ({ sign: '-', line })),
    ...(Array.isArray(edit?.added) ? edit.added : []).map((line) => ({ sign: '+', line })),
  ]
}

/**
 * The recorded diff of one file, as the main area shows it.
 *
 * The panel beside the conversation is the index; this is the reading surface the
 * index opens into. Both draw the same recorded edits — the lines the agent's own
 * tool calls reported — so the bigger view can never disagree with the summary
 * that opened it, and neither ever reads the working tree behind the reader's back.
 */
export default function DiffPreview({ preview = {}, t }) {
  const hunks = Array.isArray(preview.hunks) ? preview.hunks : []
  const path = String(preview.path || preview.filename || '').trim()
  return (
    <div data-testid="diff-preview" className="chat-diff-preview h-full min-h-0 overflow-auto px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <FileDiff className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink" title={path}>{path}</span>
        {preview.summary && <span className="shrink-0 font-mono text-xs text-ink-fade">{preview.summary}</span>}
      </div>
      {hunks.length === 0 ? (
        <p data-testid="diff-preview-empty" className="text-xs leading-5 text-ink-fade">{t('chat.changes.scriptOnly')}</p>
      ) : hunks.map((edit, hunkIndex) => (
        <section key={`${edit?.toolName || 'edit'}:${hunkIndex}`} className="mb-3 last:mb-0" data-testid="diff-preview-hunk">
          <p className="mb-1 font-mono text-xs text-ink-fade">{edit?.toolName || ''}</p>
          <div className="chat-diff-preview-lines overflow-x-auto rounded-control border border-ink/10 bg-paper-2/40 py-1">
            {linesOf(edit).map((entry, index) => (
              <pre
                key={`${entry.sign}:${index}`}
                data-sign={entry.sign}
                className={`min-w-max whitespace-pre px-3 font-mono text-xs leading-5 ${LINE_CLASS[entry.sign === '-' ? 'removed' : 'added']}`}
              >
                {`${entry.sign}${entry.line}` || ' '}
              </pre>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
