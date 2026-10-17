import { useState } from 'react'
import { FileDiff, MoreVertical, X } from 'lucide-react'
import CurrentFileChange from '../../../components/CurrentFileChange.jsx'
import DiffLines from '../../../components/DiffLines.jsx'
import { countRecordedEditLines } from '../../../lib/sessionChanges.js'
import { isCompositionEvent } from '../../../lib/compositionEvent.js'

function EditBlock({ edit, t }) {
  return <DiffLines edit={edit} t={t} wrap className="max-h-72" />
}

function countsFor(file, edits) {
  if (file.reported) return { ...file.reported, reported: true }
  return { ...countRecordedEditLines(edits), reported: false }
}

/**
 * This conversation's change review, laid out the way a review tool opens: one
 * changed file's diff in front, and the list of every changed file one press
 * away behind the ⋮ button. It answers what the agent did to the files from the
 * tool calls, not from prose — the executor's per-file line counts when it
 * reported them, and otherwise the lines of the edits the agent made. A file
 * with no recorded edit shows its current content, labelled as that, rather
 * than an invented diff.
 *
 * Read-only on purpose: committing and pushing belong to the terminal and the
 * Git workbench, and this panel never becomes a second, quieter way to change a
 * repository.
 */
export default function SessionChangesPanel({ review, t }) {
  const [treeOpen, setTreeOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState('')
  // Closed is the common case: the review is only computed while it is open.
  if (!review?.visible) return null
  const { changes, editIndex, close, openDiff: onOpenDiff } = review
  const files = changes?.files || []
  const selected = files.find((file) => file.key === selectedKey) || files[0] || null
  const edits = selected ? (editIndex?.get(selected.key) || []) : []
  const counts = selected ? countsFor(selected, edits) : null

  return (
    <section
      aria-label={t('chat.changes.title')}
      data-testid="session-changes-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || isCompositionEvent(event)) return
        event.preventDefault()
        close?.()
      }}
      // top-14 clears the 48px chat and workbench headers so the toggle that
      // closes this panel is never underneath it.
      className="pointer-events-auto absolute top-14 right-3 z-20 flex max-h-[calc(100%-4.25rem)] w-[min(460px,calc(100vw-3rem))] flex-col overflow-hidden rounded-card overlay-float"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-ink/10 pl-1 pr-1">
        <button
          type="button"
          onClick={() => setTreeOpen((open) => !open)}
          aria-expanded={treeOpen}
          aria-label={t('chat.changes.toggleTree')}
          title={t('chat.changes.toggleTree')}
          data-testid="session-changes-tree-toggle"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 ${treeOpen ? 'bg-ink/5 text-ink' : ''}`}
        >
          <MoreVertical className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" data-testid="session-changes-heading">
          {treeOpen || !selected ? t('chat.changes.title') : selected.displayPath}
        </h2>
        {counts && (
          <span className="shrink-0 font-mono text-xs" data-testid="session-changes-totals">
            <span className="text-success">+{counts.additions}</span>
            {' '}
            <span className="text-danger">−{counts.deletions}</span>
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {files.length === 0 && (
          <p className="px-1 py-3 text-xs leading-5 text-ink-fade" data-testid="session-changes-empty">
            {t('chat.changes.empty')}
          </p>
        )}

        {treeOpen && files.length > 0 && (
          <div role="list" data-testid="session-changes-tree">
            {files.map((file) => {
              const fileEdits = editIndex?.get(file.key) || []
              const fileCounts = countsFor(file, fileEdits)
              return (
                <button
                  key={file.key}
                  type="button"
                  role="listitem"
                  onClick={() => { setSelectedKey(file.key); setTreeOpen(false) }}
                  data-testid="session-change-file"
                  data-path={file.displayPath}
                  aria-label={t('chat.changes.openDiff', { path: file.displayPath })}
                  title={t('chat.changes.openDiff', { path: file.displayPath })}
                  className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-row-hover)]"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{file.displayPath}</span>
                  <span className="shrink-0 font-mono text-xs text-success">+{fileCounts.additions}</span>
                  <span className="shrink-0 font-mono text-xs text-danger">−{fileCounts.deletions}</span>
                </button>
              )
            })}
          </div>
        )}

        {!treeOpen && selected && (
          <div>
            {onOpenDiff && (
              <button
                type="button"
                onClick={() => onOpenDiff(selected, edits)}
                data-testid="session-change-open-main"
                aria-label={t('chat.changes.openDiff', { path: selected.displayPath })}
                title={t('chat.changes.openDiff', { path: selected.displayPath })}
                className="mb-1.5 w-full rounded-control px-2 py-1 text-left text-xs text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink"
              >
                {t('chat.changes.openDiff', { path: selected.displayPath })}
              </button>
            )}
            {edits.length === 0
              ? <CurrentFileChange file={selected} counts={counts} t={t} wrap className="max-h-72" />
              : edits.map((edit, index) => <EditBlock key={`${edit.toolName}:${index}`} edit={edit} t={t} />)}
          </div>
        )}
      </div>
    </section>
  )
}
