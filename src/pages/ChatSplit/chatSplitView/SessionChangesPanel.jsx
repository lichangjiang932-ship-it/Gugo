import { useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff, X } from 'lucide-react'
import { countRecordedEditLines } from '../../../lib/sessionChanges.js'

const LINE_CLASS = Object.freeze({
  removed: 'text-danger',
  added: 'text-success',
})

function EditBlock({ edit }) {
  const lines = [
    ...edit.removed.map((line) => ({ sign: '-', line })),
    ...edit.added.map((line) => ({ sign: '+', line })),
  ]
  return (
    <div className="max-h-64 overflow-auto rounded-control border border-ink/10 bg-paper-2/40 p-1.5" data-testid="session-change-edit">
      {lines.map((entry, index) => (
        <pre
          key={`${entry.sign}:${index}`}
          data-sign={entry.sign}
          className={`whitespace-pre-wrap break-all font-mono text-xs leading-5 ${LINE_CLASS[entry.sign === '-' ? 'removed' : 'added']}`}
        >
          {`${entry.sign}${entry.line}` || ' '}
        </pre>
      ))}
    </div>
  )
}

function countsFor(file, edits) {
  if (file.reported) return { ...file.reported, reported: true }
  return { ...countRecordedEditLines(edits), reported: false }
}

/**
 * This conversation's change review.
 *
 * Answers one question — what did the agent actually do to the files — and
 * answers it from the tool calls, not from prose: the executor's per-file line
 * counts when it reported them, and otherwise the lines of the edits the agent
 * made, which are the same lines rendered below. A file a script wrote has no
 * recorded edit and says so rather than inventing one.
 *
 * Read-only on purpose: committing and pushing belong to the terminal and the
 * Git workbench, and this panel never becomes a second, quieter way to change a
 * repository.
 */
export default function SessionChangesPanel({ review, t }) {
  const [openKey, setOpenKey] = useState('')
  // Closed is the common case: the review is only computed while it is open.
  if (!review?.visible) return null
  const { changes, editIndex, close, openDiff: onOpenDiff } = review
  const files = changes?.files || []
  const totals = changes?.totals || { files: 0, additions: 0, deletions: 0 }

  return (
    <section
      aria-label={t('chat.changes.title')}
      data-testid="session-changes-panel"
      className="pointer-events-auto absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(420px,calc(100vw-3rem))] flex-col overflow-hidden rounded-card overlay-float"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-ink/10 pl-2.5 pr-1">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />
        <h2 className="shrink-0 truncate text-sm font-semibold text-ink">{t('chat.changes.title')}</h2>
        {totals.files > 0 && (
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-ink-fade" data-testid="session-changes-totals">
            {t('chat.changes.summary', { count: totals.files })}
            {totals.reportedFiles > 0 && (
              <>
                {' · '}
                <span className="font-mono text-accent">+{totals.additions}</span>
                {' '}
                <span className="font-mono text-danger">-{totals.deletions}</span>
              </>
            )}
          </span>
        )}
        <button
          type="button"
          onClick={close}
          aria-label={t('chat.changes.close')}
          title={t('chat.changes.close')}
          data-testid="session-changes-close"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" role="list">
        {files.length === 0 && (
          <p className="px-1 py-3 text-xs leading-5 text-ink-fade" data-testid="session-changes-empty">
            {t('chat.changes.empty')}
          </p>
        )}
        {files.map((file) => {
          const edits = editIndex?.get(file.key) || []
          const counts = countsFor(file, edits)
          const open = openKey === file.key
          return (
            <div key={file.key} role="listitem" className="mb-1 last:mb-0">
              <div className="flex w-full min-w-0 items-center rounded-control transition-colors hover:bg-[var(--color-row-hover)]">
                <button
                  type="button"
                  onClick={() => setOpenKey(open ? '' : file.key)}
                  aria-expanded={open}
                  data-testid="session-change-file-toggle"
                  aria-label={t('chat.changes.expand')}
                  title={t('chat.changes.expand')}
                  className="flex h-8 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:text-ink"
                >
                  {open
                    ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
                {/* The row is the review's entry point: it opens the file's diff in
                    the main area, where there is room to read it. The arrow beside
                    it is the shortcut for a glance without leaving the conversation. */}
                <button
                  type="button"
                  onClick={() => onOpenDiff?.(file, edits)}
                  data-testid="session-change-file"
                  data-path={file.displayPath}
                  aria-label={t('chat.changes.openDiff', { path: file.displayPath })}
                  title={t('chat.changes.openDiff', { path: file.displayPath })}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink" title={file.path}>{file.displayPath}</span>
                  <span className="shrink-0 font-mono text-xs text-accent">+{counts.additions}</span>
                  <span className="shrink-0 font-mono text-xs text-danger">−{counts.deletions}</span>
                </button>
              </div>
              {open && (
                <div className="pl-6 pr-1 pb-1.5">
                  {edits.length === 0
                    ? <p className="text-xs leading-5 text-ink-fade">{t('chat.changes.scriptOnly')}</p>
                    : edits.map((edit, index) => <EditBlock key={`${edit.toolName}:${index}`} edit={edit} />)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
